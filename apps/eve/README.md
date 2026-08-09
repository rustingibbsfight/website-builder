# Eve — the wb website agent

A [Vercel eve](https://eve.dev) agent that builds, edits, and deploys websites through the wb API — the same pattern as the clinic's weekly-rx-form-signature-agent. Mention `@eve` in Slack:

> **@eve** spin up a Breakthrough Medical site with primary color #0e7c66 and ship it

Eve creates the branded site from the template, edits pages on request, rethemes live, and deploys to a public URL — replying in the thread. Thread context, Slack credentials, retries, and the agent loop are all handled by the eve framework; this repo only defines the agent.

## Project layout

```
agent/
  agent.ts             # model config (anthropic/claude-opus-4-8 via AI Gateway)
  instructions.md      # Eve's identity, workflow, Slack style, compliance rules
  tools/               # typed wb tools: create_site, edit_page, set_theme,
                       #   deploy_site (live URL), list_components, …
  channels/slack.ts    # Slack channel (Vercel Connect credentials)
  channels/eve.ts      # HTTP/dev-REPL channel
lib/wb.ts              # wb REST client (WB_API_URL + WB_API_TOKEN bearer)
lib/studio.ts          # ComfyStudio client (STUDIO_API_URL + STUDIO_API_KEY bearer).
                       #   Holds no copy of the studio's vocabulary: purposes,
                       #   aspects and the library categories are fetched from
                       #   /api/serve/guidance and cached for a minute, because
                       #   a copied enum goes stale and fails closed and silently.
                       #   `lib/vocabulary.test.ts` reads the source to keep it so.
```

## Setup

Requires Node 24+ locally and the Vercel CLI. (In the monorepo, `pnpm build` only typechecks; Vercel builds with `eve build` via the `vercel-build` script.)

### 1. Deploy

```bash
cd apps/eve
vercel link                                   # create/link a project (e.g. "wb-eve")
VERCEL_USE_EXPERIMENTAL_FRAMEWORKS=1 vercel deploy --prod
```

### 2. Slack via Vercel Connect — no Slack app to configure by hand

Connect provisions and installs the Slack app, holds the bot token, and verifies inbound webhooks:

```bash
vercel connect create slack --triggers        # installs the app; prints a UID like slack/wb-eve
vercel connect detach <uid> --yes             # re-point the trigger at eve's Slack route
vercel connect attach <uid> --triggers --trigger-path /eve/v1/slack --yes
```

Then `/invite @eve` in the channel. If the UID isn't exactly `slack/wb-eve`, set `SLACK_CONNECT_UID`.

### 3. Environment variables

```bash
vercel env add WB_API_URL        # the wb API deployment, e.g. https://wb-api-….vercel.app
vercel env add WB_API_TOKEN      # the wb API's WB_API_TOKEN
# optional: SLACK_CONNECT_UID    # if the Connect UID differs from slack/wb-eve
```

### 4. ComfyStudio — original images (optional)

`request_image` / `image_status` let Eve commission a picture from
[ComfyStudio](https://github.com/rustingibbsfight/comfyui-personal), which runs
ComfyUI workflows on Comfy Cloud. Eve describes what the *page* needs; the
studio's own agent picks the workflow and writes the prompt.

```bash
vercel env add STUDIO_API_URL    # the ComfyStudio deployment, e.g. https://comfystudio-….vercel.app
vercel env add STUDIO_API_KEY    # ComfyStudio → Settings → Agent access → Create a key (shown once)
```

The key holds `images:request` and nothing else, and carries its own daily
render ceiling. Without both variables the two tools fail with a message naming
the missing one; every other tool keeps working.

Images come back as public URLs, which `add_asset` then ingests into the site.
That path refuses private/internal hosts by design, so `STUDIO_API_URL` must be
a real public deployment — a tunnel to localhost will fetch the ticket fine and
then fail to ingest the picture.

No Anthropic key and no Slack tokens: the model runs through Vercel's AI Gateway, and Slack credentials live in Vercel Connect.

## Development

```bash
pnpm --filter @wb/eve build      # typecheck against the real eve types
pnpm --filter @wb/eve test       # wb client integration test (spins up a real wb server)
npm run dev                      # eve dev REPL (Node 24)
```
