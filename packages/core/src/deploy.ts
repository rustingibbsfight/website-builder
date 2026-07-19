import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type DeployAdapterName = 'static' | 'vercel' | 'netlify' | 'cloudflare';

export const DEPLOY_ADAPTERS: readonly DeployAdapterName[] = ['static', 'vercel', 'netlify', 'cloudflare'];

export interface DeployOptions {
  /** For 'static': target directory to copy the built site into. */
  targetDir?: string;
  /** Provider project/site name. */
  projectName?: string;
  /** If false, only emit config + instructions without shelling out. */
  execute?: boolean;
}

export interface DeployResult {
  adapter: DeployAdapterName;
  status: 'deployed' | 'prepared';
  /** What happened / what to do next. */
  message: string;
  output?: string;
}

/**
 * Deploy a built dist directory. Provider adapters emit the provider config
 * into dist and shell out to the provider CLI when it's installed; otherwise
 * they return exact instructions (keeps everything workable offline).
 */
export function deployDist(distPath: string, adapter: DeployAdapterName, opts: DeployOptions = {}): DeployResult {
  if (!existsSync(join(distPath, 'index.html'))) {
    throw new Error(`no build found at ${distPath} — publish the site first`);
  }
  if (!DEPLOY_ADAPTERS.includes(adapter)) {
    // Guard against an unvalidated CLI string cast to DeployAdapterName — never
    // silently return undefined and report a phantom success.
    throw new Error(`unknown deploy adapter "${adapter}" — valid: ${DEPLOY_ADAPTERS.join(', ')}`);
  }
  switch (adapter) {
    case 'static': {
      if (!opts.targetDir) {
        return {
          adapter,
          status: 'prepared',
          message: `Static build ready at ${distPath}. Copy it to any static host (or pass targetDir to copy now).`,
        };
      }
      cpSync(distPath, opts.targetDir, { recursive: true });
      return { adapter, status: 'deployed', message: `Copied build to ${opts.targetDir}.` };
    }
    case 'vercel': {
      writeFileSync(
        join(distPath, 'vercel.json'),
        `${JSON.stringify({ cleanUrls: true, trailingSlash: true }, null, 2)}\n`,
      );
      return tryCli(adapter, distPath, 'vercel', ['deploy', '--prod', '--yes', '--cwd', distPath],
        `Run: npx vercel deploy --prod --cwd ${distPath}`);
    }
    case 'netlify': {
      writeFileSync(join(distPath, 'netlify.toml'), `[build]\n  publish = "."\n`);
      return tryCli(adapter, distPath, 'netlify', ['deploy', '--prod', '--dir', distPath],
        `Run: npx netlify-cli deploy --prod --dir ${distPath}`);
    }
    case 'cloudflare': {
      return tryCli(
        adapter,
        distPath,
        'wrangler',
        ['pages', 'deploy', distPath, ...(opts.projectName ? ['--project-name', opts.projectName] : [])],
        `Run: npx wrangler pages deploy ${distPath}${opts.projectName ? ` --project-name ${opts.projectName}` : ''}`,
      );
    }
  }
}

function tryCli(
  adapter: DeployAdapterName,
  distPath: string,
  bin: string,
  args: string[],
  instructions: string,
): DeployResult {
  const found = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  if (found.error || found.status !== 0) {
    return {
      adapter,
      status: 'prepared',
      message: `Build prepared at ${distPath} with ${adapter} config. The ${bin} CLI is not installed here — ${instructions}`,
    };
  }
  const run = spawnSync(bin, args, { encoding: 'utf8' });
  if (run.status === 0) {
    return {
      adapter,
      status: 'deployed',
      message: `Deployed via ${bin}.`,
      output: (run.stdout + run.stderr).slice(-2000),
    };
  }
  return {
    adapter,
    status: 'prepared',
    message: `${bin} exited with code ${run.status}. ${instructions}`,
    output: (run.stdout + run.stderr).slice(-2000),
  };
}
