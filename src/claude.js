import Anthropic from "@anthropic-ai/sdk";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { buildMcpUrl, listAccountsCached, getCachedAccessToken } from "./pipedream.js";
import * as db from "./db.js";
import { computeNextRun, validateCron } from "./routines.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

function buildSystemPrompt() {
  const now = new Date();
  const longDate = now.toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
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

You live in the user's Slack workspace and remember conversations. You can:
1. USE tools from Pipedream MCP (Gmail, Calendar, Fathom, Notion, Linear, etc.) — invoke them when the user asks for action.
2. MANAGE recurring ROUTINES via native tools: create_routine, list_routines, pause_routine, resume_routine, delete_routine.
   - A routine is a scheduled prompt that fires automatically (cron-based).
   - Use create_routine when the user says "every Monday", "daily", "every morning at 8", etc.
   - Cron is 5 fields in UTC: minute hour day-of-month month day-of-week.
   - Default user timezone is America/New_York (EST/EDT). Convert: 8am EST = 13:00 UTC; 8am EDT = 12:00 UTC. Currently in DAYLIGHT TIME so add 4 hours to EST hours.
   - Example: "every Monday at 8am" → "0 12 * * 1" (during EDT) or "0 13 * * 1" (during EST).
3. BUILD PRESENTATIONS via the create_presentation native tool. When the user asks for a deck, slides, or a presentation (e.g., "make me a deck on X", "presentation from my last meeting with Y"):
   a. FETCH the source material first — Calendar for events, Fathom for meeting transcripts, Gmail/Drive for docs. Use real data, not invented content.
   b. SYNTHESIZE into 5–10 slides. One idea per slide. Punchy title slide. End with action items / next steps.
   c. CALL create_presentation with reveal.js <section>...</section> syntax. Pulse wraps it in a polished dark theme.
   d. REPLY with just a one-line confirmation + the URL. Example: "Done. 7 slides → {url}". Do NOT paste the slide HTML into Slack.

Rules:
- If the user asks you to take an action and you have a tool for it, USE THE TOOL. Don't just describe what you'd do.
- For destructive actions (send email, delete, post publicly), confirm with the user first. Creating a presentation is NOT destructive — just do it.
- Style: punchy, no fluff. Markdown sparingly. Default to 1-3 sentence answers unless depth is asked for.
- When you create or modify a routine, confirm what you did and translate the cron into human-readable English.`;
}

// ----- Native routine tools (executed by Pulse, not Pipedream) -----
const ROUTINE_TOOLS = [
  {
    name: "create_routine",
    description: "Create a recurring scheduled task that fires automatically on a cron schedule. When it fires, the prompt is sent to Pulse with full access to the user's connected tools, and the result is posted to their Slack DM.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short human-readable name (e.g. 'Daily email brief')." },
        cron: { type: "string", description: "Cron expression in UTC. 5 fields: minute hour day-of-month month day-of-week. Examples: '0 12 * * *' = every day at noon UTC; '0 13 * * 1' = Mondays at 1pm UTC." },
        prompt: { type: "string", description: "What Pulse should do when this routine fires. Write it as a direct command. Example: 'Pull overnight emails from the last 12 hours and brief me on what matters.'" },
      },
      required: ["name", "cron", "prompt"],
    },
  },
  {
    name: "list_routines",
    description: "List all of the user's scheduled routines (active and paused).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "pause_routine",
    description: "Pause a routine so it stops firing on schedule. Can be resumed later.",
    input_schema: {
      type: "object",
      properties: { id: { type: "integer", description: "The routine ID to pause." } },
      required: ["id"],
    },
  },
  {
    name: "resume_routine",
    description: "Resume a previously paused routine.",
    input_schema: {
      type: "object",
      properties: { id: { type: "integer", description: "The routine ID to resume." } },
      required: ["id"],
    },
  },
  {
    name: "delete_routine",
    description: "Permanently delete a routine.",
    input_schema: {
      type: "object",
      properties: { id: { type: "integer", description: "The routine ID to delete." } },
      required: ["id"],
    },
  },
  {
    name: "create_presentation",
    description: `Generate a polished, shareable HTML slide deck. Use this whenever the user asks for a presentation, deck, slides, or "make me a deck."

How to use it:
- Write the slides as raw <section>...</section> blocks (reveal.js syntax). Each <section> is one slide.
- Pulse wraps your content in a sleek dark-themed presentation template and returns a public URL.
- Keep it tight: 5–10 slides max. One idea per slide. Lead with a punchy title slide. End with action items / next steps.
- Use <h1> for the title slide, <h2> for section headers, <p> and <ul><li> for body content. Avoid heavy inline styles — the template handles styling.
- The tool returns a URL. Send the URL to the user. Do NOT paste the slide HTML into Slack.`,
    input_schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short presentation title (used in the browser tab and as a filename hint). e.g. 'Chloe sync — May 21'.",
        },
        slides_html: {
          type: "string",
          description: "The slide content as <section>...</section> blocks. Example: '<section><h1>Q3 recap</h1><p>Strong quarter</p></section><section><h2>Wins</h2><ul><li>Closed Acme</li></ul></section>'",
        },
      },
      required: ["title", "slides_html"],
    },
  },
];

function wrapDeckHtml(title, slidesHtml) {
  const safeTitle = String(title || "Pulse Deck").replace(/[<>]/g, "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reset.css" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.css" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/theme/black.css" id="theme" />
  <style>
    :root { --accent: #7c5cff; }
    html, body { background: #0a0a0f; }
    .reveal {
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif;
      letter-spacing: -0.01em;
    }
    .reveal h1, .reveal h2, .reveal h3 {
      color: #fff;
      font-weight: 700;
      text-transform: none;
      letter-spacing: -0.02em;
      margin-bottom: 0.4em;
    }
    .reveal h1 { font-size: 3.4em; line-height: 1.05; }
    .reveal h2 { font-size: 2.2em; line-height: 1.1; }
    .reveal h3 { font-size: 1.4em; color: var(--accent); }
    .reveal p, .reveal li { color: #d6d6e0; font-size: 1.1em; line-height: 1.5; }
    .reveal .slides section { text-align: left; padding: 0 4%; }
    .reveal .slides section.title-slide,
    .reveal .slides > section:first-child { text-align: center; }
    .reveal ul { display: block; margin-left: 1em; }
    .reveal li + li { margin-top: 0.45em; }
    .reveal strong { color: #fff; }
    .reveal em { color: var(--accent); font-style: normal; }
    .reveal a { color: var(--accent); }
    .reveal blockquote {
      border-left: 3px solid var(--accent);
      padding: 0.2em 1em;
      background: rgba(124,92,255,0.06);
      font-style: normal;
    }
    .reveal .progress { color: var(--accent); }
    .reveal .controls { color: var(--accent); }
    .pulse-watermark {
      position: fixed;
      bottom: 14px;
      right: 18px;
      font-family: -apple-system, "SF Mono", Menlo, monospace;
      font-size: 11px;
      color: #555;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      z-index: 100;
    }
    .pulse-watermark .dot { color: var(--accent); }
  </style>
</head>
<body>
  <div class="reveal">
    <div class="slides">
${slidesHtml}
    </div>
  </div>
  <div class="pulse-watermark">made by pulse <span class="dot">●</span></div>
  <script src="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.js"></script>
  <script>
    Reveal.initialize({
      hash: true,
      controls: true,
      progress: true,
      transition: "slide",
      slideNumber: "c/t",
    });
  </script>
</body>
</html>`;
}

