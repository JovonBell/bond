# Pulse — V0

Slack-native AI coworker. Lives in your Slack workspace, remembers conversations, connects to 7,000+ tools via Pipedream Connect.

## What V0 does

- ✅ Web landing page with "Add to Slack" button
- ✅ Slack OAuth install flow
- ✅ Persistent install storage (Postgres)
- ✅ DM the bot → Claude responds with memory across conversations
- ✅ @mention in any channel → bot responds
- ✅ Dashboard to connect tools via Pipedream Connect
- ⏳ V0.1 will add: Claude tool-use (so it can actually USE the connected tools)
- ⏳ V0.2 will add: scheduled routines (the "fire every Monday at 8am" pattern)

## Setup (the ~15 min you need to do)

### 1. Anthropic API key
- Go to https://console.anthropic.com/settings/keys
- Create a key → copy it

### 2. Slack app
- Go to https://api.slack.com/apps → **Create New App** → **From a manifest** → pick your workspace
- Paste the contents of `slack-app-manifest.yaml`
- **You'll need to replace `YOUR-RAILWAY-URL` with your real Railway URL — but you don't have one yet, so come back to this after deploying.**
- For now, set placeholder values and finish creating the app
- From the app's **Basic Information** page, grab:
  - `Client ID`
  - `Client Secret`
  - `Signing Secret`

### 3. Pipedream Connect
- You already have a project: https://pipedream.com/@profitprocesses/projects/proj_JPsbdAR
- Go to project settings → **OAuth Clients** → create a new one
- Copy the `Client ID` and `Client Secret`
- The project ID is already in your `.env.example` (proj_JPsbdAR)

### 4. Railway
- Create a new Railway project: https://railway.app/new
- Add a **Postgres** plugin to the project (one click in Railway — auto-injects `DATABASE_URL`)
- Connect this GitHub repo (after you push) OR deploy via CLI:
  ```bash
  railway login
  railway init
  railway up
  ```
- Once deployed, Railway gives you a URL like `https://pulse-production-xxxx.up.railway.app`

### 5. Wire env vars in Railway
In Railway → your service → Variables, set:
```
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-6
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
SLACK_SIGNING_SECRET=...
SLACK_STATE_SECRET=anyrandomstring
SLACK_REDIRECT_URI=https://YOUR-RAILWAY-URL.up.railway.app/slack/oauth_redirect
PIPEDREAM_PROJECT_ID=proj_JPsbdAR
PIPEDREAM_CLIENT_ID=...
PIPEDREAM_CLIENT_SECRET=...
PIPEDREAM_ENVIRONMENT=development
APP_URL=https://YOUR-RAILWAY-URL.up.railway.app
```

### 6. Go back to the Slack app
- In your Slack app settings, update:
  - **OAuth & Permissions → Redirect URLs** → `https://YOUR-RAILWAY-URL.up.railway.app/slack/oauth_redirect`
  - **Event Subscriptions → Request URL** → `https://YOUR-RAILWAY-URL.up.railway.app/slack/events`
  - **Interactivity & Shortcuts → Request URL** → same as above
- Save changes

### 7. Install Pulse to your Slack
- Visit your Railway URL → click **Add to Slack** → authorize
- After install, you'll land on the dashboard
- Click **Connect a tool** → authorize Gmail / Calendar / etc.
- Open Slack → find **Pulse** in your sidebar → DM it

## Local development

```bash
npm install
cp .env.example .env  # fill in keys
npm run dev
```

For local Slack testing you'll need a tunnel (ngrok or cloudflared):
```bash
ngrok http 3000
# Use the https URL as your SLACK_REDIRECT_URI and event request URL
```

## Project structure

```
pulse/
├── package.json
├── railway.toml
├── slack-app-manifest.yaml   ← paste into api.slack.com
├── .env.example
├── src/
│   ├── server.js             ← main: Slack bot + Express routes
│   ├── db.js                 ← Postgres + schema
│   ├── claude.js             ← Anthropic wrapper
│   └── pipedream.js          ← Pipedream Connect SDK wrapper
└── public/
    ├── index.html            ← landing
    └── dashboard.html        ← post-install dashboard
```

## What's NOT in V0 (intentionally)

- Real tool-calling (Claude can't yet invoke the connected Pipedream tools — V0.1)
- Scheduled routines (V0.2)
- Multi-model picker (Viktor has this; we don't yet)
- Skills marketplace (Viktor has this; future)
- Billing / Stripe (everything's free during V0)
- Polished UI (it's ugly on purpose)

## Cost to run V0

| Service | Plan | Cost |
|---|---|---|
| Railway | Hobby (free $5/mo credit) | ~$0-10/mo |
| Railway Postgres | Included | $0 |
| Anthropic Claude | Pay-per-token | ~$0.01-0.05 per conversation |
| Pipedream Connect | Free tier | $0 up to 1k accounts |
| Slack | Free | $0 |

Total to test V0 with a handful of users: under $20/month.
