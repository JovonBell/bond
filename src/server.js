import "dotenv/config";
import bolt from "@slack/bolt";
import express from "express";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
import {
  pool,
  initSchema,
  saveInstall,
  getInstall,
  appendMessage,
  getRecentMessages,
  clearConversation,
  pingDb,
} from "./db.js";
import { chat } from "./claude.js";
import { createConnectToken, listAccountsForUser, invalidateAccountCache } from "./pipedream.js";
import { startRunner, registerChat, registerMetricsHook } from "./routines.js";

// ----- Global error handlers — keep the process alive on transient failures -----
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason?.message || reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err?.message || err);
  // Don't exit — Railway will restart anyway if we do
});

// Simple in-process metrics for /status
const metrics = {
  startedAt: Date.now(),
  messages: 0,
  errors: 0,
  routinesFired: 0,
  lastError: null,
};
export function bumpMetric(name, val = 1) {
  if (name === "lastError") metrics.lastError = val;
  else metrics[name] = (metrics[name] || 0) + val;
}

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
        const name = install?.user?.name || install?.team?.name || "User";
        // Set session cookie so the dashboard recognizes them
        setSession(res, { teamId: team, userId: user, name });
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
    metrics.messages++;
    const history = await getRecentMessages(teamId, userId, 20);
    await appendMessage(teamId, userId, "user", text);
    const externalUserId = `slack:${teamId}:${userId}`;
    const reply = await chat({ history, newMessage: text, externalUserId });
    await appendMessage(teamId, userId, "assistant", reply);
    await say(reply);
  } catch (e) {
    console.error("[pulse] handler error", e);
    metrics.errors++;
    metrics.lastError = { message: e?.message, at: new Date().toISOString() };
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

// ----- Express routes -----
const expressApp = receiver.app;
expressApp.use(express.json());
expressApp.use(cookieParser());

// ----- Session signing (HMAC-signed cookies, stateless) -----
const SESSION_SECRET = process.env.SLACK_STATE_SECRET || "pulse-session-secret-change-me";
const SESSION_COOKIE = "pulse_session";

function signSession(payload) {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(b64).digest("base64url");
  return `${b64}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== "string") return null;
  const [b64, sig] = token.split(".");
  if (!b64 || !sig) return null;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(b64).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(b64, "base64url").toString());
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function getSession(req) { return verifySession(req.cookies?.[SESSION_COOKIE]); }
function setSession(res, payload) {
  const token = signSession({ ...payload, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

// ----- Sign in with Slack (OpenID Connect) -----
expressApp.get("/auth/slack/start", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  res.cookie("pulse_oauth_state", state, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600000 });
  const redirect = `${process.env.APP_URL}/auth/slack/callback`;
  const url = new URL("https://slack.com/openid/connect/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("client_id", process.env.SLACK_CLIENT_ID);
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", redirect);
  res.redirect(url.toString());
});

expressApp.get("/auth/slack/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    const storedState = req.cookies?.pulse_oauth_state;
    if (!code || !state || state !== storedState) {
      return res.status(400).send("Invalid OAuth state.");
    }
    const tokenResp = await fetch("https://slack.com/api/openid.connect.token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.SLACK_CLIENT_ID,
        client_secret: process.env.SLACK_CLIENT_SECRET,
        code,
        redirect_uri: `${process.env.APP_URL}/auth/slack/callback`,
        grant_type: "authorization_code",
      }),
    });
    const tokenJson = await tokenResp.json();
    if (!tokenJson.ok) {
      console.error("[auth] token exchange failed", tokenJson);
      return res.status(400).send(`Auth failed: ${tokenJson.error || "unknown"}`);
    }
    // Decode the id_token (it's a JWT) to extract user info
    const idToken = tokenJson.id_token;
    const payloadB64 = idToken.split(".")[1];
    const userInfo = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
    const teamId = userInfo["https://slack.com/team_id"];
    const userId = userInfo["https://slack.com/user_id"];
    const name = userInfo.name || userInfo.given_name || "User";
    const email = userInfo.email;
    const picture = userInfo["https://slack.com/user_image_192"] || userInfo.picture;
    setSession(res, { teamId, userId, name, email, picture });
    res.clearCookie("pulse_oauth_state");
    res.redirect("/dashboard");
  } catch (e) {
    console.error("[auth] callback error", e);
    res.status(500).send("Auth error: " + e.message);
  }
});

expressApp.post("/auth/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

expressApp.get("/api/me", (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: "not authenticated" });
  res.json({ teamId: s.teamId, userId: s.userId, name: s.name, email: s.email, picture: s.picture, externalUserId: `slack:${s.teamId}:${s.userId}` });
});

// Static + page routes (after auth routes so they don't catch /auth/*)
expressApp.use(express.static("public"));
expressApp.get("/", (_req, res) => res.sendFile("index.html", { root: "public" }));
expressApp.get("/login", (_req, res) => res.sendFile("login.html", { root: "public" }));
expressApp.get("/dashboard", (req, res) => {
  // Allow first-install path (team+user in URL from Slack install) without a session
  if (!getSession(req) && !(req.query.team && req.query.user) && !req.query.installed) {
    return res.redirect("/login");
  }
  res.sendFile("dashboard.html", { root: "public" });
});

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

expressApp.get("/healthz", async (_req, res) => {
  try {
    const dbMs = await pingDb();
    res.json({ ok: true, dbMs });
  } catch (e) {
    res.status(503).json({ ok: false, error: e?.message || "db down" });
  }
});

// Detailed diagnostics for debugging
expressApp.get("/status", async (_req, res) => {
  const out = {
    uptime_seconds: Math.round((Date.now() - metrics.startedAt) / 1000),
    messages_handled: metrics.messages,
    errors: metrics.errors,
    routines_fired: metrics.routinesFired,
    last_error: metrics.lastError,
    memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    node_version: process.version,
    env: process.env.PIPEDREAM_ENVIRONMENT,
    db: { ok: false, ms: null },
  };
  try {
    out.db.ms = await pingDb();
    out.db.ok = true;
  } catch (e) {
    out.db.error = e?.message;
  }
  res.json(out);
});

// Invalidate the Pipedream account cache for the current session (call after connecting a new tool)
expressApp.post("/api/pipedream/invalidate-cache", (req, res) => {
  const externalUserId = req.body?.externalUserId;
  invalidateAccountCache(externalUserId);
  res.json({ ok: true });
});

// ----- Boot -----
const PORT = process.env.PORT || 3000;
(async () => {
  await initSchema();
  registerChat(chat);
  registerMetricsHook((name, val) => { if (name === "routinesFired") metrics.routinesFired += val; });
  startRunner();
  await app.start(PORT);
  console.log(`[pulse] running on :${PORT}`);
})();
