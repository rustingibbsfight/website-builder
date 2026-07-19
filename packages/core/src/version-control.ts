import { slugifyProject } from './publish-target.js';

/**
 * Version control for published sites: on each deploy, commit the site's source
 * (the editable JSON) and its rendered build to a per-site repo, so every
 * publish is a diffable, restorable commit. Uses provider HTTP APIs only, so it
 * works from serverless with no git binary.
 */
export interface VersionControl {
  readonly name: string;
  commitSite(input: {
    siteId: string;
    siteName: string;
    /** Editable source of truth (site + pages) — restorable. */
    source: unknown;
    /** Rendered static build (path → bytes). */
    files: Map<string, string | Uint8Array>;
    message: string;
  }): Promise<VersionControlResult>;
}

export interface VersionControlResult {
  provider: string;
  repo: string;
  repoUrl: string;
  commitSha: string;
  commitUrl: string;
}

export interface GitHubVersionControlConfig {
  token: string;
  /** GitHub user or org that owns the site repos. */
  owner: string;
  /** Repo name prefix (default "wb-site-"). */
  repoPrefix?: string;
  branch?: string;
  /** Create new repos as private (default true). */
  private?: boolean;
  fetchFn?: typeof fetch;
}

interface GhBlob {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
}

export class GitHubVersionControl implements VersionControl {
  readonly name = 'github';
  private fetchFn: typeof fetch;
  private branch: string;

  constructor(private cfg: GitHubVersionControlConfig) {
    this.fetchFn = cfg.fetchFn ?? fetch;
    this.branch = cfg.branch ?? 'main';
  }

  private async gh<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const res = await this.fetchFn(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.cfg.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'wb-website-builder',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const data = (text ? JSON.parse(text) : {}) as T;
    return { status: res.status, data };
  }

  private async ensureRepo(repo: string): Promise<void> {
    const existing = await this.gh(`GET`, `/repos/${this.cfg.owner}/${repo}`);
    if (existing.status === 200) return;
    if (existing.status !== 404) {
      throw new Error(`github: checking repo failed (${existing.status})`);
    }
    // Determine whether the owner is the authenticated user or an org.
    const me = await this.gh<{ login: string }>('GET', '/user');
    const isSelf = me.status === 200 && me.data.login?.toLowerCase() === this.cfg.owner.toLowerCase();
    const createPath = isSelf ? '/user/repos' : `/orgs/${this.cfg.owner}/repos`;
    const created = await this.gh(createPath.startsWith('/user') ? 'POST' : 'POST', createPath, {
      name: repo,
      private: this.cfg.private ?? true,
      auto_init: false,
      description: 'Version-controlled website — source + build, published by wb.',
    });
    if (created.status !== 201) {
      const msg = (created.data as { message?: string }).message ?? created.status;
      throw new Error(`github: creating repo ${this.cfg.owner}/${repo} failed: ${msg}`);
    }
  }

  async commitSite(input: {
    siteId: string;
    siteName: string;
    source: unknown;
    files: Map<string, string | Uint8Array>;
    message: string;
  }): Promise<VersionControlResult> {
    const repo = slugifyProject(input.siteName, this.cfg.repoPrefix ?? 'wb-site-');
    const owner = this.cfg.owner;
    await this.ensureRepo(repo);

    // The commit is a full snapshot: source at the root, build under dist/.
    const blobs: GhBlob[] = [
      { path: 'site.json', content: `${JSON.stringify(input.source, null, 2)}\n`, encoding: 'utf-8' },
      { path: 'README.md', content: readme(input.siteName, input.siteId), encoding: 'utf-8' },
    ];
    for (const [path, data] of input.files) {
      blobs.push(
        typeof data === 'string'
          ? { path: `dist/${path}`, content: data, encoding: 'utf-8' }
          : { path: `dist/${path}`, content: Buffer.from(data).toString('base64'), encoding: 'base64' },
      );
    }

    // Is there an existing commit on the branch?
    const ref = await this.gh<{ object?: { sha: string } }>('GET', `/repos/${owner}/${repo}/git/ref/heads/${this.branch}`);
    const parentSha = ref.status === 200 ? ref.data.object?.sha : undefined;

    // Create blobs, then a fresh tree (no base_tree → each commit is a clean
    // snapshot; deleted pages don't linger).
    const tree: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string }> = [];
    for (const b of blobs) {
      const blob = await this.gh<{ sha: string }>('POST', `/repos/${owner}/${repo}/git/blobs`, {
        content: b.content,
        encoding: b.encoding,
      });
      if (!blob.data.sha) throw new Error(`github: blob create failed for ${b.path} (${blob.status})`);
      tree.push({ path: b.path, mode: '100644', type: 'blob', sha: blob.data.sha });
    }

