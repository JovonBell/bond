import Anthropic from "@anthropic-ai/sdk";
import { getAccessToken, buildMcpUrl, listAccountsForUser } from "./pipedream.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

function buildSystemPrompt() {
  const now = new Date();
  const longDate = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  });
  const isoDate = now.toISOString().slice(0, 10);
  const isoFull = now.toISOString();

  return `You are Pulse — a Slack-native AI coworker built for founders and leadership teams.

CURRENT DATE AND TIME (THIS IS REAL, NOT TRAINING DATA):
- Today is ${longDate}
- ISO date: ${isoDate}
- Full ISO timestamp (UTC): ${isoFull}
- When tools accept date queries (Gmail's "after:", Calendar ranges, etc.), use these dates — they are the real current time, not your training cutoff.
- NEVER tell the user a tool is broken because you think it's a different year. Trust this date.

You live in the user's Slack workspace and remember conversations. You can also USE tools the user has connected via Pipedream (Gmail, Calendar, Fathom, Notion, Linear, HubSpot, GitHub, etc.) — invoke them when the user asks for action.

Rules:
- If the user asks you to take an action and you have a tool for it, USE THE TOOL. Don't just describe what you'd do.
- When searching emails / calendar / docs, always use the CURRENT DATE above for queries like "today", "this week", "recent".
- If the user asks for something that needs a tool they haven't connected, tell them which app to connect at the dashboard.
- For destructive actions (send email, delete, post publicly), confirm with the user first by stating what you're about to do — then act on confirmation.
- Style: punchy, no fluff, no corporate tone. Markdown sparingly. Default to 1-3 sentence answers unless depth is asked for.`;
}

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
    system: buildSystemPrompt(),
    messages,
  };

  let response;
  if (mcpConfig) {
    try {
      console.log(`[claude] calling beta API with ${mcpConfig.servers.length} MCP servers`);
      response = await client.beta.messages.create({
        ...request,
        mcp_servers: mcpConfig.servers,
        tools: mcpConfig.tools,
        betas: ["mcp-client-2025-11-20"],
      });
    } catch (e) {
      console.error(`[claude] beta MCP call failed: ${e?.message}`, e?.status, e?.error);
      // Fallback to plain chat so the user still gets a response.
      response = await client.messages.create(request);
    }
  } else {
    response = await client.messages.create(request);
  }

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return text || "(I got your message but didn't generate a response — check the logs)";
}

async function buildPipedreamMcpConfig(externalUserId) {
  if (!externalUserId) return null;
  try {
    console.log(`[claude] looking up Pipedream accounts for ${externalUserId}`);
    const accounts = await listAccountsForUser(externalUserId);
    console.log(`[claude] found ${accounts.length} accounts`);
    if (!accounts.length) return null;

    const appSlugs = [...new Set(
      accounts.map((a) => a.app?.name_slug).filter(Boolean),
    )];
    console.log(`[claude] unique app slugs: ${appSlugs.join(", ")}`);
    if (!appSlugs.length) return null;

    const accessToken = await getAccessToken();
    console.log(`[claude] got access token (len=${accessToken?.length})`);

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

    console.log(`[claude] built ${servers.length} MCP server configs`);
    return { servers, tools };
  } catch (e) {
    console.error(`[claude] mcp config error: ${e?.message}`);
    return null;
  }
}
