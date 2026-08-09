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

**Auth:** set `WB_API_TOKEN` before exposing the server beyond localhost. With it set, every route except `/health` and the editor shell requires the token — `Authorization: Bearer <token>` or `x-api-key` for API clients (Eve, scripts, curl), and the editor shows a sign-in screen that exchanges the token for an HttpOnly session cookie (which also authenticates the preview iframe). Unset = open, for local development.

## Storage backends

The data layer is backend-agnostic, selected by env vars. Unset everything and it's a zero-config local SQLite file + local asset folder — exactly the CLI/self-host experience.

| State | Local default | Remote / serverless |
|---|---|---|
| Database | SQLite file under `WB_DATA_DIR` | **libSQL/Turso** — `WB_DB_URL` (`libsql://…`) + `WB_DB_TOKEN` |
| Uploaded assets | local `assets/` folder | **R2 / S3** — `WB_ASSET_STORE=s3`, `WB_S3_BUCKET`, `WB_S3_ACCESS_KEY_ID`, `WB_S3_SECRET_ACCESS_KEY`, and for R2 `WB_S3_ENDPOINT` (`https://<acct>.r2.cloudflarestorage.com`) |

`@wb/core` opens the same async libSQL client for a local `file:` URL and a remote `libsql://` URL, and routes every asset byte (upload, preview, publish) through an `AssetStorage` interface — so nothing touches the local disk except when you choose the local backend. This is what lets the API run on Vercel (see `apps/wb-api`).

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

> **Deploying the whole platform?** See [DEPLOY.md](DEPLOY.md) — `./scripts/setup-cloud.sh` provisions Turso + R2 + both Vercel apps in one run.

## Deploying

**Live targets (fully serverless, no CLI needed):** configure `WB_PUBLISH_TARGET` and `wb deploy <siteId>` / `POST /sites/:id/deploy` / Eve's `deploy_site` renders the site in memory and pushes it live via provider HTTP APIs, returning the public URL:

- `WB_PUBLISH_TARGET=vercel` + `WB_VERCEL_TOKEN` — Vercel Deployments API; each site becomes a `wb-<name>` project, republish updates it in place
- `WB_PUBLISH_TARGET=r2` + `WB_PUBLISH_S3_BUCKET` (+ `WB_S3_*` creds, `WB_PUBLISH_PUBLIC_URL`) — upload to a public R2/S3 bucket

**Local CLI adapters** (when you want files or provider CLIs): `wb build` writes `data/dist/<siteId>`, and `wb deploy --adapter static|vercel|netlify|cloudflare` copies it or runs the provider CLI.

**Version control:** set `WB_VCS=github` + `WB_GITHUB_TOKEN` + `WB_GITHUB_OWNER` and every deploy also commits the site's source (`site.json`) and rendered `dist/` to a per-site repo (`wb-site-<name>`). Republishes stack up as commit history — diffable and restorable. `POST /sites/:id/commit` (or Eve's `commit_site`) makes a snapshot without deploying. Commits use the GitHub API (no git binary), so it works from serverless; a commit failure never blocks a live deploy.

**Contact forms.** A `contactForm` captures submissions in wb by default: it posts to `POST /sites/:id/submissions/:formId` (public, honeypot + rate-limited), stores the fields, and answers the visitor with a zero-JS thank-you page. That needs the site's `settings.formEndpoint` — set `WB_PUBLIC_URL` to this API's own base URL and new sites get it automatically (existing ones are backfilled once on startup). To use something else instead, set the form's `action` prop (e.g. Formspree) or `netlifyForms: true` on Netlify.

Read captured messages in the editor's **📥 Submissions** panel, via `GET /sites/:id/submissions`, with the MCP `list_submissions` tool, or by asking Eve.

**Nothing announces a submission unless you configure it to** — a message otherwise waits until somebody looks. Both channels are optional and independent, and a failure in either is logged and never fails the capture:

- `WB_NOTIFY_SLACK_WEBHOOK` — a Slack incoming-webhook URL. The channel is chosen when you create the webhook.
- `RESEND_API_KEY` + `WB_NOTIFY_EMAIL_TO` (comma-separated) + `WB_NOTIFY_EMAIL_FROM` (a Resend-verified sender). Mail goes out as plain text, with the submitter's address as `Reply-To` when they left a valid one.

## The Breakthrough Medical template

Four pages (home, services, about, contact) + shared header/footer, teal medical theme, branded SVG placeholder art, GLP-1-compliance-aware copy (no outcome claims, "individual results vary", medical-evaluation disclosures).