    const treeRes = await this.gh<{ sha: string }>('POST', `/repos/${owner}/${repo}/git/trees`, { tree });
    if (!treeRes.data.sha) throw new Error(`github: tree create failed (${treeRes.status})`);

    const commit = await this.gh<{ sha: string; html_url: string }>('POST', `/repos/${owner}/${repo}/git/commits`, {
      message: input.message,
      tree: treeRes.data.sha,
      parents: parentSha ? [parentSha] : [],
    });
    if (!commit.data.sha) throw new Error(`github: commit create failed (${commit.status})`);

    // Point the branch at the new commit (create the ref on first push).
    if (parentSha) {
      await this.gh('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${this.branch}`, {
        sha: commit.data.sha,
        force: false,
      });
    } else {
      const createRef = await this.gh('POST', `/repos/${owner}/${repo}/git/refs`, {
        ref: `refs/heads/${this.branch}`,
        sha: commit.data.sha,
      });
      if (createRef.status !== 201) {
        // Repo may have been auto-initialized; fall back to updating the ref.
        await this.gh('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${this.branch}`, { sha: commit.data.sha, force: true });
      }
    }

    return {
      provider: 'github',
      repo: `${owner}/${repo}`,
      repoUrl: `https://github.com/${owner}/${repo}`,
      commitSha: commit.data.sha,
      commitUrl: commit.data.html_url ?? `https://github.com/${owner}/${repo}/commit/${commit.data.sha}`,
    };
  }
}

function readme(siteName: string, siteId: string): string {
  return `# ${siteName}

Version-controlled website built with [wb](https://github.com/). Each commit is a
published snapshot.

- \`site.json\` — the editable source (theme, pages, component trees). Restorable.
- \`dist/\` — the rendered static build for this commit.

Site id: \`${siteId}\`
`;
}

/**
 * Select version control from environment.
 *   WB_VCS=github → GitHub (WB_GITHUB_TOKEN, WB_GITHUB_OWNER, optional
 *                   WB_GITHUB_REPO_PREFIX, WB_GITHUB_PRIVATE=false).
 * Unset → null (no version control).
 */
export function createVersionControl(env: NodeJS.ProcessEnv = process.env): VersionControl | null {
  if ((env.WB_VCS ?? '').toLowerCase() === 'github') {
    if (!env.WB_GITHUB_TOKEN || !env.WB_GITHUB_OWNER) {
      throw new Error('WB_VCS=github requires WB_GITHUB_TOKEN and WB_GITHUB_OWNER');
    }
    return new GitHubVersionControl({
      token: env.WB_GITHUB_TOKEN,
      owner: env.WB_GITHUB_OWNER,
      ...(env.WB_GITHUB_REPO_PREFIX ? { repoPrefix: env.WB_GITHUB_REPO_PREFIX } : {}),
      ...(env.WB_GITHUB_PRIVATE ? { private: env.WB_GITHUB_PRIVATE.toLowerCase() !== 'false' } : {}),
    });
  }
  return null;
}
