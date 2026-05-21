import { createBackendClient } from "@pipedream/sdk/server";

const pd = createBackendClient({
  environment: process.env.PIPEDREAM_ENVIRONMENT || "development",
  credentials: {
    clientId: process.env.PIPEDREAM_CLIENT_ID,
    clientSecret: process.env.PIPEDREAM_CLIENT_SECRET,
  },
  projectId: process.env.PIPEDREAM_PROJECT_ID,
});

export async function createConnectToken(externalUserId) {
  const { token, expires_at, connect_link_url } = await pd.createConnectToken({
    external_user_id: externalUserId,
  });
  return { token, expiresAt: expires_at, connectLinkUrl: connect_link_url };
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