> ⚠️ The template's address, phone, and email on the contact page are **placeholders** — replace them with the clinic's real details before going live (edit via `edit_page` or the API).

## Development

```bash
pnpm build     # typecheck + compile all packages
pnpm test      # unit + integration tests (schema, components, renderer, core, server, cli, mcp, eve)
pnpm e2e       # Playwright: real browser at desktop/tablet/mobile viewports
```

~150 unit/integration tests plus 20 Playwright e2e specs, including dedicated adversarial/security suites per package.

## Security model

- **Rendering is escape-by-default.** All component text is HTML-escaped; `href`s are restricted to http(s)/mailto/tel/relative/anchor; asset URLs are stripped of CSS metacharacters before entering `url()` (no stylesheet injection); theme colors are hex-validated. `htmlEmbed` is the one documented raw-HTML escape hatch.
- **No arbitrary filesystem access over HTTP.** Publish always targets the managed `data/dist` tree and deploy takes no client path — custom output directories are a local-CLI-only capability. Uploaded-asset filenames are sanitized and id-namespaced; preview/asset/static-serve paths are containment-checked against traversal.
- **Uploaded assets** are served with `Content-Security-Policy: default-src 'none'` and `X-Content-Type-Options: nosniff`, so an uploaded SVG can't run script in the app origin.
- **Auth** via `WB_API_TOKEN` (see above). Sites are isolated: a page/asset id from one site never resolves under another.
- **Production fails closed.** With `NODE_ENV=production` and no `WB_API_TOKEN`, the server refuses to start rather than serving every write route to anyone who can reach the host. Unset off production is still open, which is what makes `wb serve` on a laptop usable without a secret.

### wb is single-owner, and that is a decision

**One credential, no per-user identity, and no per-tenant scoping — by design, not by omission.** Anyone holding `WB_API_TOKEN` can list, edit, retheme, deploy and delete every site the deployment holds. Eve inherits exactly that: the Slack bot authenticates as the deployment, not as the person who @mentioned it, so any workspace member who can reach the bot can act on any site.

That is the right shape for what this is — one team's own sites, run by the people who own them — and the wrong shape for anything else. Writing it down settles the open question from the hardening review (#50) rather than leaving it looking like a gap somebody forgot.

**What would have to change first**, if it ever stops being true: a real identity (Slack user/team → owner), an ownership column on `sites`, enforcement in `packages/core` rather than at the routes, and a way to hand ownership over. Until all four exist, do not add a partial version — a scoping check that covers the routes somebody remembered is worse than none, because it reads as protection.

## Visual editor (drag & drop)

```bash
pnpm --filter @wb/editor build   # once (also part of `pnpm build`)
wb dev                            # then open http://127.0.0.1:4000/editor/
```

The editor is a React app mounted on the same REST API agents use — every edit is a `TreeOp[]` batch to `/tree/ops`:

- **Canvas** — the live preview in an iframe; click any element to select it (hover/selection outlines come from an editor-only script injected into the preview, never published). **Double-click a heading, paragraph, or button to edit its text inline, right on the canvas** — Enter or click-away commits, Esc cancels; every edit is an undoable tree op.
- **Palette** — drag a component onto the canvas (a drop indicator shows the exact insertion point, computed by hit-testing real rendered layout) or double-click to insert into the selected container.
- **Outline** — the page tree; drag rows to reorder or nest, click to select.
- **Inspector** — props form auto-generated from each component's JSON Schema, plus layout (direction/gap/padding/align/columns/max-width), style tokens, and per-breakpoint visibility.
- **Theme** — brand colors, font stacks, rounding; the whole site restyles live.
- Undo/redo (⌘Z/⌘⇧Z), viewport toggle (desktop/tablet/mobile), one-click publish.

## Eve — the Slack bot

`apps/eve` is a [Vercel eve](https://eve.dev)-framework agent (the same pattern as the clinic's weekly-rx-form agent): mention `@eve` and Claude drives the wb REST API through typed tools — *"spin up a Breakthrough Medical site with primary color #0e7c66 and ship it"* becomes a threaded Slack conversation that ends with a live URL. Slack credentials are provisioned by Vercel Connect (`vercel connect create slack`) and the model runs via Vercel AI Gateway — no Slack app config, no API keys to manage. Setup in [apps/eve/README.md](apps/eve/README.md).

## Roadmap

- Responsive per-breakpoint overrides UI in the editor (engine already supports them).
- More templates; Postgres store option.
