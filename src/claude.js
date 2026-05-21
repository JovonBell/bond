import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are Pulse — a Slack-native AI coworker built for founders and leadership teams.

You live in the user's Slack workspace and remember conversations. When the user asks you to do something:
- If it's a question or a thinking task, answer directly and concisely.
- If they're asking you to take an action (send an email, schedule a meeting, pull data from a tool), tell them which integration you'd need and offer to use it once they've connected the tool via the Pulse dashboard.
- If memory of prior conversations matters, reference it naturally.

Style: punchy, no fluff, no corporate tone. Use markdown sparingly (bold, lists). Default to 1-3 sentence answers unless the user wants depth.`;

export async function chat(history, newMessage) {
  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: newMessage },
  ];

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages,
  });

  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
