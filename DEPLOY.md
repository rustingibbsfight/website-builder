# Deploying the wb platform + Eve

Everything runs serverless: **wb-api** (builder API + editor) and **Eve** (Slack agent) on Vercel, data in **Turso**, assets in **R2**, finished sites deployed live via the **Vercel Deployments API**.

## One command (from your machine)

With `vercel`, `turso`, and `wrangler` logged in:

```bash
./scripts/setup-cloud.sh
```

The script is idempotent — it provisions the Turso DB and R2 bucket, wires every env var, and deploys both apps. Eve is a [Vercel eve](https://eve.dev) agent (same pattern as the weekly-rx-form agent): the model runs through Vercel's **AI Gateway** (no Anthropic key) and Slack is provisioned by **Vercel Connect** (no Slack app, bot token, or signing secret to manage). The script stops and tells you exactly what to do at the two things it can't automate:

| It needs | Where you get it | Pass as |
|---|---|---|
| R2 S3 credentials | Cloudflare dashboard → R2 → Manage R2 API Tokens (Object Read & Write) | `WB_S3_ACCESS_KEY_ID`, `WB_S3_SECRET_ACCESS_KEY`, `WB_S3_ENDPOINT` |
| Vercel API token | vercel.com/account/tokens (lets the API deploy finished sites live) | `WB_VERCEL_TOKEN` |

So a full run typically looks like:

```bash
WB_S3_ACCESS_KEY_ID=… WB_S3_SECRET_ACCESS_KEY=… \
WB_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
WB_VERCEL_TOKEN=… \
./scripts/setup-cloud.sh
```

Final step (printed by the script, ~1 minute, interactive):

```bash
cd apps/eve
vercel connect create slack --triggers      # installs the Slack app; prints a UID
vercel connect detach <uid> --yes
vercel connect attach <uid> --triggers --trigger-path /eve/v1/slack --yes
```

Then `/invite @eve`.

## Verify

```bash
curl -H "Authorization: Bearer $WB_API_TOKEN" https://<wb-api>/health
```

In Slack:

> **@eve** create a Breakthrough Medical site with primary color #0e7c66 and deploy it

Eve should reply in-thread with a live `https://wb-breakthrough-medical.vercel.app` URL. The visual editor is at `https://<wb-api>/editor/` (sign in with `WB_API_TOKEN`).

## Deploys

The Vercel projects (`wb-api`, `wb-eve`, and the per-site `wb-*` projects) already exist and hold all runtime env vars. The visual editor ships inside `wb-api` and is live at `https://<wb-api>/editor/` (sign in with `WB_API_TOKEN`).

**Today, production deploys are manual.** Merging to the trunk branch does **not** currently redeploy — Vercel's Git integration is not wired to this trunk. To ship the current tree to production:

```bash
vercel link --project wb-api --yes      # run once, at the REPO ROOT
vercel deploy --prod                     # from the repo root — NOT apps/wb-api
```

> ⚠️ The project's Root Directory is `apps/wb-api`, so `vercel deploy` must run from the **repo root**; running it inside `apps/wb-api` doubles the path (`apps/wb-api/apps/wb-api`) and fails.

`.github/workflows/ci.yml` runs `pnpm -r build && pnpm -r test` on pushes and PRs to guard correctness; it does **not** deploy.

**To make deploys automatic:** in the Vercel dashboard → `wb-api` → Settings → Git, connect the GitHub repo and set the **Production Branch** to the trunk (`claude/ai-website-builder-api-xqg6zr`). After that, merges deploy on their own and this section can be simplified. (Alternatively, re-add a CI deploy job with `VERCEL_TOKEN` / `VERCEL_ORG_ID` / `VERCEL_*_PROJECT_ID` secrets — but don't run both mechanisms, or every push deploys twice.)

## Before pointing real patients at the Breakthrough Medical site

- Replace the placeholder address/phone/email on the contact page.
- Wire the contact form's `action` to a real form endpoint (e.g. Formspree).
- Swap the placeholder SVG art for real photography via `add_asset`.
