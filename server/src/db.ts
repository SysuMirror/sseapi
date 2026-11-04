import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { closeDb, getMeta, nextId as sqlNextId, openDb, setMeta, snapshotTo, sql } from './sqlite.js'

export type RateLimitsConfig = {
  enabled: number
  default_rpm: number
  default_max_concurrent: number
  updated_at: string
}

function envLimitInt(key: string, fallback: number): number {
  const v = Number(process.env[key])
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback
}

function defaultRateLimitsConfig(): RateLimitsConfig {
  return {
    enabled: envLimitInt('SSEAPI_RATE_LIMIT_ENABLED', 1) ? 1 : 0,
    default_rpm: envLimitInt('SSEAPI_DEFAULT_RPM', 60),
    default_max_concurrent: envLimitInt('SSEAPI_DEFAULT_MAX_CONCURRENT', 2),
    updated_at: new Date().toISOString(),
  }
}

export type UserRow = {
  id: number
  oauth_id: string
  /** 绑定的集市 userID（UniSSO sse_sub）；登录主键仍为 oauth_id=sub */
  sse_user_id: string
  name: string
  email: string
  avatar_url: string
  is_admin: number
  balance_cents: number
  /** 备注（管理端可见） */
  admin_note: string
  /** 0=继承平台默认 RPM */
  rpm_limit: number
  /** 0=继承平台默认并发 */
  max_concurrent: number
  created_at: string
  updated_at: string
}

export type ApiKeyRow = {
  id: number
  user_id: number
  name: string
  key_prefix: string
  key_hash: string
  /** 密钥级域名白名单；空=不额外限制（仍受模型白名单约束） */
  allowed_origins: string
  /** 0=继承平台默认 */
  rpm_limit: number
  max_concurrent: number
  last_used_at: string | null
  created_at: string
  revoked_at: string | null
}

export type ModelRow = {
  id: number
  slug: string
  display_name: string
  description: string
  badge: string
  card_color: string
  /** chat | embedding | image_generation */
  model_type: string
  /** embedding: openai | tei_inputs | tei_texts */
  upstream_api_format: string
  /** 覆盖上游路径，如 /embed（留空则按协议默认） */
  upstream_path_override: string
  /** OpenAI 兼容根，如 http://vllm:8000/v1 */
  upstream_base_url: string
  /** 上游真实模型名（vLLM --served-model-name） */
  upstream_model: string
  /** 每模型上游密钥（vLLM 通常可空；有则 Bearer） */
  upstream_api_key: string
  /**
   * Anthropic（Claude Messages）协议独立上游根，如 https://api.anthropic.com/v1。
   * 空=未独立配置；此时若 claude_compat=1 则回退 OpenAI 上游做字段转换。
   */
  anthropic_base_url: string
  /** 是否对外 serve Anthropic Messages 协议（POST /v1/messages） */
  anthropic_enabled: number
  /**
   * OpenAI Responses 协议独立上游根，如 https://api.openai.com/v1。
   * 空=未独立配置；此时回退 OpenAI 上游做 Responses→Chat 转换。
   */
  responses_base_url: string
  /** 是否对外 serve OpenAI Responses 协议（POST /v1/responses） */
  responses_enabled: number
  /**
   * 浏览器调用域名白名单（Origin/Referer）。
   * 空=不限制；填 https://app.example.com 或 *.example.com
   */
  allowed_origins: string
  /** 0=继承平台默认 */
  rpm_limit: number
  max_concurrent: number
  input_price_per_1m: number
  output_price_per_1m: number
  /** 命中前缀缓存的 prompt token 单价（¥/1M）；来自 usage.prompt_tokens_details.cached_tokens */
  cache_price_per_1m: number
  /** 是否接受多模态（image_url）请求 */
  multimodal_enabled: number
  /** token=图片计入上游 prompt；per_image=按张另计 */
  image_billing_mode: 'token' | 'per_image'
  /** 独立图片 token 单价 ¥/1M；0=不单独拆，走输入价 */
  image_price_per_1m: number
  /** 按张计费时 ¥/张 */
  image_price_per_image: number
  /** 按张计费时从 prompt 扣除的每图预估 tokens，避免双重计费 */
  image_tokens_per_image: number
  /** 是否支持思考/推理（chat_template_kwargs.enable_thinking 等） */
  thinking_enabled: number
  /** 思考强度档位：JSON 数组或逗号分隔，如 ["off","low","medium","high"] */
  thinking_levels: string
  /** 默认思考档位 */
  default_thinking: string
  /** 是否同时暴露 Claude Messages 协议（POST /v1/messages） */
  claude_compat: number
  /**
   * 上下文长度（tokens）：0=不限制；>0 时在调用前检测输入 token，
   * 超过则拒绝（防止用户输入超限）。用于 chat 类模型。
   */
  context_length: number
  /** 仅对「集市开发者」可见/可调用；非开发者与普通用户不可见（管理员恒可见） */
  dev_only: number
  enabled: number
  sort_order: number
  created_at: string
  updated_at: string
}

