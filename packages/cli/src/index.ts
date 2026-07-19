#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WbCore, deployDist, type DeployAdapterName } from '@wb/core';
import { Command } from 'commander';
import { serveStatic } from './serve-static.js';

const dataDir = process.env.WB_DATA_DIR ?? resolve(process.cwd(), 'data');

function core(): Promise<WbCore> {
  return WbCore.create({
    dataDir,
    ...(process.env.WB_DB_URL ? { dbUrl: process.env.WB_DB_URL } : {}),
    ...(process.env.WB_DB_TOKEN ? { dbToken: process.env.WB_DB_TOKEN } : {}),
  });
}

function out(value: unknown): void {
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function fail(err: unknown): never {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const program = new Command();
program
  .name('wb')
  .description('API-first website builder — build responsive sites from the CLI, REST API, or MCP')
  .version('0.1.0');

program
  .command('create')
  .description('Create a site (optionally from a template with brand overrides)')
  .argument('<name>', 'site name / brand name')
  .option('-t, --template <template>', 'template to instantiate (see `wb templates`)')
  .option('--brand-primary <hex>', 'primary brand color')
  .option('--brand-secondary <hex>', 'secondary brand color')
  .option('--brand-accent <hex>', 'accent brand color')
  .option('--font-heading <stack>', 'heading font stack name')
  .option('--font-body <stack>', 'body font stack name')
  .option('--logo-url <url>', 'external logo URL')
  .option('--base-url <url>', 'canonical base URL for sitemap/SEO')
  .action(async (name: string, opts: Record<string, string | undefined>) => {
    const c = await core();
    try {
      const brand = {
        ...(opts.brandPrimary || opts.brandSecondary || opts.brandAccent
          ? {
              colors: {
                ...(opts.brandPrimary ? { primary: opts.brandPrimary } : {}),
                ...(opts.brandSecondary ? { secondary: opts.brandSecondary } : {}),
                ...(opts.brandAccent ? { accent: opts.brandAccent } : {}),
              },
            }
          : {}),
        ...(opts.fontHeading || opts.fontBody
          ? {
              fonts: {
                ...(opts.fontHeading ? { heading: opts.fontHeading } : {}),
                ...(opts.fontBody ? { body: opts.fontBody } : {}),
              },
            }
          : {}),
        ...(opts.logoUrl ? { logoUrl: opts.logoUrl } : {}),
        ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
      };
      const site = opts.template
        ? await c.createSiteFromTemplate(opts.template, name, brand as never)
        : await c.createSite(name);
      const pages = await c.listPages(site.id);
      out({
        siteId: site.id,
        name: site.name,
        pages: pages.map((p) => ({ id: p.id, slug: p.slug || '(home)', title: p.title })),
        next: `wb build ${site.id}   # render static site`,
      });
    } catch (err) {
      fail(err);
    } finally {
      c.close();
    }
  });

program
  .command('templates')
  .description('List available templates')
  .action(async () => {
    const c = await core();
    out(c.listTemplates());
    c.close();
  });

const sites = program.command('sites').description('Manage sites');
sites
  .command('ls')
  .description('List sites')
  .action(async () => {
    const c = await core();
    out((await c.listSites()).map((s) => ({ id: s.id, name: s.name, updatedAt: s.updatedAt })));
    c.close();
  });
sites
  .command('rm')
  .argument('<siteId>')
  .description('Delete a site (and its assets/builds)')
  .action(async (siteId: string) => {
    const c = await core();
    try {
      await c.deleteSite(siteId);
      out(`deleted ${siteId}`);
    } catch (err) {
      fail(err);
    } finally {
      c.close();
    }
  });

program
  .command('components')
  .description('List components, or show one component contract (props schema + defaults)')
  .argument('[type]')
  .action(async (type?: string) => {
    const { componentJsonSchema, componentSummary, getComponent, listComponents } = await import(
      '@wb/components'
    );
    if (!type) {
      out(listComponents().map((d) => `${d.type.padEnd(14)} ${d.isContainer ? '[container] ' : ''}${d.description}`).join('\n'));
      return;
    }
    try {
      const def = getComponent(type);
      out({ ...componentSummary(def), propsSchema: componentJsonSchema(type), defaultProps: def.defaultProps });
    } catch (err) {
      fail(err);
    }
  });

const page = program.command('page').description('Manage pages');
page
  .command('add')
  .argument('<siteId>')
  .argument('<slug>')
  .option('--title <title>', 'page title')
  .action(async (siteId: string, slug: string, opts: { title?: string }) => {
    const c = await core();
    try {
      const p = await c.addPage(siteId, slug, opts.title ?? slug);
      out({ pageId: p.id, slug: p.slug || '(home)', rootId: p.tree.id });
    } catch (err) {
      fail(err);
    } finally {
      c.close();
    }
  });
page
  .command('ls')
  .argument('<siteId>')
  .action(async (siteId: string) => {
    const c = await core();
    try {
      out((await c.listPages(siteId)).map((p) => ({ id: p.id, slug: p.slug || '(home)', title: p.title })));
    } catch (err) {
      fail(err);
    } finally {
      c.close();
    }
  });
page
  .command('rm')
  .argument('<siteId>')
  .argument('<pageIdOrSlug>')
  .action(async (siteId: string, pageId: string) => {
    const c = await core();
    try {
      await c.deletePage(siteId, pageId);
      out(`deleted page ${pageId}`);
    } catch (err) {
      fail(err);
    } finally {
      c.close();
    }
  });

program
  .command('theme')
  .description('Update theme tokens: wb theme set <siteId> --primary "#0e7c66" …')
  .argument('<action>', 'set')
  .argument('<siteId>')
  .option('--primary <hex>')
  .option('--secondary <hex>')
  .option('--accent <hex>')
  .option('--background <hex>')
  .option('--surface <hex>')
  .option('--text <hex>')
  .option('--text-muted <hex>')
  .option('--font-heading <stack>')
  .option('--font-body <stack>')
  .option('--brand-name <name>')
  .action(async (action: string, siteId: string, opts: Record<string, string | undefined>) => {
    if (action !== 'set') fail(`unknown theme action "${action}" (expected: set)`);
    const c = await core();
    try {
      const colorKeys = ['primary', 'secondary', 'accent', 'background', 'surface', 'text'] as const;
      const colors: Record<string, string> = {};
      for (const k of colorKeys) if (opts[k]) colors[k] = opts[k]!;
      if (opts.textMuted) colors.textMuted = opts.textMuted;
      const patch = {
        ...(Object.keys(colors).length ? { colors } : {}),
        ...(opts.fontHeading || opts.fontBody
          ? {
              fonts: {
                ...(opts.fontHeading ? { heading: opts.fontHeading } : {}),
                ...(opts.fontBody ? { body: opts.fontBody } : {}),
              },
            }
          : {}),
        ...(opts.brandName ? { brandName: opts.brandName } : {}),
      };
      const site = await c.setTheme(siteId, patch as never);
      out(site.theme);
    } catch (err) {
      fail(err);
    } finally {
      c.close();
    }
  });

const tree = program.command('tree').description('Inspect and edit page component trees');
tree
  .command('get')
  .argument('<siteId>')
  .argument('<pageIdOrSlug>')
  .action(async (siteId: string, pageId: string) => {
    const c = await core();
    try {
      out(await c.getTree(siteId, pageId));
    } catch (err) {
      fail(err);
    } finally {
      c.close();
    }
  });
tree
  .command('ops')
  .description('Apply a batch of tree ops from a JSON file: [{"op":"insert",…}]')
  .argument('<siteId>')
  .argument('<pageIdOrSlug>')
  .requiredOption('--file <path>', 'JSON file containing an array of ops')
  .action(async (siteId: string, pageId: string, opts: { file: string }) => {
    const c = await core();
    try {
      const ops = JSON.parse(readFileSync(opts.file, 'utf8'));
      const updated = await c.applyPageOps(siteId, pageId, ops);
      out({ ok: true, rootId: updated.tree.id });
    } catch (err) {
      fail(err);
    } finally {
      c.close();
    }
  });

program
  .command('build')
  .description('Publish a site to static files')
  .argument('<siteId>')
  .option('-o, --out <dir>', 'output directory (default data/dist/<siteId>)')
  .action(async (siteId: string, opts: { out?: string }) => {
    const c = await core();
    try {
      const result = await c.publishSite(siteId, opts.out ? resolve(opts.out) : undefined);
      out({
        buildId: result.buildId,
        distPath: result.distPath,
        pages: result.pageCount,
        files: result.files.length,
        warnings: result.warnings,
        next: `wb serve ${result.distPath}`,
      });
    } catch (err) {
      fail(err);
    } finally {
      c.close();
    }
  });

program
  .command('deploy')
  .description('Publish and deploy a site via an adapter')
  .argument('<siteId>')
  .requiredOption('-a, --adapter <adapter>', 'static | vercel | netlify | cloudflare')
  .option('--target-dir <dir>', 'static adapter: copy build here')
  .option('--project-name <name>', 'provider project name')
  .action(async (siteId: string, opts: { adapter: string; targetDir?: string; projectName?: string }) => {
    const c = await core();
    try {
      const result = await c.publishSite(siteId);
      const deployed = deployDist(result.distPath, opts.adapter as DeployAdapterName, {
        targetDir: opts.targetDir,
        projectName: opts.projectName,
      });
      out(deployed);
    } catch (err) {
      fail(err);
    } finally {
      c.close();
    }
  });

program
  .command('dev')
  .description('Start the REST API + live preview server')
  .option('-p, --port <port>', 'port', '4000')
  .action(async (opts: { port: string }) => {
    const { startServer } = await import('@wb/server');
    const port = Number(opts.port);
    await startServer({ dataDir, port, host: '0.0.0.0' });
    console.log(`wb API listening on http://127.0.0.1:${port}`);
    console.log(
      process.env.WB_API_TOKEN
        ? '  auth:     enabled (WB_API_TOKEN) — clients need Authorization: Bearer <token>'
        : '  auth:     OPEN — set WB_API_TOKEN before exposing this beyond localhost',
    );
    console.log(`  editor:   http://127.0.0.1:${port}/editor/`);
    console.log(`  openapi:  http://127.0.0.1:${port}/openapi.json`);
    console.log(`  preview:  http://127.0.0.1:${port}/preview/<siteId>/`);
  });

program
  .command('serve')
  .description('Serve a built static site directory')
  .argument('<distDir>')
  .option('-p, --port <port>', 'port', '5000')
  .action(async (distDir: string, opts: { port: string }) => {
    const port = Number(opts.port);
    await serveStatic(resolve(distDir), port);
    console.log(`serving ${distDir} on http://127.0.0.1:${port}`);
  });

program
  .command('mcp')
  .description('Start the MCP server (stdio) — point Claude/agents at this command')
  .action(async () => {
    const { startMcpServer } = await import('@wb/mcp');
    await startMcpServer({ dataDir });
  });

program.parseAsync().catch(fail);
