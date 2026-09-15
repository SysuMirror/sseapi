// 端到端：验证 /api/usage/aggregate 的多维度聚合（day/hour/request × model/type/status）
// 运行：node .e2e-test/usage-aggregate.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'

const PORT = 8095
const BASE = `http://127.0.0.1:${PORT}`
const JWT_SECRET = 'e2e-secret'
const ADMIN_OAUTH = '327'
const serverDir = path.resolve(import.meta.dirname, '..')
const UPSTREAM_BASE = `http://127.0.0.1:${PORT + 1}/v1`

const hashToken = (raw) => createHash('sha256').update(raw).digest('hex')
const b64url = (s) => Buffer.from(JSON.stringify(s)).toString('base64url')
function makeJwt(userId, secret) {
  const header = { alg: 'HS256', typ: 'JWT' }
  const now = Math.floor(Date.now() / 1000)
  const payload = { sub: userId, oauthId: ADMIN_OAUTH, isAdmin: 1, iat: now, exp: now + 3600 }
  const si = `${b64url(header)}.${b64url(payload)}`
  return `${si}.${createHmac('sha256', secret).update(si).digest('base64url')}`
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// 混合数据：2 模型、2 类型、ok/error、覆盖 3 天多小时
const now = Date.now()
const usage_logs = []
let id = 1
const push = (model_slug, model_type, status, ts, prompt, comp, cached, cost) => {
  usage_logs.push({
    id: id++, user_id: 1, api_key_id: 1, model_slug,
    prompt_tokens: prompt, cached_tokens: cached, completion_tokens: comp,
    total_tokens: prompt + comp, image_count: 0, cost_cents: cost,
    status, error_message: status === 'ok' ? '' : 'upstream err', client_meta: '',
    created_at: new Date(ts).toISOString(),
  })
}
// deepseek-v4-flash (chat), qwen (chat), embedding-3 (embedding/bge)
// 基准锚点设为 1 小时前，确保所有时间戳严格在过去（避免 t>to 被排除）
const anchor = now - 3600000
for (let d = 2; d >= 0; d--) {
  for (let h = 0; h < 5; h++) {
    const ts = anchor - d * 86400000 - h * 3600000
    push('deepseek-v4-flash', 'chat', 'ok', ts, 50000 + h, 200 + h, 100, 55)
    push('deepseek-v4-flash', 'chat', 'error', ts + 600000, 0, 0, 0, 0)
    push('qwen3.8-27b-awq', 'chat', 'ok', ts + 1200000, 8000, 50, 0, 8)
    push('bge-m3', 'embedding', 'ok', ts + 1800000, 300, 0, 0, 1)
  }
}

const modelA = (slug, type) => ({ id: type === 'embedding' ? 2 : 1, slug, display_name: slug, badge: '', card_color: '#111', model_type: type, upstream_api_format: 'openai', upstream_path_override: '', upstream_base_url: UPSTREAM_BASE, upstream_model: slug, upstream_api_key: '', allowed_origins: '', rpm_limit: 0, max_concurrent: 0, input_price_per_1m: 1, output_price_per_1m: 1, cache_price_per_1m: 0, multimodal_enabled: 0, image_billing_mode: 'token', image_price_per_1m: 0, image_price_per_image: 0, image_tokens_per_image: 512, thinking_enabled: 0, thinking_levels: '["off"]', default_thinking: 'off', claude_compat: 0, anthropic_base_url: '', anthropic_enabled: 0, responses_base_url: '', responses_enabled: 0, enabled: 1, sort_order: 1 })
const key = { plain: 'sk-e2e-' + Math.random().toString(36).slice(2, 12) }
const store = {
  seq: { users: 1, api_keys: 1, models: 1, usage_logs: usage_logs.length, ledger: 0 },
  users: [{ id: 1, oauth_id: ADMIN_OAUTH, name: 'tester', email: '', avatar_url: '', is_admin: 1, balance_cents: 100000, admin_note: '', rpm_limit: 0, max_concurrent: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
  api_keys: [{ id: 1, user_id: 1, name: 'tester', key_prefix: key.plain.slice(0, 8), key_hash: hashToken(key.plain), allowed_origins: '', rpm_limit: 0, max_concurrent: 0, last_used_at: null, created_at: new Date().toISOString(), revoked_at: null }],
  models: [modelA('deepseek-v4-flash', 'chat'), modelA('qwen3.8-27b-awq', 'chat'), modelA('bge-m3', 'embedding')],
  usage_logs, ledger: [],
  docs: { id: 1, title: 'API 文档', external_url: '', content_md: '', updated_at: new Date().toISOString() },
  oauth_states: [],
  rate_limits: { enabled: 1, default_rpm: 999, default_max_concurrent: 999, updated_at: new Date().toISOString() },
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sseapi-agg-'))
fs.writeFileSync(path.join(dataDir, 'sseapi-store.json'), JSON.stringify(store, null, 2))

const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: serverDir,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, JWT_SECRET, SSEAPI_API_PUBLIC_URL: BASE, PLATFORM_ADMIN_OAUTH_IDS: ADMIN_OAUTH },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let outLog = ''
child.stdout.on('data', (d) => (outLog += d))
child.stderr.on('data', (d) => (outLog += d))

let failed = false
function assert(cond, msg) {
  if (!cond) { failed = true; console.log('FAIL:', msg) } else { console.log('  ok -', msg) }
}
async function boot() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return } catch {}
    await wait(200)
  }
  throw new Error('server 未启动: ' + outLog.slice(-500))
}
async function ag(q = {}) {
  const qs = Object.entries(q).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')
  const r = await fetch(`${BASE}/api/usage/aggregate${qs ? '?' + qs : ''}`, { headers: { authorization: `Bearer ${makeJwt(1, JWT_SECRET)}` } })
  const j = await r.json()
  return { status: r.status, data: j.data || j }
}