export type UsageRow = {
  id: number
  user_id: number
  api_key_id: number | null
  model_slug: string
  prompt_tokens: number
  /** 命中缓存的 prompt tokens（≤ prompt_tokens） */
  cached_tokens: number
  completion_tokens: number
  total_tokens: number
  /** 请求内检测到的图片张数 */
  image_count: number
  cost_cents: number
  status: string
  error_message: string
  /** 客户端 IP / Origin 摘要 */
  client_meta: string
  /** 本次请求的提示词预览（截断，避免过大） */
  prompt: string
  created_at: string
  /** created_at 的毫秒时间戳（查询用） */
  ts: number
}

export type LedgerRow = {
  id: number
  user_id: number
  kind: string
  amount_cents: number
  balance_after: number
  note: string
  operator_id: number | null
  created_at: string
  /** created_at 的毫秒时间戳（查询用） */
  ts: number
}

type DocsRow = {
  id: 1
  title: string
  external_url: string
  content_md: string
  updated_at: string
}

/**
 * 常驻内存的只有「配置类」小表（用户 / 密钥 / 模型 / 文档 / 限流配置）。
 * 用量与流水是无限增长的事件表，只存在 SQLite 里，按需查询。
 */
type Store = {
  seq: Record<string, number>
  users: UserRow[]
  api_keys: ApiKeyRow[]
  models: ModelRow[]
  docs: DocsRow
  oauth_states: { state: string; created_at: string }[]
  rate_limits: RateLimitsConfig
}

export const DEFAULT_DOCS_URL = 'https://ssemarket.cn/iwiki/space/space-R0M8mXw2'

const DEFAULT_DOCS = ''

function emptyStore(): Store {
  return {
    seq: {
      users: 0,
      api_keys: 0,
      models: 0,
      usage_logs: 0,
      ledger: 0,
    },
    users: [],
    api_keys: [],
    models: [],
    docs: {
      id: 1,
      title: 'API 文档',
      external_url: DEFAULT_DOCS_URL,
      content_md: DEFAULT_DOCS,
      updated_at: new Date().toISOString(),
    },
    oauth_states: [],
    rate_limits: defaultRateLimitsConfig(),
  }
}

let store: Store = emptyStore()
let ready = false

export function now() {
  return new Date().toISOString()
}

export function toTs(iso: string): number {
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? t : 0
}

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

export function newApiKeyPlain(): { plain: string; prefix: string; hash: string } {
  const body = crypto.randomBytes(24).toString('hex')
  const plain = `sk-${body}`
  return { plain, prefix: plain.slice(0, 10), hash: hashToken(plain) }
}

// ==========================================================================
// 配置类小表 <-> SQLite
// ==========================================================================

const USER_COLS = [
  'id', 'oauth_id', 'sse_user_id', 'name', 'email', 'avatar_url', 'is_admin', 'balance_cents',
  'admin_note', 'rpm_limit', 'max_concurrent', 'created_at', 'updated_at',
] as const
const KEY_COLS = [
  'id', 'user_id', 'name', 'key_prefix', 'key_hash', 'allowed_origins',
  'rpm_limit', 'max_concurrent', 'last_used_at', 'created_at', 'revoked_at',
] as const
const MODEL_COLS = [
  'id', 'slug', 'display_name', 'description', 'badge', 'card_color', 'model_type',
  'upstream_api_format', 'upstream_path_override', 'upstream_base_url', 'upstream_model',
  'upstream_api_key', 'anthropic_base_url', 'anthropic_enabled', 'responses_base_url',
  'responses_enabled', 'allowed_origins', 'rpm_limit', 'max_concurrent',
  'input_price_per_1m', 'output_price_per_1m', 'cache_price_per_1m', 'multimodal_enabled',
  'image_billing_mode', 'image_price_per_1m', 'image_price_per_image', 'image_tokens_per_image',
  'thinking_enabled', 'thinking_levels', 'default_thinking', 'claude_compat',
  'context_length', 'dev_only', 'enabled', 'sort_order', 'created_at', 'updated_at',
] as const

