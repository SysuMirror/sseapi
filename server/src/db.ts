import crypto from 'node:crypto'
import { appendHistory, loadStoreRaw, readHistory, saveStoreRaw } from './storage.js'

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
}

type Store = {
  seq: Record<string, number>
  users: UserRow[]
  api_keys: ApiKeyRow[]
  models: ModelRow[]
  usage_logs: UsageRow[]
  ledger: LedgerRow[]
  docs: {
    id: 1
    title: string
    /** 外部文档（iWiki 等）；平台内不再维护正文 */
    external_url: string
    content_md: string
    updated_at: string
  }
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
    usage_logs: [],
    ledger: [],
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

function migrate(s: Store) {
  for (const u of s.users) {
    if (u.admin_note == null) u.admin_note = ''
    if (u.rpm_limit == null) u.rpm_limit = 0
    if (u.max_concurrent == null) u.max_concurrent = 0
  }
  if (!s.seq) s.seq = emptyStore().seq
  for (const key of [
    'users',
    'api_keys',
    'models',
    'usage_logs',
    'ledger',
  ] as const) {
    if (s.seq[key] == null || !Number.isFinite(s.seq[key])) s.seq[key] = 0
  }
  for (const k of s.api_keys) {
    if (k.allowed_origins == null) k.allowed_origins = ''
    if (k.rpm_limit == null) k.rpm_limit = 0
    if (k.max_concurrent == null) k.max_concurrent = 0
  }
  for (const m of s.models) {
    if (m.upstream_api_key == null) m.upstream_api_key = ''
    if (m.allowed_origins == null) m.allowed_origins = ''
    if (m.rpm_limit == null) m.rpm_limit = 0
    if (m.max_concurrent == null) m.max_concurrent = 0
    if (m.cache_price_per_1m == null) m.cache_price_per_1m = 0
    if (m.multimodal_enabled == null) m.multimodal_enabled = 0
    if (m.image_billing_mode !== 'per_image' && m.image_billing_mode !== 'token') {
      m.image_billing_mode = 'token'
    }
    if (m.image_price_per_1m == null) m.image_price_per_1m = 0
    if (m.image_price_per_image == null) m.image_price_per_image = 0
    if (m.image_tokens_per_image == null) m.image_tokens_per_image = 512
    if (m.thinking_enabled == null) m.thinking_enabled = 0
    if (m.thinking_levels == null) m.thinking_levels = '["off","low","medium","high"]'
    if (m.default_thinking == null) m.default_thinking = 'off'
    if (m.claude_compat == null) m.claude_compat = 0
    if (m.anthropic_base_url == null) m.anthropic_base_url = ''
    if (m.anthropic_enabled == null) m.anthropic_enabled = 0
    if (m.responses_base_url == null) m.responses_base_url = ''
    if (m.responses_enabled == null) m.responses_enabled = 0
    if (m.context_length == null) m.context_length = 0
    if (m.dev_only == null) m.dev_only = 0
    if (m.model_type == null || !String(m.model_type).trim()) m.model_type = 'chat'
    if (m.upstream_api_format == null || !String(m.upstream_api_format).trim()) {
      m.upstream_api_format = 'openai'
    }
    if (m.upstream_path_override == null) m.upstream_path_override = ''
  }
  for (const l of s.usage_logs) {
    if (l.client_meta == null) l.client_meta = ''
    if (l.cached_tokens == null) l.cached_tokens = 0
    if (l.image_count == null) l.image_count = 0
    if (l.prompt == null) l.prompt = ''
  }
  if (!s.docs) {
    s.docs = emptyStore().docs
  } else {
    if (s.docs.title == null) s.docs.title = 'API 文档'
    if (s.docs.content_md == null) s.docs.content_md = ''
    if (!s.docs.external_url) s.docs.external_url = DEFAULT_DOCS_URL
  }
  if (!s.rate_limits) {
    s.rate_limits = defaultRateLimitsConfig()
  } else {
    s.rate_limits = {
      enabled: s.rate_limits.enabled ? 1 : 0,
      default_rpm: Math.max(0, Number(s.rate_limits.default_rpm) || 0),
      default_max_concurrent: Math.max(0, Number(s.rate_limits.default_max_concurrent) || 0),
      updated_at: s.rate_limits.updated_at || new Date().toISOString(),
    }
  }
}

function parseStore(raw: string | null): Store {
  if (!raw) {
    const s = emptyStore()
    seedModels(s)
    return s
  }
  const s = JSON.parse(raw) as Store
  migrate(s)
  return s
}

async function save(s: Store) {
  // 紧凑序列化:带缩进会让 7MB 的 store 膨胀到 ~15MB 字符串,高频保存时内存翻倍
  await saveStoreRaw(JSON.stringify(s))
}

function seedModels(s: Store) {
  if (s.models.length) return
  const t = new Date().toISOString()
  s.seq.models += 1
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

let store: Store = emptyStore()
let ready = false
let persistQueue: Promise<void> = Promise.resolve()

function dedupeRows<T extends { id: number }>(rows: T[]): T[] {
  const byId = new Map<number, T>()
  for (const row of rows) byId.set(row.id, row)
  return [...byId.values()]
}

export async function initDb() {
  const raw = await loadStoreRaw()
  store = parseStore(raw)
  store.usage_logs = dedupeRows(store.usage_logs).sort((a, b) => a.id - b.id)
  store.ledger = dedupeRows(store.ledger).sort((a, b) => a.id - b.id)
  ready = true
  try { await persist() } catch (error) { ready = false; throw error }
}

export function assertDbReady() {
  if (!ready) throw new Error('数据库尚未初始化，请先 await initDb()')
}

export function now() {
  return new Date().toISOString()
}

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

export function newApiKeyPlain(): { plain: string; prefix: string; hash: string } {
  const body = crypto.randomBytes(24).toString('hex')
  const plain = `sk-${body}`
  return { plain, prefix: plain.slice(0, 10), hash: hashToken(plain) }
}

function nextId(table: keyof Store['seq']) {
  const cur = Number(store.seq[table])
  store.seq[table] = (Number.isFinite(cur) ? cur : 0) + 1
  return store.seq[table]
}

async function persistInternal() {
  assertDbReady()
  const u = store.usage_logs.slice(0, Math.max(0, store.usage_logs.length - 5000))
  const l = store.ledger.slice(0, Math.max(0, store.ledger.length - 10000))
  await appendHistory('usage_logs', u)
  await appendHistory('ledger', l)
  const usageIds = new Set(u.map((row) => row.id))
  const ledgerIds = new Set(l.map((row) => row.id))
  store.usage_logs = store.usage_logs.filter((row) => !usageIds.has(row.id))
  store.ledger = store.ledger.filter((row) => !ledgerIds.has(row.id))
  await save(store)
}

async function persist() {
  const run = persistQueue.then(() => persistInternal())
  persistQueue = run.catch(() => undefined)
  return run
}

export const db = {
  getStore: () => {
    assertDbReady()
    return store
  },
  persist,
  async readUsageLogs(): Promise<Store["usage_logs"]> {
    assertDbReady()
    await persistQueue
    const archived = await readHistory("usage_logs")
    return dedupeRows([...archived, ...store.usage_logs]).sort((a, b) => a.id - b.id)
  },
  async readLedger(): Promise<Store["ledger"]> {
    assertDbReady()
    await persistQueue
    const archived = await readHistory("ledger")
    return dedupeRows([...archived, ...store.ledger]).sort((a, b) => a.id - b.id)
  },
  reload: async () => {
    await initDb()
  },
  nextId,
  async transaction<T>(fn: () => T): Promise<T> {
    const run = persistQueue.then(async () => {
      const snap = JSON.parse(JSON.stringify(store)) as Store
      try {
        const r = fn()
        await persistInternal()
        return r
      } catch (e) {
        store = snap
        throw e
      }
    })
    persistQueue = run.then(() => undefined, () => undefined)
    return run
  },
}

export type { Store }
