# wb-api — the builder platform on Vercel

Runs the wb REST API + visual editor + live preview as a Vercel serverless function, with all durable state pushed off the ephemeral function filesystem:

- **Database** → Turso (libSQL)
- **Uploaded assets** → Cloudflare R2 (or any S3-compatible store)
- **Published builds** → rendered to `/tmp` per request, then pushed to a static host (see "Publishing" below)

This is the piece that lets you avoid running an always-on VM. Eve (`apps/eve`) and your browser both point at this deployment.

## Prerequisites

1. **A Turso database** — `turso db create wb && turso db show wb --url` for the URL, `turso db tokens create wb` for the token.
2. **A Cloudflare R2 bucket** — create it with `wrangler r2 bucket create wb-assets`, and an R2 API token (Account → R2 → Manage API Tokens) for the access key id / secret. Your S3 endpoint is `https://<account-id>.r2.cloudflarestorage.com`.

## Deploy

Set the Vercel project's **Root Directory** to `apps/wb-api` and the **Build Command** to build the workspace (so `@wb/editor` is compiled and bundled):

```
pnpm -w install && pnpm -w build
```

Environment variables:

```bash
vercel env add WB_DB_URL                 # libsql://wb-<org>.turso.io
vercel env add WB_DB_TOKEN               # turso token
vercel env add WB_ASSET_STORE            # s3
vercel env add WB_S3_BUCKET              # wb-assets
vercel env add WB_S3_ENDPOINT            # https://<account-id>.r2.cloudflarestorage.com
vercel env add WB_S3_ACCESS_KEY_ID       # R2 access key id
vercel env add WB_S3_SECRET_ACCESS_KEY   # R2 secret
vercel env add WB_API_TOKEN              # shared API token (Eve uses the same value)
vercel deploy --prod
```

`vercel.json` rewrites all paths to the function, which drives the Fastify app in-process (no port bind). Then:

- **Editor**: `https://<deployment>/editor/` (prompts for `WB_API_TOKEN`)
- **API**: `https://<deployment>/sites` with `Authorization: Bearer $WB_API_TOKEN`
- **Point Eve's** `WB_API_URL` at `https://<deployment>` and give it the same `WB_API_TOKEN`.

## Fully serverless — including going live

Everything runs in the function: creating sites, editing, theming, assets, live preview, **and deploying finished sites to their public URL**. `POST /sites/:id/deploy` (no body) renders the complete site *in memory* — pages, CSS, and asset bytes pulled from R2 — and pushes it to the configured **publish target** via provider HTTP APIs. No CLI, no disk.

Pick a target:

```bash
# Option A (recommended): Vercel Deployments API — one POST, instant live URL
vercel env add WB_PUBLISH_TARGET         # vercel
vercel env add WB_VERCEL_TOKEN           # a Vercel API token
# optional: WB_VERCEL_TEAM_ID, WB_VERCEL_PROJECT_PREFIX (default "wb-")

# Option B: upload builds to a public R2 bucket (you already have wrangler)
#   wrangler r2 bucket create wb-sites   — then connect a public/custom domain to it
vercel env add WB_PUBLISH_TARGET         # r2
vercel env add WB_PUBLISH_S3_BUCKET      # wb-sites (reuses the WB_S3_* credentials)
vercel env add WB_PUBLISH_PUBLIC_URL     # https://sites.yourdomain.com (for reported URLs)
```

With the **vercel** target, each site becomes a Vercel project named from the site name (`wb-breakthrough-medical`), republishes update the same project, and the returned URL is `https://<project>.vercel.app` — attach a custom domain to that project in Vercel and it just works, clean URLs included.

With the **r2** target, builds land under `<bucket>/<siteId>/…` behind your R2 domain. Note R2 serves exact keys — add a Cloudflare transform rule mapping `/x/` → `/x/index.html` for clean directory URLs.

So the northstar is now literally serverless end-to-end: Eve's `deploy_site` (or `wb deploy <siteId>`, or `POST /deploy`) returns a **live public URL**.

`publish_site` (render-only, no deploy) still writes to `/tmp` on serverless — it's transient by design; use `deploy` for anything meant to persist.

## Local check

`@wb/core` uses the identical async libSQL client for a local `file:` URL, so you can exercise the exact serverless code path locally:

```bash
WB_DB_URL="file:./data/wb.db" wb dev    # same client, same async paths as Turso
```
