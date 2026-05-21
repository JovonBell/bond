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
