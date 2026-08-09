import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WbCore } from './core.js';
import {
  createVersionControl,
  encodeRefPath,
  GitHubVersionControl,
  type VersionControl,
} from './version-control.js';

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
    // The org path. Absent from this fake until it was noticed that every test
    // passed `clinicowner` as the owner — the same login `/user` answers — so
    // `isSelf` was true in every run and the org branch had never been reached.
    // A fake that cannot answer a request the code makes hides that branch as
    // completely as no test at all.
    if (u.pathname.match(/^\/orgs\/[^/]+\/repos$/) && method === 'POST') {
      return json(201, { name: body.name });
    }
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
  it('keeps tree entries aligned with their blobs when uploads finish out of order', async () => {
    // Uploads run concurrently, so the first blob to come back is not the first
    // file. A tree built by pushing whatever finished would attach the wrong
    // sha to a path — a commit that looks fine and has the images swapped.
    const shaFor = new Map<string, string>();
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });

      if (u.pathname.match(/^\/repos\/[^/]+\/[^/]+$/) && method === 'GET') return json(200, { name: 'r' });
      if (u.pathname.match(/\/git\/ref\/heads\//)) return json(200, { object: { sha: 'p1' } });
      if (u.pathname.endsWith('/git/blobs')) {
        const sha = `blob_of_${Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8')}`;
        shaFor.set(sha, sha);
        // Later files answer sooner, so completion order is the reverse of input.
        await new Promise((r) => setTimeout(r, Math.max(0, 30 - shaFor.size * 5)));
        return json(201, { sha });
      }
      if (u.pathname.endsWith('/git/trees')) return json(201, { sha: 'tree_1' });
      if (u.pathname.endsWith('/git/commits')) return json(201, { sha: 'c1', html_url: 'https://gh/c1' });
      if (u.pathname.match(/\/git\/refs\/heads\//) && method === 'PATCH') return json(200, {});
      return json(500, { message: 'unexpected' });
    }) as unknown as typeof fetch;

    let treeBody: { tree: Array<{ path: string; sha: string }> } | undefined;
    const spy = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/git/trees')) treeBody = JSON.parse(init!.body as string);
      return fetchFn(url, init);
    }) as unknown as typeof fetch;

    const vc = new GitHubVersionControl({ token: 't', owner: 'o', fetchFn: spy });
    const files = new Map<string, string | Uint8Array>([
      ['a.html', 'AAA'],
      ['b.html', 'BBB'],
      ['c.html', 'CCC'],
      ['d.html', 'DDD'],
    ]);
    await vc.commitSite({ siteId: 's', siteName: 'X', source: {}, files, message: 'm' });

    for (const [path, content] of files) {
      const entry = treeBody!.tree.find((t) => t.path === `dist/${path}`)!;
      expect(entry.sha, path).toBe(`blob_of_${content}`);
    }
  });

  it("reports GitHub's reason when a blob is rejected, not just a status code", async () => {
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      const method = init?.method ?? 'GET';
      const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
      if (u.pathname.match(/^\/repos\/[^/]+\/[^/]+$/) && method === 'GET') return json(200, { name: 'r' });
      if (u.pathname.match(/\/git\/ref\/heads\//)) return json(200, { object: { sha: 'p1' } });
      if (u.pathname.endsWith('/git/blobs')) return json(422, { message: 'blob is too large' });
      return json(500, { message: 'unexpected' });
    }) as unknown as typeof fetch;

    const vc = new GitHubVersionControl({ token: 't', owner: 'o', fetchFn });
    await expect(
      vc.commitSite({ siteId: 's', siteName: 'X', source: {}, files: new Map([['big.png', 'x']]), message: 'm' }),
    ).rejects.toThrow(/blob is too large/);
  });

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

  it('creates under the org when the owner is not the authenticated user', async () => {
    /**
     * The fake has always answered `/user` with the same login the tests pass
     * as the owner, so `isSelf` was true in every run and `/orgs/.../repos` had
     * never been called. GitHub rejects `POST /user/repos` for a repo that
     * belongs to an org, so an inverted check makes version control work for
     * personal accounts and fail on the first deploy for everyone else.
     *
     * The comparison is case-insensitive on both sides, and that matters here
     * rather than being tidiness: GitHub preserves the case somebody typed, so
     * an owner configured as `ClinicOwner` against a login of `clinicowner` is
     * the same account and must not be treated as an org.
     */
    const orgRun = fakeGitHub({ repoExists: false });
    await new GitHubVersionControl({
      token: 't',
      owner: 'some-org',
      fetchFn: orgRun.fetchFn,
    }).commitSite({
      siteId: 's1',
      siteName: 'Site',
      source: {},
      files: new Map<string, string | Uint8Array>([['index.html', 'x']]),
      message: 'Deploy',
    });
    const orgPaths = orgRun.calls.map((c) => `${c.method} ${c.path}`);
    expect(orgPaths).toContain('POST /orgs/some-org/repos');
    expect(orgPaths).not.toContain('POST /user/repos');

    const selfRun = fakeGitHub({ repoExists: false });
    await new GitHubVersionControl({
      token: 't',
      owner: 'ClinicOwner',
      fetchFn: selfRun.fetchFn,
    }).commitSite({
      siteId: 's1',
      siteName: 'Site',
      source: {},
      files: new Map<string, string | Uint8Array>([['index.html', 'x']]),
      message: 'Deploy',
    });
    const selfPaths = selfRun.calls.map((c) => `${c.method} ${c.path}`);
    expect(selfPaths).toContain('POST /user/repos');
    expect(selfPaths.some((p) => p.startsWith('POST /orgs/'))).toBe(false);
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

  it('refuses a half-configured github, whichever half is missing', () => {
    /**
     * `||`, and the `&&` version only throws when *both* are absent — so a
     * deployment with a token and no owner builds a client that addresses
     * `/repos/undefined/...` and fails on the first deploy, at the provider,
     * where the message is a 404 rather than the name of the variable to set.
     * A refusal at construction says which one.
     */
    expect(() => createVersionControl({ WB_VCS: 'github', WB_GITHUB_TOKEN: 't' })).toThrow(
      /WB_GITHUB_OWNER/,
    );
    expect(() => createVersionControl({ WB_VCS: 'github', WB_GITHUB_OWNER: 'o' })).toThrow(
      /WB_GITHUB_TOKEN/,
    );
  });

  it('reads the privacy flag as an opt-out, not as a boolean', () => {
    /**
     * Private is the default and `WB_GITHUB_PRIVATE` only exists to turn it
     * off, so **only the literal `false` is public** — anything else set is
     * somebody expressing an intent this cannot parse, and guessing wrong
     * publishes a site's whole source. Unset leaves the default alone rather
     * than writing `true`, so the two are not the same thing.
     */
    const privacyOf = (value?: string) =>
      (
        createVersionControl({
          WB_VCS: 'github',
          WB_GITHUB_TOKEN: 't',
          WB_GITHUB_OWNER: 'o',
          ...(value === undefined ? {} : { WB_GITHUB_PRIVATE: value }),
        }) as unknown as { cfg: { private?: boolean } }
      ).cfg.private;

    expect(privacyOf('false')).toBe(false);
    expect(privacyOf('FALSE')).toBe(false);
    expect(privacyOf('true')).toBe(true);
    expect(privacyOf('yes')).toBe(true);
    expect(privacyOf(undefined)).toBeUndefined();
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

describe('the branch name in a URL path (#50)', () => {
  /**
   * The branch is configuration, not a constant, and it went into an API path
   * raw. A `?` starts a query string, a `#` truncates the path at a fragment,
   * and `..` walks to a different endpoint — against a token that can write to
   * the repository.
   */
  it('encodes a character that would change which endpoint is addressed', () => {
    expect(encodeRefPath('main?x=1')).toBe('main%3Fx%3D1');
    expect(encodeRefPath('main#frag')).toBe('main%23frag');
    expect(encodeRefPath('..')).toBe('..');
    expect(encodeRefPath('a b')).toBe('a%20b');
  });

  /**
   * And the reason this is per segment rather than over the whole string.
   * `encodeURIComponent('feat/x')` is `feat%2Fx`; GitHub's refs API takes a
   * real slash, because refs are hierarchical and `feat/x` is an ordinary
   * branch. Encoding the lot would replace an injection with a feature nobody
   * could use — the shape of fix that gets reverted by somebody who only sees
   * the breakage.
   */
  it('leaves a hierarchical ref working', () => {
    expect(encodeRefPath('release/2026-08')).toBe('release/2026-08');
    expect(encodeRefPath('feat/a b')).toBe('feat/a%20b');
  });

  it('reaches the ref this branch actually names', async () => {
    const gh = fakeGitHub({ repoExists: true });
    const vcs = new GitHubVersionControl({
      owner: 'clinicowner',
      token: 't',
      branch: 'release/2026-08',
      fetchFn: gh.fetchFn,
    });
    await vcs.commitSite({
      siteId: 'site_1',
      siteName: 'Clinic',
      source: { pages: [] },
      files: new Map([['index.html', '<p>hi</p>']]),
      message: 'x',
    });
    const refCalls = gh.calls.filter((call) => call.path.includes('/git/ref'));
    expect(refCalls.length).toBeGreaterThan(0);
    for (const call of refCalls) expect(call.path).toContain('heads/release/2026-08');
  });

  /**
   * The wiring, not the function.
   *
   * A hierarchical branch is unchanged by encoding, so the test above passes
   * whether or not `encodeRefPath` is called at all — found by deleting the
   * call and watching everything stay green. This uses a branch the encoding
   * actually changes, so the assertion is about the request that went out.
   */
  it('encodes it on the way into the request, not only in the helper', async () => {
    const gh = fakeGitHub({ repoExists: true });
    const vcs = new GitHubVersionControl({
      owner: 'clinicowner',
      token: 't',
      branch: 'main?ref=other',
      fetchFn: gh.fetchFn,
    });
    await vcs.commitSite({
      siteId: 'site_1',
      siteName: 'Clinic',
      source: { pages: [] },
      files: new Map([['index.html', '<p>hi</p>']]),
      message: 'x',
    });
    const refCalls = gh.calls.filter((call) => call.path.includes('/git/ref'));
    expect(refCalls.length).toBeGreaterThan(0);
    for (const call of refCalls) {
      expect(call.path, 'the ? survived into the path').not.toContain('?');
      expect(call.path).toContain('main%3Fref%3Dother');
    }
  });
});
