/**
 * 数据库迁移：8 张核心表（AGENTS.md 第 3 节）
 *   leads / customers / email_messages / replies / events / agent_runs / agent_run_steps / llm_calls
 *
 * migrations 表记录已执行的版本，可重复执行（幂等）。
 */
import type { Database } from 'better-sqlite3';

interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: '001_init_core_tables',
    sql: /* sql */ `
-- ============ 线索（原始导入数据） ============
CREATE TABLE IF NOT EXISTS leads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name  TEXT NOT NULL,
  contact_name  TEXT,
  email         TEXT NOT NULL,
  phone         TEXT,
  website       TEXT,
  industry      TEXT,
  country       TEXT,
  company_size  TEXT,
  source        TEXT NOT NULL DEFAULT 'manual',
  notes         TEXT,
  raw_payload   TEXT,
  score         INTEGER NOT NULL DEFAULT 0,
  score_reason  TEXT,
  dedupe_hash   TEXT NOT NULL UNIQUE,
  customer_id   INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_company ON leads(company_name);
CREATE INDEX IF NOT EXISTS idx_leads_customer ON leads(customer_id);

-- ============ 客户 ============
CREATE TABLE IF NOT EXISTS customers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name      TEXT NOT NULL,
  contact_name      TEXT,
  email             TEXT NOT NULL UNIQUE,
  phone             TEXT,
  website           TEXT,
  industry          TEXT,
  country           TEXT,
  company_size      TEXT,
  status            TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new','enriched','email_drafted','contacted','replied',
                                      'interested','needs_info','rejected','neutral',
                                      'meeting_booked','closed')),
  score             INTEGER NOT NULL DEFAULT 0,
  source            TEXT NOT NULL DEFAULT 'manual',
  notes             TEXT,
  last_contacted_at TEXT,
  last_replied_at   TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);
CREATE INDEX IF NOT EXISTS idx_customers_score ON customers(score DESC);
CREATE INDEX IF NOT EXISTS idx_customers_created ON customers(created_at DESC);

-- ============ 邮件记录 ============
CREATE TABLE IF NOT EXISTS email_messages (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id         INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  lead_id             INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  run_id              TEXT,
  direction           TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound','inbound')),
  subject             TEXT NOT NULL,
  body                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','failed')),
  model               TEXT,
  prompt_tokens       INTEGER NOT NULL DEFAULT 0,
  completion_tokens   INTEGER NOT NULL DEFAULT 0,
  latency_ms          INTEGER NOT NULL DEFAULT 0,
  mock                INTEGER NOT NULL DEFAULT 0 CHECK (mock IN (0,1)),
  provider_message_id TEXT,
  sent_at             TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_emails_customer ON email_messages(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_run ON email_messages(run_id);

-- ============ 客户回复 ============
CREATE TABLE IF NOT EXISTS replies (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id      INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  email_message_id INTEGER REFERENCES email_messages(id) ON DELETE SET NULL,
  run_id           TEXT,
  body             TEXT NOT NULL,
  intent           TEXT CHECK (intent IS NULL OR intent IN ('interested','needs_info','rejected','neutral')),
  confidence       REAL,
  sentiment        TEXT,
  summary          TEXT,
  suggested_action TEXT,
  needs_human      INTEGER NOT NULL DEFAULT 0 CHECK (needs_human IN (0,1)),
  classified       INTEGER NOT NULL DEFAULT 0 CHECK (classified IN (0,1)),
  model            TEXT,
  prompt_tokens    INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms       INTEGER NOT NULL DEFAULT 0,
  mock             INTEGER NOT NULL DEFAULT 0 CHECK (mock IN (0,1)),
  from_status      TEXT,
  to_status        TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_replies_customer ON replies(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_replies_intent ON replies(intent);
CREATE INDEX IF NOT EXISTS idx_replies_run ON replies(run_id);

-- ============ 事件（append-only） ============
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL DEFAULT 'status_changed',
  from_status TEXT,
  to_status   TEXT,
  trigger     TEXT NOT NULL DEFAULT 'system',
  run_id      TEXT,
  actor       TEXT NOT NULL DEFAULT 'system',
  payload     TEXT,
  request_id  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_events_customer ON events(customer_id, id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);

-- append-only 保证：物理层拦截 UPDATE / DELETE
CREATE TRIGGER IF NOT EXISTS events_no_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events 表是 append-only，禁止 UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS events_no_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events 表是 append-only，禁止 DELETE');
END;

-- ============ Agent 执行记录 ============
CREATE TABLE IF NOT EXISTS agent_runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id           TEXT NOT NULL UNIQUE,
  workflow         TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
  trigger          TEXT NOT NULL DEFAULT 'api',
  customer_id      INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  input            TEXT,
  output           TEXT,
  error            TEXT,
  steps_count      INTEGER NOT NULL DEFAULT 0,
  llm_calls_count  INTEGER NOT NULL DEFAULT 0,
  total_tokens     INTEGER NOT NULL DEFAULT 0,
  total_cost_usd   REAL NOT NULL DEFAULT 0,
  duration_ms      INTEGER NOT NULL DEFAULT 0,
  request_id       TEXT,
  started_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at      TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_customer ON agent_runs(customer_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);

-- ============ Agent 每一步 ============
CREATE TABLE IF NOT EXISTS agent_run_steps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL,
  step_index  INTEGER NOT NULL,
  tool        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'succeeded' CHECK (status IN ('succeeded','failed')),
  input       TEXT,
  output      TEXT,
  error       TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_steps_run ON agent_run_steps(run_id, step_index);

-- ============ LLM 调用记录 ============
CREATE TABLE IF NOT EXISTS llm_calls (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            TEXT,
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  operation         TEXT NOT NULL,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success','error','fallback')),
  attempt           INTEGER NOT NULL DEFAULT 1,
  mock              INTEGER NOT NULL DEFAULT 0 CHECK (mock IN (0,1)),
  error             TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_llm_calls_run ON llm_calls(run_id);
CREATE INDEX IF NOT EXISTS idx_llm_calls_status ON llm_calls(status);
CREATE INDEX IF NOT EXISTS idx_llm_calls_created ON llm_calls(created_at DESC);
`,
  },
  {
    id: 2,
    name: '002_seed_dedupe_helpers',
    sql: /* sql */ `
-- 线索去重查询加速（email + company 组合哈希已在应用层计算）
CREATE INDEX IF NOT EXISTS idx_leads_dedupe ON leads(dedupe_hash);
-- 看板统计加速
CREATE INDEX IF NOT EXISTS idx_customers_status_updated ON customers(status, updated_at DESC);
`,
  },
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.id ?? 0;

