import "dotenv/config";
import bolt from "@slack/bolt";
import express from "express";
import {
  pool,
  initSchema,
  saveInstall,
  getInstall,
  appendMessage,
  getRecentMessages,
  clearConversation,
} from "./db.js";
import { chat } from "./claude.js";
import { createConnectToken, listAccountsForUser } from "./pipedream.js";

const { App, ExpressReceiver } = bolt;

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  stateSecret: process.env.SLACK_STATE_SECRET || "pulse-state-secret",
  scopes: [
    "app_mentions:read",
    "chat:write",
    "im:history",
    "im:read",
    "im:write",
    "users:read",
    "commands",
  ],
  installationStore: {
    storeInstallation: async (install) => {
      await saveInstall(install);
    },
    fetchInstallation: async (q) => {
      const row = await getInstall(q.teamId);
      if (!row) throw new Error(`No install for team ${q.teamId}`);
      return {
        team: { id: row.team_id, name: row.team_name },
        bot: { token: row.bot_token, userId: row.bot_user_id, id: row.bot_user_id },
        user: { id: row.installed_by },
      };
    },
  },
  installerOptions: {
    redirectUriPath: "/slack/oauth_redirect",
    directInstall: true,
    callbackOptions: {
      success: (install, _opts, _req, res) => {
        const team = install?.team?.id || "";
        const user = install?.user?.id || "";
        res.redirect(`/dashboard?installed=1&team=${encodeURIComponent(team)}&user=${encodeURIComponent(user)}`);
      },
    },
  },
  redirectUri: process.env.SLACK_REDIRECT_URI,
});

const app = new App({ receiver });

// ----- Bolt: respond to DMs and @mentions -----
app.message(async ({ message, say, client }) => {
  if (message.channel_type !== "im" || message.subtype || message.bot_id) return;
  await handleUserMessage({
    teamId: message.team || (await client.auth.test()).team_id,
    userId: message.user,
    text: message.text || "",
    channel: message.channel,
    ts: message.ts,
    say,
    client,
  });
});

app.event("app_mention", async ({ event, say, client }) => {
  const cleaned = (event.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
  await handleUserMessage({
    teamId: event.team,
    userId: event.user,
    text: cleaned,
    channel: event.channel,
    ts: event.ts,
    say,
    client,
  });
});

async function handleUserMessage({ teamId, userId, text, channel, ts, say, client }) {
  if (!text) return;
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "/reset" || trimmed === "reset" || trimmed === "/clear" || trimmed === "clear") {
    await clearConversation(teamId, userId);
    await say("✓ Conversation memory wiped. Fresh start. What do you need?");
    return;
  }

  const reactionName = "hourglass_flowing_sand";
  let reactionAdded = false;
  // Drop the thinking reaction immediately so the user sees Pulse is on it
  if (client && channel && ts) {
    try {
      await client.reactions.add({ name: reactionName, channel, timestamp: ts });
      reactionAdded = true;
    } catch (e) {
      // Non-fatal — likely already-reacted or missing scope
      console.warn(`[pulse] reaction add failed: ${e?.data?.error || e?.message}`);
    }
  }

  try {
    console.log(`[pulse] message from ${teamId}:${userId} — "${text.slice(0, 80)}"`);
    const history = await getRecentMessages(teamId, userId, 20);
    await appendMessage(teamId, userId, "user", text);
    const externalUserId = `slack:${teamId}:${userId}`;
    const reply = await chat({ history, newMessage: text, externalUserId });
    await appendMessage(teamId, userId, "assistant", reply);
    await say(reply);
  } catch (e) {
    console.error("[pulse] handler error", e);
    await say(`oof, something broke: ${e.message}`);
  } finally {
    if (reactionAdded && client && channel && ts) {
      try {
        await client.reactions.remove({ name: reactionName, channel, timestamp: ts });
      } catch (e) {
        console.warn(`[pulse] reaction remove failed: ${e?.data?.error || e?.message}`);
      }
    }
  }
}

// ----- Express routes (landing page, dashboard, Pipedream) -----
const expressApp = receiver.app;
expressApp.use(express.json());
expressApp.use(express.static("public"));

expressApp.get("/", (_req, res) => res.sendFile("index.html", { root: "public" }));
expressApp.get("/dashboard", (_req, res) =>
  res.sendFile("dashboard.html", { root: "public" }),
);

// Endpoint the dashboard hits to start a Pipedream Connect session
expressApp.post("/api/pipedream/connect-token", async (req, res) => {
  try {
    const externalUserId = req.body?.externalUserId || `pulse-user-${Date.now()}`;
    const app = req.body?.app;
    const { token, expiresAt, connectLinkUrl } = await createConnectToken(externalUserId, app);
    res.json({ token, expiresAt, connectLinkUrl, externalUserId });
  } catch (e) {
    console.error("[pulse] connect-token error", e);
    res.status(500).json({ error: e.message });
  }
});

expressApp.get("/api/pipedream/accounts", async (req, res) => {
  try {
    const externalUserId = req.query.externalUserId;
    if (!externalUserId) return res.json({ accounts: [] });
    const accounts = await listAccountsForUser(externalUserId);
    res.json({ accounts });
  } catch (e) {
    console.error("[pulse] accounts error", e);
    res.status(500).json({ error: e.message });
  }
});

expressApp.get("/healthz", (_req, res) => res.json({ ok: true }));

// ----- Boot -----
const PORT = process.env.PORT || 3000;
(async () => {
  await initSchema();
  await app.start(PORT);
  console.log(`[pulse] running on :${PORT}`);
})();