function readAll<T>(table: string): T[] {
  return sql().prepare(`SELECT * FROM ${table}`).all() as T[]
}

/** 小表的全量写回：行数只有几十~几百，直接整表 upsert 最简单也最不容易漏 */
function persistTable(table: string, cols: readonly string[], rows: Array<Record<string, unknown>>) {
  const database = sql()
  const placeholders = cols.map(() => '?').join(', ')
  const updates = cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')
  const upsert = database.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})
     ON CONFLICT(id) DO UPDATE SET ${updates}`,
  )
  const ids: number[] = []
  for (const row of rows) {
    upsert.run(cols.map((c) => normalizeCol(row[c])))
    ids.push(Number(row.id))
  }
  // 删除内存里已经没有的行（管理台删模型等）
  const del = ids.length
    ? database.prepare(`DELETE FROM ${table} WHERE id NOT IN (${ids.map(() => '?').join(', ')})`)
    : database.prepare(`DELETE FROM ${table}`)
  del.run(...ids)
}

/** better-sqlite3 只接受 number/string/bigint/Buffer/null，undefined 会直接抛错 */
function normalizeCol(v: unknown): string | number | null {
  if (v === undefined || v === null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  if (typeof v === 'boolean') return v ? 1 : 0
  return String(v)
}

function persistConfigSync() {
  const database = sql()
  const tx = database.transaction(() => {
    persistTable('users', USER_COLS, store.users as unknown as Array<Record<string, unknown>>)
    persistTable('api_keys', KEY_COLS, store.api_keys as unknown as Array<Record<string, unknown>>)
    persistTable('models', MODEL_COLS, store.models as unknown as Array<Record<string, unknown>>)
    database
      .prepare(
        `INSERT INTO docs (id, title, external_url, content_md, updated_at) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, external_url = excluded.external_url,
           content_md = excluded.content_md, updated_at = excluded.updated_at`,
      )
      .run(store.docs.title, store.docs.external_url, store.docs.content_md, store.docs.updated_at)
    database
      .prepare(
        `INSERT INTO rate_limits (id, enabled, default_rpm, default_max_concurrent, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, default_rpm = excluded.default_rpm,
           default_max_concurrent = excluded.default_max_concurrent, updated_at = excluded.updated_at`,
      )
      .run(
        store.rate_limits.enabled,
        store.rate_limits.default_rpm,
        store.rate_limits.default_max_concurrent,
        store.rate_limits.updated_at,
      )
    database.prepare('DELETE FROM oauth_states').run()
    const insState = database.prepare('INSERT OR REPLACE INTO oauth_states (state, created_at) VALUES (?, ?)')
    for (const s of store.oauth_states) insState.run(s.state, s.created_at)
    setMeta('seq', JSON.stringify(store.seq))
  })
  tx()
}

/** 交易/回滚用的内存快照（只涉及小表） */
function snapshotConfig(): Store {
  return {
    seq: { ...store.seq },
    users: store.users.map((u) => ({ ...u })),
    api_keys: store.api_keys.map((k) => ({ ...k })),
    models: store.models.map((m) => ({ ...m })),
    docs: { ...store.docs },
    oauth_states: store.oauth_states.map((s) => ({ ...s })),
    rate_limits: { ...store.rate_limits },
  }
}

function restoreConfig(snap: Store) {
  store = snap
}

// ==========================================================================
// 事件表查询（SQLite，走索引，不再全量进内存）
// ==========================================================================

export type UsageQuery = {
  userId?: number
  apiKeyId?: number
  /** 毫秒时间戳，闭区间 */
  from?: number
  to?: number
  /** 精确匹配的模型 slug 集合 */
  modelSlugs?: string[]
  /** 状态过滤：'error' 表示「非 ok」，其余为精确匹配 */
  statuses?: string[]
  /** 只要成功请求（账单统计用） */
  onlyOk?: boolean
  orderDesc?: boolean
  limit?: number
  offset?: number
}

type Where = { sql: string; params: Array<string | number> }

function usageWhere(q: UsageQuery): Where {
  const parts: string[] = []
  const params: Array<string | number> = []
  if (q.userId != null) {
    parts.push('user_id = ?')
    params.push(q.userId)
  }
  if (q.apiKeyId != null) {
    parts.push('api_key_id = ?')
    params.push(q.apiKeyId)
  }
  if (q.from != null) {
    parts.push('ts >= ?')
    params.push(q.from)
  }
  if (q.to != null) {
    parts.push('ts <= ?')
    params.push(q.to)
  }
  if (q.modelSlugs) {
    // undefined = 不过滤；显式传空数组 = 过滤条件没有任何匹配项 → 恒假
    // （例如按类型筛选，但没有任何模型属于该类型）
    if (!q.modelSlugs.length) parts.push('1 = 0')
    else {
      parts.push(`model_slug IN (${q.modelSlugs.map(() => '?').join(', ')})`)
      params.push(...q.modelSlugs)
    }
  }
  if (q.statuses && q.statuses.length) {
    // 'error' = status !== 'ok'；其余为精确匹配（与旧 matchesStatus 语义一致）
    const or = q.statuses.map((s) => (s === 'error' ? "status <> 'ok'" : 'status = ?'))
    parts.push(`(${or.join(' OR ')})`)
    for (const s of q.statuses) if (s !== 'error') params.push(s)
  }
  if (q.onlyOk) parts.push("status = 'ok'")
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params }
}

const USAGE_SELECT = `SELECT id, user_id, api_key_id, model_slug, prompt_tokens, cached_tokens,
  completion_tokens, total_tokens, image_count, cost_cents, status, error_message,
  client_meta, prompt, created_at, ts FROM usage_logs`

export function queryUsage(q: UsageQuery = {}): UsageRow[] {
  const w = usageWhere(q)
  let text = `${USAGE_SELECT} ${w.sql} ORDER BY id ${q.orderDesc === false ? 'ASC' : 'DESC'}`
  const params = [...w.params]
  if (q.limit != null) {
    text += ' LIMIT ? OFFSET ?'
    params.push(Math.max(0, q.limit), Math.max(0, q.offset || 0))
  }
  return sql().prepare(text).all(...params) as UsageRow[]
}

export function countUsage(q: UsageQuery = {}): number {
  const w = usageWhere(q)
  const row = sql()
    .prepare(`SELECT COUNT(*) AS c FROM usage_logs ${w.sql}`)
    .get(...w.params) as { c: number }
  return row.c
}

export type UsageTotals = {
  request_count: number
  prompt_tokens: number
  cached_tokens: number
  completion_tokens: number
  total_tokens: number
  cost_cents: number
  error_count: number
}

/**
 * 在 SQL 里做聚合：把「几百 MB 的明细」变成「一行结果」，
 * 这是换成 SQLite 的核心收益——页面耗时不再随历史总量增长。
 */
export function usageTotals(q: UsageQuery = {}): UsageTotals {
  const w = usageWhere(q)
  const row = sql()
    .prepare(
      `SELECT COUNT(*) AS request_count,
              COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
              COALESCE(SUM(total_tokens), 0) AS total_tokens,
              COALESCE(SUM(cost_cents), 0) AS cost_cents,
              COALESCE(SUM(CASE WHEN status <> 'ok' THEN 1 ELSE 0 END), 0) AS error_count
         FROM usage_logs ${w.sql}`,
    )
    .get(...w.params)
  return row as UsageTotals
}

export function usageByModel(q: UsageQuery = {}) {
  const w = usageWhere(q)
  return sql()
    .prepare(
      `SELECT model_slug, COUNT(*) AS requests, COALESCE(SUM(total_tokens), 0) AS tokens,
              COALESCE(SUM(cost_cents), 0) AS cost_cents,
              COALESCE(SUM(CASE WHEN status <> 'ok' THEN 1 ELSE 0 END), 0) AS errors
         FROM usage_logs ${w.sql} GROUP BY model_slug ORDER BY cost_cents DESC`,
    )
    .all(...w.params) as Array<{
    model_slug: string
    requests: number
    tokens: number
    cost_cents: number
    errors: number
  }>
}

export function usageByStatus(q: UsageQuery = {}) {
  const w = usageWhere(q)
  return sql()
    .prepare(
      `SELECT CASE WHEN status = 'ok' THEN 'ok' ELSE 'error' END AS status,
              COUNT(*) AS request_count,
              COALESCE(SUM(total_tokens), 0) AS tokens,
              COALESCE(SUM(cost_cents), 0) AS cost_cents
         FROM usage_logs ${w.sql} GROUP BY status`,
    )
    .all(...w.params) as Array<{ status: string; request_count: number; tokens: number; cost_cents: number }>
}

export function usageByUser(q: UsageQuery = {}) {
  const w = usageWhere(q)
  return sql()
    .prepare(
      `SELECT user_id, COUNT(*) AS requests,
              COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
              COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
              COALESCE(SUM(total_tokens), 0) AS tokens,
              COALESCE(SUM(cost_cents), 0) AS cost_cents,
              COALESCE(SUM(CASE WHEN status <> 'ok' THEN 1 ELSE 0 END), 0) AS errors
         FROM usage_logs ${w.sql} GROUP BY user_id ORDER BY cost_cents DESC`,
    )
    .all(...w.params) as Array<{
    user_id: number
    requests: number
    prompt_tokens: number
    completion_tokens: number
    cached_tokens: number
    tokens: number
    cost_cents: number
    errors: number
  }>
}

/** 按本地日/小时分桶（offset 为本地时区分钟偏移，与 JS 侧 localDay 口径一致） */
export function usageByBucket(
  q: UsageQuery,
  unit: 'day' | 'hour',
  offsetMinutes: number,
): Array<{ bucket: string; tokens: number; requests: number; cost_cents: number }> {
  const w = usageWhere(q)
  const fmt = unit === 'day' ? '%Y-%m-%d' : '%Y-%m-%d %H:00'
  return sql()
    .prepare(
      `SELECT strftime('${fmt}', ts / 1000, 'unixepoch', ?) AS bucket,
              COALESCE(SUM(total_tokens), 0) AS tokens,
              COUNT(*) AS requests,
              COALESCE(SUM(cost_cents), 0) AS cost_cents
         FROM usage_logs ${w.sql}
        GROUP BY bucket ORDER BY bucket ASC`,
    )
    .all(`${offsetMinutes >= 0 ? '+' : ''}${offsetMinutes} minutes`, ...w.params) as Array<{
    bucket: string
    tokens: number
    requests: number
    cost_cents: number
  }>
}

/** 流水求和（签到/充值/消费统计用） */
export function ledgerSum(at: { userId?: number; from?: number; to?: number; kinds?: string[]; positiveOnly?: boolean } = {}) {
  const w = ledgerWhere(at as LedgerQuery)
  const extra = at.positiveOnly ? (w.sql ? ' AND amount_cents > 0' : 'WHERE amount_cents > 0') : ''
  const row = sql()
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS total FROM ledger ${w.sql}${extra}`,
    )
    .get(...w.params) as { n: number; total: number }
  return row
}

