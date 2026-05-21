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
