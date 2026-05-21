import Anthropic from "@anthropic-ai/sdk";
import { getAccessToken, buildMcpUrl, listAccountsForUser } from "./pipedream.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are Pulse — a Slack-native AI coworker built for founders and leadership teams.

You live in the user's Slack workspace and remember conversations. You can also USE tools the user has connected via Pipedream (Gmail, Calendar, Fathom, Notion, Linear, HubSpot, GitHub, etc.) — invoke them when the user asks for action.

Rules:
- If the user asks you to take an action and you have a tool for it, USE THE TOOL. Don't just describe what you'd do.
- If the user asks for something that needs a tool they haven't connected, tell them which app to connect at the dashboard.
- For destructive actions (send email, delete, post publicly), confirm with the user first by stating what you're about to do — then act on confirmation.
- Style: punchy, no fluff, no corporate tone. Markdown sparingly. Default to 1-3 sentence answers unless depth is asked for.`;

export async function chat({ history, newMessage, externalUserId }) {
  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: newMessage },
  ];

  // If we have an external user ID, attach Pipedream MCP for their connected tools.
  const mcpConfig = await buildPipedreamMcpConfig(externalUserId);

  const request = {
    model: MODEL,
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages,
  };

  let response;
  if (mcpConfig) {
    request.mcp_servers = mcpConfig.servers;
    request.tools = mcpConfig.tools;
    response = await client.beta.messages.create(
      { ...request, betas: ["mcp-client-2025-11-20"] },
    );
  } else {
    response = await client.messages.create(request);
  }

  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim() || "(no response)";
}

async function buildPipedreamMcpConfig(externalUserId) {
  if (!externalUserId) return null;
  try {
    const accounts = await listAccountsForUser(externalUserId);
    if (!accounts.length) return null;

    // Group by unique app slug
    const appSlugs = [...new Set(
      accounts.map((a) => a.app?.name_slug).filter(Boolean),
    )];
    if (!appSlugs.length) return null;

    const accessToken = await getAccessToken();

    const servers = appSlugs.map((slug) => ({
      type: "url",
      url: buildMcpUrl(externalUserId, slug),
      name: `pd-${slug}`,
      authorization_token: accessToken,
    }));
    const tools = appSlugs.map((slug) => ({
      type: "mcp_toolset",
      mcp_server_name: `pd-${slug}`,
    }));

    return { servers, tools };
  } catch (e) {
    console.error("[claude] mcp config error", e?.message);
    return null;
  }
}