export function insertUsageLog(row: Omit<UsageRow, 'ts'> & { ts?: number }): void {
  sql()
    .prepare(
      `INSERT OR REPLACE INTO usage_logs (id, user_id, api_key_id, model_slug, prompt_tokens,
        cached_tokens, completion_tokens, total_tokens, image_count, cost_cents, status,
        error_message, client_meta, prompt, created_at, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.user_id,
      row.api_key_id ?? null,
      row.model_slug,
      row.prompt_tokens,
      row.cached_tokens,
      row.completion_tokens,
      row.total_tokens,
      row.image_count,
      row.cost_cents,
      row.status,
      row.error_message,
      row.client_meta,
      row.prompt,
      row.created_at,
      row.ts ?? toTs(row.created_at),
    )
}

export type LedgerQuery = {
  userId?: number
  from?: number
  to?: number
  kinds?: string[]
  limit?: number
  offset?: number
}

function ledgerWhere(q: LedgerQuery): Where {
  const parts: string[] = []
  const params: Array<string | number> = []
  if (q.userId != null) {
    parts.push('user_id = ?')
    params.push(q.userId)
  }
  if (q.from != null) {
    parts.push('ts >= ?')
    params.push(q.from)
  }
  if (q.to != null) {
    parts.push('ts <= ?')
    params.push(q.to)
  }
  if (q.kinds && q.kinds.length) {
    parts.push(`kind IN (${q.kinds.map(() => '?').join(', ')})`)
    params.push(...q.kinds)
  }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params }
}

export function queryLedger(q: LedgerQuery = {}): LedgerRow[] {
  const w = ledgerWhere(q)
  let text = `SELECT * FROM ledger ${w.sql} ORDER BY id DESC`
  const params = [...w.params]
  if (q.limit != null) {
    text += ' LIMIT ? OFFSET ?'
    params.push(Math.max(0, q.limit), Math.max(0, q.offset || 0))
  }
  return sql().prepare(text).all(...params) as LedgerRow[]
}

export function countLedger(q: LedgerQuery = {}): number {
  const w = ledgerWhere(q)
  const row = sql().prepare(`SELECT COUNT(*) AS c FROM ledger ${w.sql}`).get(...w.params) as { c: number }
  return row.c
}

export function insertLedger(row: Omit<LedgerRow, 'ts'> & { ts?: number }): void {
  sql()
    .prepare(
      `INSERT OR REPLACE INTO ledger (id, user_id, kind, amount_cents, balance_after, note,
        operator_id, created_at, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.user_id,
      row.kind,
      row.amount_cents,
      row.balance_after,
      row.note,
      row.operator_id ?? null,
      row.created_at,
      row.ts ?? toTs(row.created_at),
    )
}

// ==========================================================================
// 初始化 / 持久化
// ==========================================================================

function loadConfigFromSqlite() {
  const s = emptyStore()
  s.users = readAll<UserRow>('users').map((u) => ({ ...u, is_admin: Number(u.is_admin) || 0 }))
  s.api_keys = readAll<ApiKeyRow>('api_keys')
  s.models = readAll<ModelRow>('models')
  const docs = sql().prepare('SELECT * FROM docs WHERE id = 1').get() as DocsRow | undefined
  if (docs) s.docs = docs
  s.oauth_states = readAll<{ state: string; created_at: string }>('oauth_states')
  const rl = sql()
    .prepare('SELECT * FROM rate_limits WHERE id = 1')
    .get() as RateLimitsConfig | undefined
  s.rate_limits = rl
    ? {
        enabled: rl.enabled ? 1 : 0,
        default_rpm: Math.max(0, Number(rl.default_rpm) || 0),
        default_max_concurrent: Math.max(0, Number(rl.default_max_concurrent) || 0),
        updated_at: rl.updated_at || new Date().toISOString(),
      }
    : defaultRateLimitsConfig()
  const seqRaw = getMeta('seq')
  if (seqRaw) {
    try {
      s.seq = { ...s.seq, ...(JSON.parse(seqRaw) as Record<string, number>) }
    } catch {
      /* 损坏则沿用默认 */
    }
  }
  return s
}

function seedModels(s: Store) {
  if (s.models.length) return
  const t = now()
  s.seq.models = Math.max(1, s.seq.models || 0)
  s.models.push({
    id: s.seq.models,
    slug: 'demo-chat',
    display_name: 'Demo Chat',
    description: '示例模型。管理台填写 vLLM 的 OpenAI 兼容 Base URL（…/v1）与 served-model-name 后即可调用。',
    badge: 'Demo',
    card_color: '#3370ff',
    upstream_base_url: '',
    upstream_model: 'demo-chat',
    upstream_api_key: '',
    allowed_origins: '',
    rpm_limit: 0,
    max_concurrent: 0,
    input_price_per_1m: 1,
    output_price_per_1m: 2,
    cache_price_per_1m: 0.1,
    multimodal_enabled: 0,
    image_billing_mode: 'token',
    image_price_per_1m: 0,
    image_price_per_image: 0,
    image_tokens_per_image: 512,
    thinking_enabled: 0,
    thinking_levels: '["off","low","medium","high"]',
    default_thinking: 'off',
    claude_compat: 0,
    anthropic_base_url: '',
    anthropic_enabled: 0,
    responses_base_url: '',
    responses_enabled: 0,
    context_length: 0,
    dev_only: 0,
    model_type: 'chat',
    upstream_api_format: 'openai',
    upstream_path_override: '',
    enabled: 0,
    sort_order: 10,
    created_at: t,
    updated_at: t,
  })
}

// ==========================================================================
// 旧 JSON 存储的一次性导入
// ==========================================================================

const LEGACY_STORE = 'sseapi-store.json'

function parseJsonLines(file: string, onRow: (row: any) => void) {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return 0
  }
  let n = 0
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      onRow(JSON.parse(line))
      n++
    } catch {
      /* 跳过损坏行 */
    }
  }
  return n
}

