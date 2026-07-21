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

## Continuous deploys (CI)

`.github/workflows/deploy.yml` tests the whole workspace, then on every push to `main` (or a manual **Run workflow**) redeploys **wb-api — the REST API plus the drag-and-drop visual editor served at `/editor/`** — and smoke-tests that `/editor/` responds. To enable it:

1. Create the Vercel project(s) once (`./scripts/setup-cloud.sh`, or `vercel link` inside `apps/wb-api`).
2. In **GitHub repo → Settings → Secrets and variables → Actions**, add these **secrets**:
   - `VERCEL_TOKEN` — a Vercel API token (vercel.com/account/tokens)
   - `VERCEL_ORG_ID` — from `apps/wb-api/.vercel/project.json` after linking
   - `VERCEL_WB_API_PROJECT_ID` — the `projectId` in that same file

That's all the editor needs — push to `main` and it deploys.

**Eve is opt-in.** The `deploy-eve` job stays off (so a not-yet-configured Eve never fails the editor's deploy). To turn it on, finish Eve's Slack/Connect setup, then add the **variable** `DEPLOY_EVE=true` and the **secret** `VERCEL_EVE_PROJECT_ID` (from `apps/eve/.vercel/project.json`).

## Before pointing real patients at the Breakthrough Medical site

- Replace the placeholder address/phone/email on the contact page.
- Wire the contact form's `action` to a real form endpoint (e.g. Formspree).
- Swap the placeholder SVG art for real photography via `add_asset`.
