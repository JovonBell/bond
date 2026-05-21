import cron from "node-cron";
import { CronExpressionParser } from "cron-parser";
import { WebClient } from "@slack/web-api";
import * as db from "./db.js";

export function computeNextRun(cronExpr, from = new Date()) {
  const i = CronExpressionParser.parse(cronExpr, { currentDate: from, tz: "UTC" });
  return i.next().toDate();
}

export function validateCron(cronExpr) {
  try {
    CronExpressionParser.parse(cronExpr);
    return true;
  } catch { return false; }
}

let chatFn = null;
export function registerChat(fn) { chatFn = fn; }

export function startRunner() {
  cron.schedule("* * * * *", async () => {
    try {
      const due = await db.getDueRoutines();
      if (due.length === 0) return;
      console.log(`[routines] firing ${due.length} due routine(s)`);
      for (const r of due) {
        fireRoutine(r).catch((e) =>
          console.error(`[routines] routine ${r.id} fire error`, e?.message),
        );
      }
    } catch (e) { console.error("[routines] tick error", e?.message); }
  });
  console.log("[routines] runner started — checks every minute");
}

async function fireRoutine(routine) {
  console.log(`[routines] firing #${routine.id} "${routine.name}" for ${routine.team_id}:${routine.user_id}`);

  // Pre-update next_run so we don't re-fire if this run takes a while
  const now = new Date();
  let next;
  try { next = computeNextRun(routine.cron_expr, now); }
  catch (e) {
    console.error(`[routines] bad cron "${routine.cron_expr}":`, e.message);
    // Disable malformed routine
    await db.setRoutineEnabled(routine.id, routine.team_id, routine.user_id, false);
    return;
  }
  await db.updateRoutineAfterRun(routine.id, now, next);

  // Get bot token + open DM
  const install = await db.getInstall(routine.team_id);
  if (!install) {
    console.error(`[routines] no install for team ${routine.team_id}`);
    return;
  }
  const slack = new WebClient(install.bot_token);
  let channel;
  try {
    const dm = await slack.conversations.open({ users: routine.user_id });
    channel = dm.channel.id;
  } catch (e) {
    console.error(`[routines] could not open DM with ${routine.user_id}`, e?.data?.error || e?.message);
    return;
  }

  // Run Claude with the routine's prompt + Pipedream MCP tools
  if (!chatFn) {
    console.error("[routines] chat fn not registered");
    return;
  }
  const externalUserId = `slack:${routine.team_id}:${routine.user_id}`;
  let reply;
  try {
    reply = await chatFn({
      history: [],
      newMessage: routine.prompt,
      externalUserId,
    });
  } catch (e) {
    console.error(`[routines] chat error for routine ${routine.id}`, e?.message);
    reply = `(routine "${routine.name}" failed: ${e?.message || "unknown error"})`;
  }

  try {
    await slack.chat.postMessage({
      channel,
      text: `🔔 *${routine.name}*\n\n${reply}`,
      unfurl_links: false,
      unfurl_media: false,
    });
    if (metricsHook) metricsHook("routinesFired", 1);
  } catch (e) {
    console.error(`[routines] post failed`, e?.data?.error || e?.message);
  }
}

let metricsHook = null;
export function registerMetricsHook(fn) { metricsHook = fn; }
