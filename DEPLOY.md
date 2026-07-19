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

## Continuous deploys (optional)

`.github/workflows/deploy.yml` tests the whole workspace and redeploys both apps on every push to `main`. After the first `setup-cloud.sh` run, add these GitHub Actions secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_WB_API_PROJECT_ID`, `VERCEL_EVE_PROJECT_ID` (the ids are in each app's `.vercel/project.json` after linking).

## Before pointing real patients at the Breakthrough Medical site

- Replace the placeholder address/phone/email on the contact page.
- Wire the contact form's `action` to a real form endpoint (e.g. Formspree).
- Swap the placeholder SVG art for real photography via `add_asset`.
