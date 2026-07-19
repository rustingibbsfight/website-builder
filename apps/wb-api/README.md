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

## What works serverless — and the one gap

Fully serverless: creating sites, editing pages, theming, uploading assets, live preview, and rendering the static build. Site data (Turso) and assets (R2) persist across cold starts.

**Publishing the final static sites still needs a destination.** `publish_site` renders the build into the function's `/tmp`, which is discarded after the request. The deploy adapters (`vercel`/`netlify`/`cloudflare`) shell out to provider CLIs that aren't present in the function, so from serverless they return instructions rather than deploying. Two clean ways to close this:

1. Run `wb build <id>` + `wb deploy <id>` from the **CLI** (or CI) against the same Turso/R2 backend — the CLI has the provider CLIs and a real filesystem.
2. (Future) Have `publish_site` write the rendered build to an R2 bucket bound to a public domain / Cloudflare Pages, so the API deploys sites end-to-end with no CLI. This is the natural next increment.

Until then: the builder + editor + preview are fully hosted here; the *last-mile publish* of a finished site to its public URL runs from the CLI.

## Local check

`@wb/core` uses the identical async libSQL client for a local `file:` URL, so you can exercise the exact serverless code path locally:

```bash
WB_DB_URL="file:./data/wb.db" wb dev    # same client, same async paths as Turso
```