async function generateDeckId() {
  return crypto.randomBytes(6).toString("hex");
}

async function executeRoutineTool(name, input, ctx) {
  const { teamId, userId } = ctx;
  switch (name) {
    case "create_routine": {
      if (!validateCron(input.cron)) {
        return { ok: false, error: `Invalid cron expression: "${input.cron}". Use 5 fields like "0 12 * * *".` };
      }
      const next = computeNextRun(input.cron);
      const r = await db.createRoutine(teamId, userId, input.name, input.cron, input.prompt, next);
      return {
        ok: true,
        id: r.id,
        name: r.name,
        cron: r.cron_expr,
        next_run_utc: next.toISOString(),
        next_run_local: next.toLocaleString("en-US", { timeZone: "America/New_York", timeStyle: "short", dateStyle: "medium" }),
      };
    }
    case "list_routines": {
      const list = await db.listRoutines(teamId, userId);
      return { ok: true, count: list.length, routines: list.map((r) => ({
        id: r.id, name: r.name, cron: r.cron_expr, prompt: r.prompt,
        enabled: r.enabled,
        next_run_local: r.next_run ? new Date(r.next_run).toLocaleString("en-US", { timeZone: "America/New_York", timeStyle: "short", dateStyle: "medium" }) : null,
        last_run_local: r.last_run ? new Date(r.last_run).toLocaleString("en-US", { timeZone: "America/New_York", timeStyle: "short", dateStyle: "medium" }) : null,
      })) };
    }
    case "pause_routine": {
      const r = await db.setRoutineEnabled(input.id, teamId, userId, false);
      return r ? { ok: true, paused: r.id } : { ok: false, error: "Routine not found or not yours." };
    }
    case "resume_routine": {
      const r = await db.setRoutineEnabled(input.id, teamId, userId, true);
      return r ? { ok: true, resumed: r.id } : { ok: false, error: "Routine not found or not yours." };
    }
    case "delete_routine": {
      const ok = await db.deleteRoutine(input.id, teamId, userId);
      return ok ? { ok: true, deleted: input.id } : { ok: false, error: "Routine not found or not yours." };
    }
    case "create_presentation": {
      const slides = String(input.slides_html || "").trim();
      if (!slides) return { ok: false, error: "slides_html is required and must contain at least one <section>...</section> block." };
      const id = await generateDeckId();
      const html = wrapDeckHtml(input.title, slides);
      const dir = path.join(process.cwd(), "public", "decks");
      try {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, `${id}.html`), html, "utf8");
      } catch (e) {
        return { ok: false, error: `Failed to write deck: ${e.message}` };
      }
      const base = process.env.APP_URL || "";
      const url = `${base.replace(/\/$/, "")}/decks/${id}.html`;
      const slideCount = (slides.match(/<section[\s>]/gi) || []).length;
      return { ok: true, id, title: input.title, url, slides: slideCount };
    }
  }
  return { ok: false, error: `Unknown tool: ${name}` };
}

