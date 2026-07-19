# Eve — the Slack website agent

Eve is a Slack bot on Vercel that builds, edits, and deploys websites by driving the wb REST API through Claude tool-use. Mention `@eve` in a channel or DM her:

> **@eve** spin up a Breakthrough Medical site with primary color #0e7c66 and publish it

Eve creates the branded site from the template, edits pages on request ("swap the hero headline", "add a pricing page with 3 tiers"), rethemes live, publishes static builds, and deploys — replying in the thread with the site id and results. Follow-ups in the same thread keep full context.

## Architecture

```
Slack ── Events API ──▶ Vercel fn /api/slack/events
                          │  verify signature → ack <3s → waitUntil(...)
                          ▼
                    Claude (claude-opus-4-8, adaptive thinking, tool runner)
                          │  10 tools: create_site, edit_page, set_theme,
                          │  publish_site, deploy_site, …
                          ▼
                    wb REST API (your `wb dev` host)  ──▶ static builds → host
```

Eve is stateless: conversation context is rebuilt from the Slack thread on every event, and all site state lives in the wb backend. The Vercel function acknowledges Slack within 3 seconds and finishes the agent run in the background (`waitUntil`), then posts the reply to the thread.

## Deploy

### 1. Host the wb API somewhere Eve can reach

Vercel functions can't run SQLite, so the builder backend runs wherever you like (a small VM, Fly.io, Render…):

```bash
wb dev --port 4000      # expose as https://wb.yourdomain.com
```

> The wb API currently has no auth — put it behind a private network, VPN, or an authenticating reverse proxy before exposing it to the internet.

### 2. Create the Slack app

https://api.slack.com/apps → *Create New App* → *From a manifest* → paste `slack-manifest.yaml`. Install to the workspace and note:
- **Bot token** (`xoxb-…`) — *OAuth & Permissions*
- **Signing secret** — *Basic Information*

### 3. Deploy to Vercel

From the repo root (monorepo — set the project's Root Directory to `apps/eve`):

```bash
vercel link
vercel env add ANTHROPIC_API_KEY
vercel env add SLACK_BOT_TOKEN
vercel env add SLACK_SIGNING_SECRET
vercel env add WB_API_URL           # e.g. https://wb.yourdomain.com
vercel env add WB_DEPLOY_ADAPTER    # optional: static | vercel | netlify | cloudflare
vercel deploy --prod
```

### 4. Point Slack at the deployment

*Event Subscriptions* → Request URL → `https://<your-deployment>/api/slack/events`. Slack sends a `url_verification` challenge; Eve answers it automatically. Then invite the bot: `/invite @eve`.

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | Claude API key |
| `SLACK_BOT_TOKEN` | ✅ | `xoxb-…` bot token |
| `SLACK_SIGNING_SECRET` | ✅ | Request signature verification |
| `WB_API_URL` | ✅ | Base URL of the wb REST API |
| `ANTHROPIC_MODEL` | — | Defaults to `claude-opus-4-8` |
| `WB_DEPLOY_ADAPTER` | — | Default adapter for `deploy_site` |

## Development

```bash
pnpm --filter @wb/eve build   # typecheck
pnpm --filter @wb/eve test    # unit + integration (spins up a real wb server)
```

Notes:
- Agent runs are capped at 25 tool iterations and 300s of function time (`vercel.json`); long builds report partial progress rather than hanging Slack.
- Slack redelivers events we don't ack in 3s — retries carry `x-slack-retry-num` and are dropped since the original is already processing.
- The system prompt keeps Breakthrough Medical copy compliance rules in front of the model (no outcome claims).
