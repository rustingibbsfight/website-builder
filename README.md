# wb — API-first website builder

Build responsive, branded websites from the **CLI**, the **REST API**, or **MCP** (AI agents) — the same engine behind all three. Sites are JSON component trees with Figma-style auto-layout; publishing renders them to fast, zero-JavaScript static HTML/CSS you can deploy anywhere.

**The northstar in one command:**

```bash
wb create "Breakthrough Medical" --template breakthrough-medical && wb build <siteId>
```

…or one MCP tool call (`create_site`) from Claude or any MCP-capable agent.

## Why this exists

- **Agent-native.** Every capability — creating sites, composing pages, theming, publishing, deploying — is API-first. A drag-and-drop editor (phase 2) mounts on the *same* tree-ops API that agents use, not the other way around.
- **Responsive by construction.** There is no absolute positioning. Every container is auto-layout (`stack` / `row` / `grid` with gap/padding/align), with per-breakpoint deltas. Multi-column grids collapse to 2 columns on tablet and 1 on mobile automatically; rows stack on mobile. Agents *cannot* produce a non-responsive layout.
- **Clean output.** Published sites are static HTML + one CSS file: no framework runtime, no hydration, zero JS (the only exception is the opt-in click-to-load video facade). SEO head, sitemap, robots.txt, 404 included.

## Repo layout

```
packages/schema      Node/Layout/Style/Theme model, tree ops (atomic applyOps)
packages/components  23 components with zod prop schemas + render fns
packages/renderer    schema → responsive static HTML/CSS
packages/core        service layer + SQLite storage + publish + deploy adapters
packages/server      Fastify REST API + OpenAPI + live preview
packages/cli         `wb` command
packages/mcp         MCP server (stdio) for AI agents
templates/…          starter sites built with the schema (breakthrough-medical)
e2e                  Playwright responsive verification
```

## Quick start

```bash
pnpm install
pnpm build

# create the flagship demo site with your brand color
node packages/cli/dist/index.js create "Breakthrough Medical" \
  --template breakthrough-medical --brand-primary "#0e7c66" \
  --base-url https://example.com

# render static files
node packages/cli/dist/index.js build <siteId>

# look at it
node packages/cli/dist/index.js serve data/dist/<siteId>
```

Tip: `pnpm link --global` in `packages/cli` gives you a global `wb` command.

### CLI reference

```
wb create <name> [--template t] [--brand-primary #hex] [--brand-secondary #hex]
                 [--brand-accent #hex] [--font-heading stack] [--font-body stack]
                 [--logo-url url] [--base-url url]
wb templates                     list templates
wb sites ls | rm <siteId>
wb components [type]             component discovery (schemas + defaults)
wb page add <siteId> <slug> [--title] | ls <siteId> | rm <siteId> <page>
wb theme set <siteId> --primary #hex --font-heading serif-modern …
wb tree get <siteId> <page>      dump a page tree
wb tree ops <siteId> <page> --file ops.json    apply tree ops
wb build <siteId> [--out dir]    publish static site
wb deploy <siteId> --adapter static|vercel|netlify|cloudflare
wb dev [--port 4000]             REST API + live preview server
wb serve <distDir> [--port]      serve a build locally
wb mcp                           MCP server on stdio
```

Data lives in `./data` (override with `WB_DATA_DIR`).

## REST API

```bash
wb dev   # http://127.0.0.1:4000, OpenAPI at /openapi.json
```

Highlights (full spec in `/openapi.json`):

- `POST /sites/from-template` `{template, name, brand}` — branded site in one call
- `GET /components` / `GET /components/:type` — discovery with JSON Schemas
- `POST /sites/:id/pages/:pageId/tree/ops` — atomic `TreeOp[]` batch (insert/update/move/remove/replace); on failure returns 422 with the failing op index
- `PUT  /sites/:id/pages/:pageId/tree` — whole-tree replace (bulk generation)
- `POST /sites/:id/assets` — multipart file or JSON `{filename, mime, base64}`
- `POST /sites/:id/publish` → dist path + lint warnings, `POST /sites/:id/deploy`
- `GET  /preview/:siteId/…` — live draft preview (no publish needed)

## MCP — build sites from Claude

Register the server (Claude Code shown; any MCP client works):

```bash
claude mcp add wb -- node /path/to/website-builder/packages/cli/dist/index.js mcp
```

or in `.mcp.json` / Claude Desktop config:

```json
{
  "mcpServers": {
    "wb": {
      "command": "node",
      "args": ["/path/to/website-builder/packages/cli/dist/index.js", "mcp"],
      "env": { "WB_DATA_DIR": "/path/to/website-builder/data" }
    }
  }
}
```

11 tools: `list_templates`, `create_site`, `list_components`, `get_site`, `get_page` (compact outline), `edit_page` (atomic ops), `add_page`, `set_theme`, `add_asset`, `publish_site`, `preview_site` (optional desktop+mobile screenshots for self-verification).

A typical agent session: `create_site {template: "breakthrough-medical", brand: {...}}` → `get_page` → `edit_page` → `preview_site {screenshot: true}` → `publish_site`. A Slack bot wired to Claude with this MCP server gets one-command website deployment for free.

## Deploying

`wb build` output (`data/dist/<siteId>`) is a complete static site. `wb deploy` wraps it:

- `--adapter static --target-dir /var/www/site` — copy the build
- `--adapter vercel|netlify|cloudflare` — writes provider config into dist and runs the provider CLI if installed, otherwise prints the exact command

Contact forms on static hosting need a form endpoint: set the form's `action` prop (e.g. Formspree) or `netlifyForms: true` on Netlify.

## The Breakthrough Medical template

Four pages (home, services, about, contact) + shared header/footer, teal medical theme, branded SVG placeholder art, GLP-1-compliance-aware copy (no outcome claims, "individual results vary", medical-evaluation disclosures).

> ⚠️ The template's address, phone, and email on the contact page are **placeholders** — replace them with the clinic's real details before going live (edit via `edit_page` or the API).

## Development

```bash
pnpm build     # typecheck + compile all packages
pnpm test      # unit + integration tests (schema, components, renderer, core, server, mcp)
pnpm e2e       # Playwright: real browser at desktop/tablet/mobile viewports
```

## Visual editor (drag & drop)

```bash
pnpm --filter @wb/editor build   # once (also part of `pnpm build`)
wb dev                            # then open http://127.0.0.1:4000/editor/
```

The editor is a React app mounted on the same REST API agents use — every edit is a `TreeOp[]` batch to `/tree/ops`:

- **Canvas** — the live preview in an iframe; click any element to select it (hover/selection outlines come from an editor-only script injected into the preview, never published).
- **Palette** — drag a component onto the canvas (a drop indicator shows the exact insertion point, computed by hit-testing real rendered layout) or double-click to insert into the selected container.
- **Outline** — the page tree; drag rows to reorder or nest, click to select.
- **Inspector** — props form auto-generated from each component's JSON Schema, plus layout (direction/gap/padding/align/columns/max-width), style tokens, and per-breakpoint visibility.
- **Theme** — brand colors, font stacks, rounding; the whole site restyles live.
- Undo/redo (⌘Z/⌘⇧Z), viewport toggle (desktop/tablet/mobile), one-click publish.

## Roadmap

- Slack bot interface (thin adapter over MCP/REST).
- Responsive per-breakpoint overrides UI in the editor (engine already supports them).
- More templates; Postgres store option.