export async function chat({ history, newMessage, externalUserId }) {
  const baseMessages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: newMessage },
  ];

  // Parse teamId/userId from externalUserId for routine ownership
  let ctx = { teamId: null, userId: null };
  if (externalUserId && externalUserId.startsWith("slack:")) {
    const [, teamId, userId] = externalUserId.split(":");
    ctx = { teamId, userId };
  }

  const mcpConfig = await buildPipedreamMcpConfig(externalUserId);
  const canUseRoutineTools = !!(ctx.teamId && ctx.userId);

  // Build tool list
  const tools = [];
  if (mcpConfig) tools.push(...mcpConfig.tools);
  if (canUseRoutineTools) tools.push(...ROUTINE_TOOLS);

  // If we have any tools, use beta API; otherwise use plain.
  if (tools.length === 0) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: buildSystemPrompt(),
      messages: baseMessages,
    });
    return extractText(response);
  }

  // Tool-use loop. Up to 6 turns to avoid runaways.
  const messages = [...baseMessages];
  for (let turn = 0; turn < 6; turn++) {
    let response;
    try {
      response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 1500,
        system: buildSystemPrompt(),
        messages,
        ...(mcpConfig ? { mcp_servers: mcpConfig.servers } : {}),
        tools,
        betas: ["mcp-client-2025-11-20"],
      });
    } catch (e) {
      console.error(`[claude] beta call failed turn ${turn}:`, e?.message);
      // Fallback once to plain chat
      const fallback = await client.messages.create({
        model: MODEL,
        max_tokens: 1500,
        system: buildSystemPrompt(),
        messages: baseMessages,
      });
      return extractText(fallback);
    }

    if (response.stop_reason !== "tool_use") {
      return extractText(response) || "(no response)";
    }

    // Find native tool_use blocks (Pipedream MCP tool calls are handled by Anthropic transparently)
    const nativeToolUses = response.content.filter(
      (b) => b.type === "tool_use" && ROUTINE_TOOLS.some((t) => t.name === b.name),
    );

    if (nativeToolUses.length === 0) {
      // All tool_use blocks are MCP (handled by Anthropic) — return text content
      return extractText(response) || "(no response)";
    }

    // Append the assistant message and execute native tools
    messages.push({ role: "assistant", content: response.content });
    const toolResults = [];
    for (const tu of nativeToolUses) {
      const result = await executeRoutineTool(tu.name, tu.input || {}, ctx);
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(result),
        is_error: !result.ok,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return "(routine tool loop exceeded max turns)";
}

function extractText(response) {
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

async function buildPipedreamMcpConfig(externalUserId) {
  if (!externalUserId) return null;
  try {
    const accounts = await listAccountsCached(externalUserId);
    if (!accounts.length) return null;
    const appSlugs = [...new Set(accounts.map((a) => a.app?.name_slug).filter(Boolean))];
    if (!appSlugs.length) return null;
    const accessToken = await getCachedAccessToken();
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
    console.error(`[claude] mcp config error: ${e?.message}`);
    return null;
  }
}
