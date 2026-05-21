import { createBackendClient } from "@pipedream/sdk/server";

const pd = createBackendClient({
  environment: process.env.PIPEDREAM_ENVIRONMENT || "development",
  credentials: {
    clientId: process.env.PIPEDREAM_CLIENT_ID,
    clientSecret: process.env.PIPEDREAM_CLIENT_SECRET,
  },
  projectId: process.env.PIPEDREAM_PROJECT_ID,
});

export async function createConnectToken(externalUserId, app) {
  const result = await pd.createConnectToken({ external_user_id: externalUserId });
  const token = result.token;
  const expiresAt = result.expires_at;
  let connectLinkUrl = result.connect_link_url || `https://pipedream.com/_static/connect.html?token=${token}`;
  if (app && !connectLinkUrl.includes("app=")) {
    const sep = connectLinkUrl.includes("?") ? "&" : "?";
    connectLinkUrl = `${connectLinkUrl}${sep}app=${encodeURIComponent(app)}`;
  }
  return { token, expiresAt, connectLinkUrl };
}

export async function listAccountsForUser(externalUserId) {
  try {
    const result = await pd.getAccounts({ external_user_id: externalUserId });
    return result?.data || [];
  } catch (e) {
    console.error("[pipedream] listAccounts error", e?.message);
    return [];
  }
}

// In-memory cache (60s TTL) to avoid re-querying Pipedream on every Slack message
const _accountCache = new Map();
const ACCOUNT_TTL = 60_000;

export async function listAccountsCached(externalUserId) {
  const cached = _accountCache.get(externalUserId);
  if (cached && Date.now() - cached.t < ACCOUNT_TTL) return cached.accounts;
  const accounts = await listAccountsForUser(externalUserId);
  _accountCache.set(externalUserId, { accounts, t: Date.now() });
  return accounts;
}

export function invalidateAccountCache(externalUserId) {
  if (externalUserId) _accountCache.delete(externalUserId);
  else _accountCache.clear();
}

export async function deleteAccountsForAppSlug(externalUserId, appSlug) {
  const accounts = await listAccountsForUser(externalUserId);
  const matching = accounts.filter((a) => a.app?.name_slug === appSlug);
  for (const acc of matching) {
    await pd.deleteAccount(acc.id);
  }
  invalidateAccountCache(externalUserId);
  return matching.length;
}

// Cache the access token too (Pipedream tokens are valid ~4 hours)
let _tokenCache = null;
const TOKEN_TTL = 30 * 60_000; // re-fetch every 30 min, well before 4hr expiry

export async function getCachedAccessToken() {
  if (_tokenCache && Date.now() - _tokenCache.t < TOKEN_TTL) return _tokenCache.token;
  const token = await pd.rawAccessToken();
  _tokenCache = { token, t: Date.now() };
  return token;
}

// Returns the raw Pipedream developer access token to use as a Bearer token
// when calling Pipedream's MCP server.
export async function getAccessToken() {
  return await pd.rawAccessToken();
}

// Build Pipedream MCP server URL for a specific user (and optional app slug).
// Pipedream MCP returns the user's connected tools for any apps they've authorized.
export function buildMcpUrl(externalUserId, app) {
  const params = new URLSearchParams({
    projectId: process.env.PIPEDREAM_PROJECT_ID,
    environment: process.env.PIPEDREAM_ENVIRONMENT || "development",
    externalUserId,
  });
  if (app) params.set("app", app);
  return `https://remote.mcp.pipedream.net/v3?${params.toString()}`;
}

export { pd };
