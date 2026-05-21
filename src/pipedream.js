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
  const payload = { external_user_id: externalUserId };
  if (app) payload.allowed_origins = undefined; // pass through
  const result = await pd.createConnectToken(payload);
  const token = result.token;
  const expiresAt = result.expires_at;
  // Build connect URL — Pipedream needs the app slug in the URL when not using the embedded SDK.
  let connectLinkUrl = result.connect_link_url || `https://pipedream.com/_static/connect.html?token=${token}`;
  if (app && !connectLinkUrl.includes("app=")) {
    const sep = connectLinkUrl.includes("?") ? "&" : "?";
    connectLinkUrl = `${connectLinkUrl}${sep}app=${encodeURIComponent(app)}`;
  }
  return { token, expiresAt, connectLinkUrl };
}

export async function listAccountsForUser(externalUserId) {
  try {
    const accounts = await pd.getAccounts({ external_user_id: externalUserId });
    return accounts?.data || accounts || [];
  } catch (e) {
    console.error("[pipedream] listAccounts error", e?.message);
    return [];
  }
}

export { pd };
