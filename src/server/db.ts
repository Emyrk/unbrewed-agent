import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  values?: unknown[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, values);
}

export async function migrate(): Promise<void> {
  const q = (text: string) => getPool().query(text);
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      discord_id    TEXT UNIQUE NOT NULL,
      username      TEXT NOT NULL,
      avatar_url    TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await q(`
    CREATE TABLE IF NOT EXISTS sessions (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id),
      expires_at    TIMESTAMPTZ NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await q(`
    CREATE TABLE IF NOT EXISTS games (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id         TEXT NOT NULL REFERENCES users(id),
      status          TEXT NOT NULL DEFAULT 'active',
      room_id         TEXT NOT NULL,
      our_seat        TEXT,
      our_hero        TEXT NOT NULL,
      opponent_hero   TEXT,
      map_title       TEXT,
      llm_model       TEXT NOT NULL,
      format          TEXT NOT NULL DEFAULT 'duel',

      winner          TEXT,
      won             BOOLEAN,
      total_turns     INT,
      total_actions   INT,
      total_cost_usd  NUMERIC(10,6) DEFAULT 0,

      analysis_summary  TEXT,
      analysis_mistakes TEXT,
      analysis_lessons  TEXT,

      error_message   TEXT,
      started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at        TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await q(`
    CREATE TABLE IF NOT EXISTS game_actions (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      game_id           UUID NOT NULL REFERENCES games(id),
      action_index      INT NOT NULL,
      turn_number       INT,

      legal_action_count INT,
      chosen_index      INT,
      choice_source     TEXT NOT NULL,
      confidence        NUMERIC(4,2),
      reason            TEXT,

      prompt_tokens     INT,
      completion_tokens INT,
      cost_usd          NUMERIC(10,6),
      latency_ms        INT,

      created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await q(`ALTER TABLE game_actions ADD COLUMN IF NOT EXISTS cache_read_tokens INT;`);
  await q(`ALTER TABLE game_actions ADD COLUMN IF NOT EXISTS cache_write_tokens INT;`);
  await q(`ALTER TABLE game_actions ADD COLUMN IF NOT EXISTS total_tokens INT;`);
  await q(`ALTER TABLE game_actions ADD COLUMN IF NOT EXISTS system_prompt TEXT;`);
  await q(`ALTER TABLE game_actions ADD COLUMN IF NOT EXISTS user_prompt TEXT;`);
  await q(`ALTER TABLE game_actions ADD COLUMN IF NOT EXISTS model_output TEXT;`);
  await q(`ALTER TABLE game_actions ADD COLUMN IF NOT EXISTS selected_action JSONB;`);
  await q(`ALTER TABLE game_actions ADD COLUMN IF NOT EXISTS error_message TEXT;`);
  await q(`CREATE INDEX IF NOT EXISTS idx_game_actions_game ON game_actions(game_id);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_games_user ON games(user_id);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);`);
  console.log('Database migrations complete');
}