/**
 * 首次启动（或遗留 JSON 尚未导入）时把旧数据搬进 SQLite。
 * 幂等：靠 meta 里的 imported_legacy 标记；导入完成后再把旧文件重命名留档。
 */
export function importLegacyJsonIfNeeded(): void {
  if (getMeta('imported_legacy') === '1') return

  const storeFile = path.join(config.dataDir, LEGACY_STORE)
  const usageFile = path.join(config.dataDir, 'usage_logs.jsonl')
  const ledgerFile = path.join(config.dataDir, 'ledger.jsonl')
  const hasLegacy = fs.existsSync(storeFile) || fs.existsSync(usageFile) || fs.existsSync(ledgerFile)
  if (!hasLegacy) {
    setMeta('imported_legacy', '1')
    return
  }

  const database = sql()
  const t0 = Date.now()

  // 1) 配置类小表
  if (fs.existsSync(storeFile)) {
    try {
      const legacy = JSON.parse(fs.readFileSync(storeFile, 'utf8')) as Record<string, any>
      store = { ...emptyStore(), ...legacy, docs: legacy.docs || emptyStore().docs } as Store
      store.rate_limits = legacy.rate_limits || defaultRateLimitsConfig()
      store.oauth_states = legacy.oauth_states || []
      persistConfigSync()
      console.log(`[sseapi] 旧 JSON 已导入：users=${store.users.length} keys=${store.api_keys.length} models=${store.models.length}`)
    } catch (e) {
      console.error('[sseapi] 旧 store JSON 解析失败，跳过配置导入:', e instanceof Error ? e.message : e)
    }
  }

  // 2) 明细表（分事务批量写入，避免一次占用过多内存）。
  //
  // 用 OR REPLACE 而不是 OR IGNORE 是有意的：旧数据里存在 id 冲突
  // （同一个 id 对应两条不同的请求，共约 900 条），旧实现读取时用
  // dedupeRows 去重、后出现的覆盖先出现的；OR IGNORE 会取「先出现的」，
  // 导致这些行的日期/金额落到另一天，聚合结果与历史对不上。
  const impUsage = database.prepare(
    `INSERT OR REPLACE INTO usage_logs (id, user_id, api_key_id, model_slug, prompt_tokens,
      cached_tokens, completion_tokens, total_tokens, image_count, cost_cents, status,
      error_message, client_meta, prompt, created_at, ts)
     VALUES (@id, @user_id, @api_key_id, @model_slug, @prompt_tokens, @cached_tokens,
      @completion_tokens, @total_tokens, @image_count, @cost_cents, @status,
      @error_message, @client_meta, @prompt, @created_at, @ts)`,
  )
  const impLedger = database.prepare(
    `INSERT OR REPLACE INTO ledger (id, user_id, kind, amount_cents, balance_after, note,
      operator_id, created_at, ts) VALUES (@id, @user_id, @kind, @amount_cents, @balance_after,
      @note, @operator_id, @created_at, @ts)`,
  )

  const usageRows: any[] = []
  parseJsonLines(usageFile, (r) =>
    usageRows.push({
      id: r.id,
      user_id: r.user_id ?? 0,
      api_key_id: r.api_key_id ?? null,
      model_slug: r.model_slug ?? '',
      prompt_tokens: r.prompt_tokens ?? 0,
      cached_tokens: r.cached_tokens ?? 0,
      completion_tokens: r.completion_tokens ?? 0,
      total_tokens: r.total_tokens ?? 0,
      image_count: r.image_count ?? 0,
      cost_cents: r.cost_cents ?? 0,
      status: r.status ?? '',
      error_message: r.error_message ?? '',
      client_meta: r.client_meta ?? '',
      prompt: r.prompt ?? '',
      created_at: r.created_at ?? '',
      ts: toTs(r.created_at ?? ''),
    }),
  )
  const ledgerRows: any[] = []
  parseJsonLines(ledgerFile, (r) =>
    ledgerRows.push({
      id: r.id,
      user_id: r.user_id ?? 0,
      kind: r.kind ?? '',
      amount_cents: r.amount_cents ?? 0,
      balance_after: r.balance_after ?? 0,
      note: r.note ?? '',
      operator_id: r.operator_id ?? null,
      created_at: r.created_at ?? '',
      ts: toTs(r.created_at ?? ''),
    }),
  )

  const bulk = database.transaction((rows: any[], stmt: any) => {
    for (const row of rows) stmt.run(row)
  })
  if (usageRows.length) bulk(usageRows, impUsage)
  if (ledgerRows.length) bulk(ledgerRows, impLedger)

  // 3) 同步序列号：确保新写入的 id 不会和导入的历史撞车
  const maxUsage = (database.prepare('SELECT COALESCE(MAX(id),0) AS m FROM usage_logs').get() as { m: number }).m
  const maxLedger = (database.prepare('SELECT COALESCE(MAX(id),0) AS m FROM ledger').get() as { m: number }).m
  store.seq.usage_logs = Math.max(store.seq.usage_logs || 0, maxUsage)
  store.seq.ledger = Math.max(store.seq.ledger || 0, maxLedger)
  const maxUser = (database.prepare('SELECT COALESCE(MAX(id),0) AS m FROM users').get() as { m: number }).m
  const maxKey = (database.prepare('SELECT COALESCE(MAX(id),0) AS m FROM api_keys').get() as { m: number }).m
  const maxModel = (database.prepare('SELECT COALESCE(MAX(id),0) AS m FROM models').get() as { m: number }).m
  store.seq.users = Math.max(store.seq.users || 0, maxUser)
  store.seq.api_keys = Math.max(store.seq.api_keys || 0, maxKey)
  store.seq.models = Math.max(store.seq.models || 0, maxModel)
  setMeta('seq', JSON.stringify(store.seq))

  // 4) 旧文件留档（改名而不是删除，出问题还能回滚）
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (const f of [storeFile, usageFile, ledgerFile]) {
    if (!fs.existsSync(f)) continue
    try {
      fs.renameSync(f, `${f}.imported-${stamp}`)
    } catch {
      /* 改名失败不影响已导入的数据 */
    }
  }

  // 批量导入会把整个 WAL 撑到几百 MB（本次约 260MB），落盘后立刻整理回主库
  database.pragma('wal_checkpoint(TRUNCATE)')

  setMeta('imported_legacy', '1')
  console.log(
    `[sseapi] 旧 JSON 导入完成：usage_logs=${usageRows.length} ledger=${ledgerRows.length}，耗时 ${Date.now() - t0}ms`,
  )
}

