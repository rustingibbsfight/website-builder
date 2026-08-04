import { projectNameFor } from './publish-target.js';

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
  /** Parallel blob uploads per commit. Default 6. */
  blobConcurrency?: number;
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

  private async gh<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T; message?: string }> {
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
    let data: T;
    try {
      data = (text ? JSON.parse(text) : {}) as T;
    } catch {
      // A proxy/error page (HTML, empty) must not crash the flow — surface it as a message.
      data = {} as T;
      return { status: res.status, data, message: text.slice(0, 300) };
    }
    // GitHub error bodies carry a human-readable `message` (and sometimes `errors`).
    const d = data as { message?: string; errors?: Array<{ message?: string }> };
    const message =
      d?.message != null
        ? [d.message, ...(d.errors ?? []).map((e) => e?.message).filter(Boolean)].join('; ')
        : undefined;
    return { status: res.status, data, message };
  }

  private async ensureRepo(repo: string): Promise<void> {
    const existing = await this.gh(`GET`, `/repos/${this.cfg.owner}/${repo}`);
    if (existing.status === 200) return;
    if (existing.status !== 404) {
      throw new Error(`github: checking repo ${this.cfg.owner}/${repo} failed (${existing.status})${existing.message ? `: ${existing.message}` : ''}`);
    }
    // Create under the authenticated user, or under an org if the owner differs.
    const me = await this.gh<{ login: string }>('GET', '/user');
    const isSelf = me.status === 200 && me.data.login?.toLowerCase() === this.cfg.owner.toLowerCase();
    const createPath = isSelf ? '/user/repos' : `/orgs/${this.cfg.owner}/repos`;
    const created = await this.gh('POST', createPath, {
      name: repo,
      private: this.cfg.private ?? true,
      auto_init: false,
      description: 'Version-controlled website — source + build, published by wb.',
    });
    if (created.status === 201) return;
    // 422 on create means the repo already exists (a concurrent deploy of the
    // same site raced us) — that's success, not failure. Confirm it's really there.
    if (created.status === 422) {
      const recheck = await this.gh('GET', `/repos/${this.cfg.owner}/${repo}`);
      if (recheck.status === 200) return;
    }
    throw new Error(`github: creating repo ${this.cfg.owner}/${repo} failed (${created.status})${created.message ? `: ${created.message}` : ''}`);
  }

  /**
   * Return the current tip commit of the branch, initializing an empty repo
   * first if needed. The Git Data API (blobs/trees/commits) rejects a repo that
   * has never had an initial commit (409 "Git Repository is empty"), so a fresh
   * repo is bootstrapped with one Contents-API write, which creates the default
   * branch. Every subsequent commit then has a real parent.
   */
  private async baseCommit(repo: string): Promise<string> {
    const owner = this.cfg.owner;
    const readTip = () =>
      this.gh<{ object?: { sha: string } }>('GET', `/repos/${owner}/${repo}/git/ref/heads/${this.branch}`);

    const ref = await readTip();
    if (ref.status === 200 && ref.data.object?.sha) return ref.data.object.sha;

    const init = await this.gh<{ commit?: { sha: string } }>(
      'PUT',
      `/repos/${owner}/${repo}/contents/.wb-init`,
      {
        message: 'Initialize repository',
        content: Buffer.from('Initialized by wb.\n').toString('base64'),
        branch: this.branch,
      },
    );
    if (init.data.commit?.sha) return init.data.commit.sha;

    // A concurrent deploy may have bootstrapped the repo between our ref read and
    // this PUT (422 "sha wasn't supplied" / already exists). Re-read the tip.
    const after = await readTip();
    if (after.status === 200 && after.data.object?.sha) return after.data.object.sha;
    throw new Error(`github: repository init failed (${init.status})${init.message ? `: ${init.message}` : ''}`);
  }

  async commitSite(input: {
    siteId: string;
    siteName: string;
    source: unknown;
    files: Map<string, string | Uint8Array>;
    message: string;
  }): Promise<VersionControlResult> {
    const repo = projectNameFor(input.siteName, input.siteId, this.cfg.repoPrefix ?? 'wb-site-');
    const owner = this.cfg.owner;
    await this.ensureRepo(repo);
    let parentSha = await this.baseCommit(repo);

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

    // Blobs, then a fresh tree (no base_tree → each commit is a clean snapshot;
    // deleted pages and the .wb-init placeholder don't linger).
    //
    // Uploaded with bounded concurrency, not one at a time. A site with a
    // handful of generated images is twenty round trips carrying a couple of
    // megabytes each, and serialising them put the whole commit within reach of
    // the API's 60s function ceiling — a limit nothing here could report
    // usefully, because the function is killed rather than answered.
    //
    // Order is preserved by writing into a pre-sized array rather than pushing:
    // the tree must list the paths the blobs were built from, and "whichever
    // upload finished first" is not that.
    const tree = new Array<{ path: string; mode: '100644'; type: 'blob'; sha: string }>(blobs.length);
    const limit = Math.min(this.cfg.blobConcurrency ?? 6, blobs.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: limit }, async () => {
        for (let i = next++; i < blobs.length; i = next++) {
          const b = blobs[i]!;
          const blob = await this.gh<{ sha: string }>('POST', `/repos/${owner}/${repo}/git/blobs`, {
            content: b.content,
            encoding: b.encoding,
          });
          // GitHub says *why* in `message` ("over the limit", a rate-limit note,
          // a permissions problem). Dropping it — as this did — leaves a bare
          // status code, which is how a one-line fix turns into an afternoon.
          if (!blob.data.sha) {
            throw new Error(
              `github: blob create failed for ${b.path} (${blob.status})${blob.message ? `: ${blob.message}` : ''}`,
            );
          }
          tree[i] = { path: b.path, mode: '100644', type: 'blob', sha: blob.data.sha };
        }
      }),
    );

    const treeRes = await this.gh<{ sha: string }>('POST', `/repos/${owner}/${repo}/git/trees`, { tree });
    if (!treeRes.data.sha) throw new Error(`github: tree create failed (${treeRes.status})${treeRes.message ? `: ${treeRes.message}` : ''}`);

    // Create the commit and advance the branch. If another deploy of the same
    // site advanced the branch between our tip-read and the PATCH, GitHub rejects
    // the fast-forward (422). Re-read the tip, re-parent the commit onto it, and
    // retry — the blobs and tree are immutable, so only the commit is remade.
    let lastMessage = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      const commit = await this.gh<{ sha: string; html_url: string }>('POST', `/repos/${owner}/${repo}/git/commits`, {
        message: input.message,
        tree: treeRes.data.sha,
        parents: [parentSha],
      });
      if (!commit.data.sha) throw new Error(`github: commit create failed (${commit.status})${commit.message ? `: ${commit.message}` : ''}`);

      const patched = await this.gh('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${this.branch}`, {
        sha: commit.data.sha,
        force: false,
      });
      if (patched.status < 300) {
        return {
          provider: 'github',
          repo: `${owner}/${repo}`,
          repoUrl: `https://github.com/${owner}/${repo}`,
          commitSha: commit.data.sha,
          commitUrl: commit.data.html_url ?? `https://github.com/${owner}/${repo}/commit/${commit.data.sha}`,
        };
      }
      lastMessage = `${patched.status}${patched.message ? `: ${patched.message}` : ''}`;
      // Non-fast-forward / conflict → refresh the parent and try again.
      if (patched.status === 422 || patched.status === 409) {
        const tip = await this.gh<{ object?: { sha: string } }>('GET', `/repos/${owner}/${repo}/git/ref/heads/${this.branch}`);
        if (tip.status === 200 && tip.data.object?.sha) {
          parentSha = tip.data.object.sha;
          continue;
        }
      }
      break;
    }
    throw new Error(`github: updating branch failed (${lastMessage})`);
  }
}

function readme(siteName: string, siteId: string): string {
  return `# ${siteName}

Version-controlled website built with wb. Each commit is a published snapshot.

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
