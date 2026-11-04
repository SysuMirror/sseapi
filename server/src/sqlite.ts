import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { config } from './config.js'

/**
 * SQLite 存储层。
 *
 * 为什么换掉 JSON：
 *  - 旧实现把全部用量/流水读进内存（20 万行 ≈ 280MB 常驻），再在 JS 里 filter，
 *    数据量再涨就只能靠加内存，且每次进程启动都要重新解析一遍。
 *  - 现在：明细表只存在于 SQLite，查询走索引；进程内存与历史总量无关。
 *
 * better-sqlite3 是同步 API，正好匹配现有「同步读写 store」的代码结构，
 * 不需要把整条调用链改成 async。
 */

export type SqliteDb = Database.Database

let db: SqliteDb | null = null

export function dbPath(): string {
  return path.join(config.dataDir, 'sseapi.db')
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  oauth_id      TEXT NOT NULL UNIQUE,
  sse_user_id   TEXT NOT NULL DEFAULT '',

  name          TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL DEFAULT '',
  avatar_url    TEXT NOT NULL DEFAULT '',
  is_admin      INTEGER NOT NULL DEFAULT 0,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  admin_note    TEXT NOT NULL DEFAULT '',
  rpm_limit     INTEGER NOT NULL DEFAULT 0,
  max_concurrent INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS api_keys (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL,
  name            TEXT NOT NULL DEFAULT '',
  key_prefix      TEXT NOT NULL DEFAULT '',
  key_hash        TEXT NOT NULL UNIQUE,
  allowed_origins TEXT NOT NULL DEFAULT '',
  rpm_limit       INTEGER NOT NULL DEFAULT 0,
  max_concurrent  INTEGER NOT NULL DEFAULT 0,
  last_used_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT '',
  revoked_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

CREATE TABLE IF NOT EXISTS models (
  id                     INTEGER PRIMARY KEY,
  slug                   TEXT NOT NULL UNIQUE,
  display_name           TEXT NOT NULL DEFAULT '',
  description            TEXT NOT NULL DEFAULT '',
  badge                  TEXT NOT NULL DEFAULT '',
  card_color             TEXT NOT NULL DEFAULT '',
  model_type             TEXT NOT NULL DEFAULT 'chat',
  upstream_api_format    TEXT NOT NULL DEFAULT 'openai',
  upstream_path_override TEXT NOT NULL DEFAULT '',
  upstream_base_url      TEXT NOT NULL DEFAULT '',
  upstream_model         TEXT NOT NULL DEFAULT '',
  upstream_api_key       TEXT NOT NULL DEFAULT '',
  anthropic_base_url     TEXT NOT NULL DEFAULT '',
  anthropic_enabled      INTEGER NOT NULL DEFAULT 0,
  responses_base_url     TEXT NOT NULL DEFAULT '',
  responses_enabled      INTEGER NOT NULL DEFAULT 0,
  allowed_origins        TEXT NOT NULL DEFAULT '',
  rpm_limit              INTEGER NOT NULL DEFAULT 0,
  max_concurrent         INTEGER NOT NULL DEFAULT 0,
  input_price_per_1m     REAL NOT NULL DEFAULT 0,
  output_price_per_1m    REAL NOT NULL DEFAULT 0,
  cache_price_per_1m     REAL NOT NULL DEFAULT 0,
  multimodal_enabled     INTEGER NOT NULL DEFAULT 0,
  image_billing_mode     TEXT NOT NULL DEFAULT 'token',
  image_price_per_1m     REAL NOT NULL DEFAULT 0,
  image_price_per_image  REAL NOT NULL DEFAULT 0,
  image_tokens_per_image INTEGER NOT NULL DEFAULT 512,
  thinking_enabled       INTEGER NOT NULL DEFAULT 0,
  thinking_levels        TEXT NOT NULL DEFAULT '["off","low","medium","high"]',
  default_thinking       TEXT NOT NULL DEFAULT 'off',
  claude_compat          INTEGER NOT NULL DEFAULT 0,
  context_length         INTEGER NOT NULL DEFAULT 0,
  dev_only               INTEGER NOT NULL DEFAULT 0,
  enabled                INTEGER NOT NULL DEFAULT 0,
  sort_order             INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL DEFAULT '',
  updated_at             TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS usage_logs (
  id                INTEGER PRIMARY KEY,
  user_id           INTEGER NOT NULL,
  api_key_id        INTEGER,
  model_slug        TEXT NOT NULL DEFAULT '',
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  cached_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  image_count       INTEGER NOT NULL DEFAULT 0,
  cost_cents        INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT '',
  error_message     TEXT NOT NULL DEFAULT '',
  client_meta       TEXT NOT NULL DEFAULT '',
  prompt            TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL DEFAULT '',
  -- created_at 的毫秒时间戳副本：按时间过滤走整数索引，
  -- 不依赖字符串比较（也顺带兼容历史上格式不规范的 created_at）
  ts                INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_user_id   ON usage_logs(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_usage_ts        ON usage_logs(ts);
CREATE INDEX IF NOT EXISTS idx_usage_user_ts   ON usage_logs(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_usage_model     ON usage_logs(model_slug);

CREATE TABLE IF NOT EXISTS ledger (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL,
  kind          TEXT NOT NULL DEFAULT '',
  amount_cents  INTEGER NOT NULL DEFAULT 0,
  balance_after INTEGER NOT NULL DEFAULT 0,
  note          TEXT NOT NULL DEFAULT '',
  operator_id   INTEGER,
  created_at    TEXT NOT NULL DEFAULT '',
  ts            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ledger_user_id   ON ledger(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_user_ts   ON ledger(user_id, ts);

CREATE TABLE IF NOT EXISTS docs (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  title        TEXT NOT NULL DEFAULT '',
  external_url TEXT NOT NULL DEFAULT '',
  content_md   TEXT NOT NULL DEFAULT '',
  updated_at   TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state      TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS rate_limits (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  enabled               INTEGER NOT NULL DEFAULT 1,
  default_rpm           INTEGER NOT NULL DEFAULT 60,
  default_max_concurrent INTEGER NOT NULL DEFAULT 2,
  updated_at            TEXT NOT NULL DEFAULT ''
);
`

export function openDb(): SqliteDb {
  if (db) return db
  fs.mkdirSync(config.dataDir, { recursive: true })
  const instance = new Database(dbPath())
  instance.exec(SCHEMA)
  // 旧库补列：UniSSO 迁移引入 sse_user_id（保留集市 userID 供开发者平台判定）
  const cols = instance.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'sse_user_id')) {
    instance.exec("ALTER TABLE users ADD COLUMN sse_user_id TEXT NOT NULL DEFAULT ''")
  }
  db = instance
  return db
}

export function sql(): SqliteDb {
  if (!db) throw new Error('SQLite 尚未初始化，请先 await initDb()')
  return db
}

export function getMeta(key: string): string | null {
  const row = sql().prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row ? row.value : null
}

export function setMeta(key: string, value: string): void {
  sql()
    .prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value)
}

/** 自增序列：直接取当前最大 id + 1，避免再维护一份计数器 */
export function nextId(table: 'users' | 'api_keys' | 'models' | 'usage_logs' | 'ledger'): number {
  const row = sql().prepare(`SELECT COALESCE(MAX(id), 0) + 1 AS next FROM ${table}`).get() as {
    next: number
  }
  return row.next
}

/** 落盘一致性快照（备份用）；返回临时文件路径 */
export function snapshotTo(target: string): void {
  const database = sql()
  // VACUUM INTO 产出的是一个干净、已整理、单文件的副本，不需要停机
  database.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
}

export function closeDb(): void {
  if (!db) return
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
  } catch {
    /* ignore */
  }
  db.close()
  db = null
}