export async function initDb() {
  openDb()
  importLegacyJsonIfNeeded()
  store = loadConfigFromSqlite()
  seedModels(store)
  ready = true
  persistConfigSync()
}

export function assertDbReady() {
  if (!ready) throw new Error('数据库尚未初始化，请先 await initDb()')
}

let persistQueued = false
let persistQueue: Promise<void> = Promise.resolve()

/** 小表写回是同步且极快的（几十行），保留 async 签名兼容既有调用 */
async function persist(): Promise<void> {
  if (persistQueued) return persistQueue
  persistQueued = true
  const run = persistQueue.then(() => {
    persistQueued = false
    assertDbReady()
    persistConfigSync()
  })
  persistQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export const db = {
  getStore: () => {
    assertDbReady()
    return store
  },
  persist,
  /** 只在「非 ok」时才真正被过滤；其余语义与旧实现一致 */
  readUsageLogs: async (q: UsageQuery = {}): Promise<UsageRow[]> => queryUsage(q),
  readLedger: async (q: LedgerQuery = {}): Promise<LedgerRow[]> => queryLedger(q),
  queryUsage,
  countUsage,
  queryLedger,
  countLedger,
  usageTotals,
  usageByModel,
  usageByStatus,
  usageByUser,
  usageByBucket,
  ledgerSum,
  insertUsageLog,
  insertLedger,
  reload: async () => {
    await initDb()
  },
  nextId(table: keyof Store['seq']) {
    const cur = Number(store.seq[table])
    store.seq[table] = (Number.isFinite(cur) ? cur : 0) + 1
    // 兜底：万一旧数据里已有更大的 id，避免主键冲突
    const floor = sqlNextId(table as 'users' | 'api_keys' | 'models' | 'usage_logs' | 'ledger') - 1
    if (store.seq[table] <= floor) store.seq[table] = floor + 1
    return store.seq[table]
  },
  /** 小表的结构性改动：SQLite 事务 + 内存快照回滚 */
  async transaction<T>(fn: () => T): Promise<T> {
    assertDbReady()
    const snap = snapshotConfig()
    try {
      const run = sql().transaction(() => {
        const r = fn()
        persistConfigSync()
        return r
      })
      return run()
    } catch (e) {
      restoreConfig(snap)
      throw e
    }
  },
  /** 备份用一致性快照 */
  snapshotTo,
  close: closeDb,
}

export type { Store }
