import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WbCore } from './core.js';
import { createVersionControl, GitHubVersionControl, type VersionControl } from './version-control.js';

/** A scripted GitHub API — record calls, respond per endpoint. */
function fakeGitHub(opts: { repoExists?: boolean } = {}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  // The branch ref exists once the repo has been initialized (Contents PUT).
  let refExists = opts.repoExists ?? false;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, path: u.pathname, body });
    const json = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

    if (u.pathname.match(/^\/repos\/[^/]+\/[^/]+$/) && method === 'GET') {
      return opts.repoExists ? json(200, { name: 'repo' }) : json(404, { message: 'Not Found' });
    }
    if (u.pathname === '/user' && method === 'GET') return json(200, { login: 'clinicowner' });
    if (u.pathname === '/user/repos' && method === 'POST') return json(201, { name: body.name });
    if (u.pathname.match(/\/git\/ref\/heads\//) && method === 'GET') {
      return refExists ? json(200, { object: { sha: 'parent_1' } }) : json(404, { message: 'Not Found' });
    }
    // Contents-API bootstrap of an empty repo → creates the default branch.
    if (u.pathname.endsWith('/contents/.wb-init') && method === 'PUT') {
      refExists = true;
      return json(201, { commit: { sha: 'init_1' } });
    }
    if (u.pathname.endsWith('/git/blobs')) return json(201, { sha: `blob_${calls.length}` });
    if (u.pathname.endsWith('/git/trees')) return json(201, { sha: 'tree_1' });
    if (u.pathname.endsWith('/git/commits')) return json(201, { sha: 'commit_1', html_url: 'https://github.com/clinicowner/repo/commit/commit_1' });
    if (u.pathname.match(/\/git\/refs\/heads\//) && method === 'PATCH') return json(200, {});
    return json(500, { message: `unexpected ${method} ${u.pathname}` });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

describe('GitHubVersionControl', () => {
  it('creates the repo then commits source + build via the git data API (empty repo)', async () => {
    const gh = fakeGitHub({ repoExists: false });
    const vc = new GitHubVersionControl({ token: 't', owner: 'clinicowner', fetchFn: gh.fetchFn });
    const result = await vc.commitSite({
      siteId: 's1',
      siteName: 'Breakthrough Medical',
      source: { site: { id: 's1' }, pages: [] },
      files: new Map<string, string | Uint8Array>([
        ['index.html', '<h1>Hi</h1>'],
        ['assets/logo.svg', new Uint8Array([60, 115, 118, 103, 62])],
      ]),
      message: 'Deploy',
    });

    const paths = gh.calls.map((c) => `${c.method} ${c.path}`);
    // repo check → 404, then create under the authed user (name discriminated by siteId)
    expect(paths).toContain('GET /repos/clinicowner/wb-site-breakthrough-medical-s1');
    expect(paths).toContain('POST /user/repos');
    // empty repo → bootstrap via Contents API before the git data API
    expect(paths).toContain('PUT /repos/clinicowner/wb-site-breakthrough-medical-s1/contents/.wb-init');
    // git data API sequence
    expect(paths.filter((p) => p.endsWith('/git/blobs')).length).toBe(4); // site.json, README, 2 dist files
    expect(paths).toContain('POST /repos/clinicowner/wb-site-breakthrough-medical-s1/git/trees');
    expect(paths).toContain('POST /repos/clinicowner/wb-site-breakthrough-medical-s1/git/commits');
    // branch updated (never a bare ref-create — bootstrap already made it)
    expect(paths).toContain('PATCH /repos/clinicowner/wb-site-breakthrough-medical-s1/git/refs/heads/main');

    // the commit's tree includes source at root and build under dist/
    const treeCall = gh.calls.find((c) => c.path.endsWith('/git/trees'))!;
    const treePaths = (treeCall.body as { tree: Array<{ path: string }> }).tree.map((t) => t.path);
    expect(treePaths).toContain('site.json');
    expect(treePaths).toContain('README.md');
    expect(treePaths).toContain('dist/index.html');
    expect(treePaths).toContain('dist/assets/logo.svg');
    // binary asset committed as base64
    const svgBlob = gh.calls.find((c) => c.path.endsWith('/git/blobs') && (c.body as { encoding: string }).encoding === 'base64');
    expect(svgBlob).toBeTruthy();

    // first commit's parent is the bootstrap init commit
    const commitCall = gh.calls.find((c) => c.path.endsWith('/git/commits'))!;
    expect((commitCall.body as { parents: string[] }).parents).toEqual(['init_1']);

    expect(result.repo).toBe('clinicowner/wb-site-breakthrough-medical-s1');
    expect(result.commitUrl).toContain('commit_1');
  });

  it('retries the commit onto a fresh parent when the branch moved (422 non-fast-forward)', async () => {
    // A racing deploy advances the branch: the first PATCH is a non-fast-forward
    // 422, and the re-read tip returns a new parent. The retry must succeed.
    let patchCount = 0;
    let commitCount = 0;
    const commitParents: unknown[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      const json = (status: number, data: unknown) =>
        new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
      if (u.pathname.match(/^\/repos\/[^/]+\/[^/]+$/) && method === 'GET') return json(200, { name: 'repo' });
      if (u.pathname.match(/\/git\/ref\/heads\//) && method === 'GET') {
        // First tip read → parent_1; after the failed PATCH → parent_2.
        return json(200, { object: { sha: patchCount === 0 ? 'parent_1' : 'parent_2' } });
      }
      if (u.pathname.endsWith('/git/blobs')) return json(201, { sha: 'blob' });
      if (u.pathname.endsWith('/git/trees')) return json(201, { sha: 'tree_1' });
      if (u.pathname.endsWith('/git/commits')) {
        commitCount++;
        commitParents.push(body.parents);
        return json(201, { sha: `commit_${commitCount}`, html_url: `https://github.com/o/r/commit/commit_${commitCount}` });
      }
      if (u.pathname.match(/\/git\/refs\/heads\//) && method === 'PATCH') {
        patchCount++;
        return patchCount === 1 ? json(422, { message: 'Update is not a fast forward' }) : json(200, {});
      }
      return json(500, { message: `unexpected ${method} ${u.pathname}` });
    }) as unknown as typeof fetch;

    const vc = new GitHubVersionControl({ token: 't', owner: 'o', fetchFn });
    const result = await vc.commitSite({ siteId: 's', siteName: 'X', source: {}, files: new Map([['index.html', 'a']]), message: 'm' });
    expect(patchCount).toBe(2); // failed once, then succeeded
    expect(commitCount).toBe(2); // commit re-created onto the fresh parent
    expect(commitParents).toEqual([['parent_1'], ['parent_2']]);
    expect(result.commitSha).toBe('commit_2');
  });

  it('surfaces the GitHub error message when a branch update ultimately fails', async () => {
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      const method = init?.method ?? 'GET';
      const json = (status: number, data: unknown) =>
        new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
      if (u.pathname.match(/^\/repos\/[^/]+\/[^/]+$/) && method === 'GET') return json(200, { name: 'repo' });
      if (u.pathname.match(/\/git\/ref\/heads\//) && method === 'GET') return json(200, { object: { sha: 'p' } });
      if (u.pathname.endsWith('/git/blobs')) return json(201, { sha: 'b' });
      if (u.pathname.endsWith('/git/trees')) return json(201, { sha: 't' });
      if (u.pathname.endsWith('/git/commits')) return json(201, { sha: 'c', html_url: 'h' });
      if (u.pathname.match(/\/git\/refs\/heads\//) && method === 'PATCH') return json(403, { message: 'Resource not accessible' });
      return json(500, { message: 'unexpected' });
    }) as unknown as typeof fetch;
    const vc = new GitHubVersionControl({ token: 't', owner: 'o', fetchFn });
    await expect(
      vc.commitSite({ siteId: 's', siteName: 'X', source: {}, files: new Map([['index.html', 'a']]), message: 'm' }),
    ).rejects.toThrow(/403.*Resource not accessible/);
  });

  it('appends a commit onto an existing repo (parent + patch ref)', async () => {
    const gh = fakeGitHub({ repoExists: true });
    // existing repo → ref exists
    const vc = new GitHubVersionControl({ token: 't', owner: 'clinicowner', fetchFn: gh.fetchFn });
    // seed ref as existing by making the GET ref return 200 — fakeGitHub starts refExists=false,
    // so simulate second publish by pre-creating: run once, then again.
    await vc.commitSite({ siteId: 's', siteName: 'X', source: {}, files: new Map([['index.html', 'a']]), message: 'first' });
    gh.calls.length = 0;
    await vc.commitSite({ siteId: 's', siteName: 'X', source: {}, files: new Map([['index.html', 'b']]), message: 'second' });
    const paths = gh.calls.map((c) => `${c.method} ${c.path}`);
    expect(paths.some((p) => p.startsWith('PATCH') && p.includes('/git/refs/heads/'))).toBe(true);
    const commitCall = gh.calls.find((c) => c.path.endsWith('/git/commits'))!;
    expect((commitCall.body as { parents: string[] }).parents).toEqual(['parent_1']);
  });
});

describe('createVersionControl selection', () => {
  it('returns null when unset and validates required vars', () => {
    expect(createVersionControl({})).toBeNull();
    expect(() => createVersionControl({ WB_VCS: 'github' })).toThrow(/WB_GITHUB_TOKEN/);
    expect(
      createVersionControl({ WB_VCS: 'github', WB_GITHUB_TOKEN: 't', WB_GITHUB_OWNER: 'o' }),
    ).toBeInstanceOf(GitHubVersionControl);
  });
});

describe('WbCore deploy + version control', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wb-vcs-'));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  const fakeTarget = { name: 'fake', deploy: async () => ({ url: 'https://live.example.com' }) };

  it('commits source + build on deploy and reports repo/commit', async () => {
    const committed: unknown[] = [];
    const vc: VersionControl = {
      name: 'fake-vc',
      commitSite: async (input) => {
        committed.push(input);
        return {
          provider: 'github',
          repo: 'owner/wb-site-deploy-clinic',
          repoUrl: 'https://github.com/owner/wb-site-deploy-clinic',
          commitSha: 'abc',
          commitUrl: 'https://github.com/owner/wb-site-deploy-clinic/commit/abc',
        };
      },
    };
    const core = await WbCore.create({ dataDir, publishTarget: fakeTarget, versionControl: vc });
    const site = await core.createSiteFromTemplate('breakthrough-medical', 'Deploy Clinic');
    const result = await core.deploySite(site.id);

    expect(result.url).toBe('https://live.example.com');
    expect(result.versionControl?.repoUrl).toContain('wb-site-deploy-clinic');
    // the commit carried the full source (site + pages) and the built files
    const input = committed[0] as { source: { pages: unknown[] }; files: Map<string, unknown> };
    expect(input.source.pages).toHaveLength(4);
    expect(input.files.has('index.html')).toBe(true);
    expect([...input.files.keys()].some((k) => k.startsWith('assets/'))).toBe(true);
    core.close();
  });

  it('does not fail a live deploy when version control errors', async () => {
    const vc: VersionControl = {
      name: 'flaky',
      commitSite: async () => {
        throw new Error('github down');
      },
    };
    const core = await WbCore.create({ dataDir, publishTarget: fakeTarget, versionControl: vc });
    const site = await core.createSite('Resilient');
    await core.addPage(site.id, '', 'Home').catch(() => {}); // home already exists; ignore
    const result = await core.deploySite(site.id);
    expect(result.url).toBe('https://live.example.com');
    expect(result.versionControlError).toContain('github down');
    expect(result.versionControl).toBeUndefined();
    core.close();
  });

  it('commitSiteToVcs errors helpfully when unconfigured', async () => {
    const core = await WbCore.create({ dataDir, publishTarget: fakeTarget, versionControl: null });
    const site = await core.createSite('NoVcs');
    await expect(core.commitSiteToVcs(site.id)).rejects.toThrow(/WB_VCS=github/);
    core.close();
  });
});
