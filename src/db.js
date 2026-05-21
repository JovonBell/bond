import pg from "pg";
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway")
    ? { rejectUnauthorized: false }
    : false,
});

export async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS installations (
      team_id TEXT PRIMARY KEY,
      team_name TEXT,
      bot_token TEXT NOT NULL,
      bot_user_id TEXT NOT NULL,
      installed_by TEXT,
      installed_at TIMESTAMPTZ DEFAULT NOW(),
      pipedream_external_user_id TEXT
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS conversations_team_user_idx
      ON conversations(team_id, user_id, created_at);

    CREATE TABLE IF NOT EXISTS connected_accounts (
      id SERIAL PRIMARY KEY,
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      app_slug TEXT NOT NULL,
      pipedream_account_id TEXT,
      connected_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS routines (
      id SERIAL PRIMARY KEY,
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      cron_expr TEXT NOT NULL,
      prompt TEXT NOT NULL,
      enabled BOOLEAN DEFAULT TRUE,
      last_run TIMESTAMPTZ,
      next_run TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS routines_due_idx
      ON routines (next_run) WHERE enabled = TRUE;
  `);
  console.log("[db] schema ready");
}

export async function saveInstall(install) {
  await pool.query(
    `INSERT INTO installations (team_id, team_name, bot_token, bot_user_id, installed_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (team_id) DO UPDATE SET
       team_name = EXCLUDED.team_name,
       bot_token = EXCLUDED.bot_token,
       bot_user_id = EXCLUDED.bot_user_id,
       installed_by = EXCLUDED.installed_by`,
    [
      install.team.id,
      install.team.name,
      install.bot.token,
      install.bot.userId,
      install.user.id,
    ],
  );
}

export async function getInstall(teamId) {
  const { rows } = await pool.query(
    `SELECT * FROM installations WHERE team_id = $1`,
    [teamId],
  );
  return rows[0] || null;
}

export async function appendMessage(teamId, userId, role, content) {
  await pool.query(
    `INSERT INTO conversations (team_id, user_id, role, content) VALUES ($1,$2,$3,$4)`,
    [teamId, userId, role, content],
  );
}

export async function getRecentMessages(teamId, userId, limit = 20) {
  const { rows } = await pool.query(
    `SELECT role, content FROM conversations
     WHERE team_id=$1 AND user_id=$2
     ORDER BY created_at DESC LIMIT $3`,
    [teamId, userId, limit],
  );
  return rows.reverse();
}

export async function clearConversation(teamId, userId) {
  await pool.query(
    `DELETE FROM conversations WHERE team_id=$1 AND user_id=$2`,
    [teamId, userId],
  );
}

// ----- Routines CRUD -----
export async function createRoutine(teamId, userId, name, cronExpr, prompt, nextRun) {
  const { rows } = await pool.query(
    `INSERT INTO routines (team_id, user_id, name, cron_expr, prompt, next_run)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [teamId, userId, name, cronExpr, prompt, nextRun],
  );
  return rows[0];
}

export async function listRoutines(teamId, userId) {
  const { rows } = await pool.query(
    `SELECT id, name, cron_expr, prompt, enabled, last_run, next_run, created_at
     FROM routines WHERE team_id=$1 AND user_id=$2 ORDER BY id DESC`,
    [teamId, userId],
  );
  return rows;
}

export async function getRoutine(id) {
  const { rows } = await pool.query(`SELECT * FROM routines WHERE id=$1`, [id]);
  return rows[0] || null;
}

export async function setRoutineEnabled(id, teamId, userId, enabled) {
  const { rows } = await pool.query(
    `UPDATE routines SET enabled=$1 WHERE id=$2 AND team_id=$3 AND user_id=$4 RETURNING *`,
    [enabled, id, teamId, userId],
  );
  return rows[0] || null;
}

export async function deleteRoutine(id, teamId, userId) {
  const { rowCount } = await pool.query(
    `DELETE FROM routines WHERE id=$1 AND team_id=$2 AND user_id=$3`,
    [id, teamId, userId],
  );
  return rowCount > 0;
}

export async function getDueRoutines() {
  const { rows } = await pool.query(
    `SELECT * FROM routines WHERE enabled=TRUE AND next_run <= NOW() ORDER BY next_run ASC LIMIT 50`,
  );
  return rows;
}

export async function updateRoutineAfterRun(id, lastRun, nextRun) {
  await pool.query(
    `UPDATE routines SET last_run=$1, next_run=$2 WHERE id=$3`,
    [lastRun, nextRun, id],
  );
}