interface MigrationRow {
  id: number;
  name: string;
  applied_at: string;
}

export interface MigrationResult {
  applied: number[];
  skipped: number[];
  version: number;
}

/**
 * 执行迁移：已执行的版本跳过，未执行的按 id 升序执行并记录。
 */
export const applyMigrations = (db: Database): MigrationResult => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);

  const rows = db
    .prepare('SELECT id, name, applied_at FROM schema_migrations')
    .all() as MigrationRow[];
  const appliedIds = new Set(rows.map((row) => row.id));

  const applied: number[] = [];
  const skipped: number[] = [];

  for (const migration of [...MIGRATIONS].sort((a, b) => a.id - b.id)) {
    if (appliedIds.has(migration.id)) {
      skipped.push(migration.id);
      continue;
    }
    const run = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)').run(
        migration.id,
        migration.name,
      );
    });
    run();
    applied.push(migration.id);
  }

  return { applied, skipped, version: CURRENT_SCHEMA_VERSION };
};

export const getSchemaVersion = (db: Database): number => {
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .get() as { name: string } | undefined;
  if (!hasTable) return 0;
  const row = db.prepare('SELECT MAX(id) AS version FROM schema_migrations').get() as
    { version: number | null } | undefined;
  return row?.version ?? 0;
};

export const listTables = (db: Database): string[] =>
  (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);

export default applyMigrations;
