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

## Publishing app pages to breakthrough-medspa.com

Each deploy can also create the app's page on the clinic's WordPress site,
masked to the live app with the Content Mask plugin, so visitors reach it at
`breakthrough-medspa.com/app-<name>/` instead of a `*.vercel.app` host.

1. Copy [`wordpress/wb-app-pages.php`](wordpress/wb-app-pages.php) to
   `wp-content/mu-plugins/` on breakthrough-medspa.com (create the directory if
   it isn't there — must-use plugins need no activation). Confirm the Content
   Mask plugin is active.
2. Create an Application Password for a user who can publish pages
   (Users → Profile → Application Passwords).
3. Put four variables on the **wb-api** project:

```bash
vercel env add WB_WORDPRESS_URL           # https://breakthrough-medspa.com
vercel env add WB_WORDPRESS_USER          # the WordPress login
vercel env add WB_WORDPRESS_APP_PASSWORD  # the application password
vercel env add WB_WORDPRESS_STATUS        # draft to start with; publish once trusted
```

**Verify the masking keys before trusting this.** Content Mask's post meta keys
are internal to that plugin, and they are the one part of this that fails
quietly — a wrong key name creates the page and leaves it blank. Mask a page by
hand in wp-admin, run `wp post meta list <page-id>`, and reconcile with the
`WB_CONTENT_MASK_META` constant at the top of `wb-app-pages.php`. That constant
is the only place the names appear.

If every call comes back 401 on Apache/CGI, the `Authorization` header is being
stripped before PHP sees it: add
`RewriteRule ^ - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]` to `.htaccess`.

## The editor's chat with Eve

The editor talks to `wb-api`, and `wb-api` talks to `wb-eve`. Eve's own HTTP
channel stays closed to browsers — opening a second door into it for one caller
is the kind of thing that ends up weaker than the first door — so two variables
go on the **wb-api** project:

```bash
vercel env add WB_EVE_URL      # the wb-eve deployment, e.g. https://wb-eve-….vercel.app
vercel env add WB_EVE_TOKEN    # optional; omit locally, where eve's localDev() opens the channel
```

`WB_EVE_TOKEN` is wb-api's own credential, deliberately not the browser's: a
proxy that forwards a user credential onward is a confused deputy.

Two things worth checking against the deployment before trusting the shape,
because both are assumptions rather than measurements:

- **That eve keeps a turn running after the caller drops the POST connection.**
  The "202 and let go" design rests on it. It is documented true for ComfyStudio;
  if it turns out false here the fallback is to hold the leg ~50s and let it drop.
- **`apps/eve`'s `maxDuration`**, which is undeclared today — there is no
  `vercel.json` in that app. It stops mattering once no tool blocks.