async function main() {
  await boot()
  console.log('[boot] server up\n')
  const ADMIN = { authorization: `Bearer ${makeJwt(1, JWT_SECRET)}` }
  const _ = await fetch(`${BASE}/api/usage/aggregate?days=7&granularity=day`, { headers: ADMIN })

  // 1) day 聚合：全量
  console.log('[test] day aggregate (all)')
  const d1 = await ag({ days: 7, granularity: 'day' })
  assert(d1.status === 200 && d1.data, `status 200 (${d1.status})`)
  assert(d1.data.totals.request_count === 60, `total requests = 60 (got ${d1.data.totals.request_count})`)
  assert(d1.data.totals.error_count === 15, `error_count = 15 (got ${d1.data.totals.error_count})`)
  assert(d1.data.byModel.length === 3, `byModel 3 (got ${d1.data.byModel.length})`)
  assert(d1.data.byTime.length >= 3, `byTime buckets >= 3 (got ${d1.data.byTime.length})`)
  assert(d1.data.byStatus.length === 2, `byStatus ok/error (got ${d1.data.byStatus.length})`)
  assert(Array.isArray(d1.data.daily) && d1.data.daily.length >= 3, `daily fixed-day buckets (got ${d1.data.daily?.length})`)
  assert(d1.data.daily[0].tokens != null, `daily bucket has tokens`)

  // 1b) day 下 daily 与 byTime 一致（均按日），但 daily 永远存在
  console.log('[test] day aggregate daily fixed')
  const d1h = await ag({ days: 7, granularity: 'hour' })
  assert(d1h.data.granularity === 'hour', `hour granularity`)
  assert(Array.isArray(d1h.data.daily) && d1h.data.daily.length >= 2, `daily still present under hour grain (got ${d1h.data.daily?.length})`)
  const dailyBucketLen = d1h.data.daily[0]?.bucket?.length ?? 0
  assert(dailyBucketLen === 10, `daily bucket is date-only YYYY-MM-DD (got ${d1h.data.daily[0]?.bucket})`)

  // 2) model 筛选
  console.log('[test] day aggregate filter model=deepseek-v4-flash')
  const d2 = await ag({ days: 7, granularity: 'day', model: 'deepseek-v4-flash' })
  assert(d2.data.totals.request_count === 30, `deepseek requests = 30 (got ${d2.data.totals.request_count})`)
  assert(d2.data.byModel.length === 1, `byModel 1 (got ${d2.data.byModel.length})`)

  // 3) type 筛选 (chat 只含 deepseek+qwen)
  console.log('[test] day aggregate filter type=chat')
  const d3 = await ag({ days: 7, granularity: 'day', type: 'chat' })
  assert(d3.data.totals.request_count === 45, `chat requests = 45 (got ${d3.data.totals.request_count})`)
  assert(d3.data.byModel.length === 2, `chat byModel 2 (got ${d3.data.byModel.length})`)

  // 4) status=error 筛选
  console.log('[test] day aggregate filter status=error')
  const d4 = await ag({ days: 7, granularity: 'day', status: 'error' })
  assert(d4.data.totals.request_count === 15, `error requests = 15 (got ${d4.data.totals.request_count})`)
  assert(d4.data.totals.total_tokens === 0, `error tokens = 0 (got ${d4.data.totals.total_tokens})`)

  // 5) hour 聚合
  console.log('[test] hour aggregate')
  const h1 = await ag({ days: 7, granularity: 'hour' })
  assert(h1.data.granularity === 'hour', `granularity hour`)
  assert(h1.data.byTime.length >= 5, `hour buckets >= 5 (got ${h1.data.byTime.length})`)
  assert(h1.data.byTime[0].bucket.length === 16, `hour bucket format YYYY-MM-DDTHH:00 (got ${h1.data.byTime[0].bucket})`)

  // 6) request 明细
  console.log('[test] request granularity + pagination')
  const r1 = await ag({ days: 7, granularity: 'request', page_size: 20 })
  assert(r1.data.request.total === 60, `request total 60 (got ${r1.data.request.total})`)
  assert(r1.data.request.items.length === 20, `page_size 20 items (got ${r1.data.request.items.length})`)
  assert(r1.data.request.items[0].status, `item has status`)
  assert(typeof r1.data.request.items[0].costYuan === 'number', `item costYuan number`)

  // 7) request + status=error + model 组合筛选
  console.log('[test] request filter model+status')
  const r2 = await ag({ days: 7, granularity: 'request', model: 'deepseek-v4-flash', status: 'error' })
  assert(r2.data.request.total === 15, `deepseek error = 15 (got ${r2.data.request.total})`)
  assert(r2.data.request.items.every((i) => i.status !== 'ok'), `all items are error`)

  // 8) 分页第 2 页
  console.log('[test] request page 2')
  const p2 = await ag({ days: 7, granularity: 'request', page: 2, page_size: 20 })
  assert(p2.data.request.items.length === 20, `page2 has 20 (got ${p2.data.request.items.length})`)
  assert(p2.data.request.items[0].id !== r1.data.request.items[0].id, `page2 id differs from page1`)

  console.log(failed ? '\nUSAGE-AGGREGATE TESTS FAILED' : '\nUSAGE-AGGREGATE TESTS PASSED')
}

main().catch((e) => { failed = true; console.error('\nFAILED:', e.message) }).finally(() => {
  child.kill('SIGTERM')
  fs.rmSync(dataDir, { recursive: true, force: true })
  setTimeout(() => process.exit(failed ? 1 : 0), 100)
})
