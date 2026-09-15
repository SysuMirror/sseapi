// 端到端验证概览页「用量趋势」折线图的数据链路：
// 注入带历史 usage_logs 的 store（覆盖最近 30 天、含北京时区边界），
// 启动真实后端 → 用 JWT 调 /api/usage/summary → 打印 byDay 与前端 bars 高度，
// 并断言 byDay 有内容、柱子高度正确。从而判断图是否应渲染出柱子。

import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'

const require = createRequire(import.meta.url)

const PORT = 8097
const BASE = `http://127.0.0.1:${PORT}`
const JWT_SECRET = 'e2e-secret'
const ADMIN_OAUTH = '327'
const serverDir = path.resolve(import.meta.dirname, '..')
const UPSTREAM_BASE = `http://127.0.0.1:${PORT + 1}/v1`

function hashToken(raw) {
  return createHash('sha256').update(raw).digest('hex')
}
function b64url(s) {
  return Buffer.from(s).toString('base64url')
}
function makeJwt(userId, secret) {
  const header = { alg: 'HS256', typ: 'JWT' }
  const now = Math.floor(Date.now() / 1000)
  const payload = { sub: userId, oauthId: ADMIN_OAUTH, isAdmin: 1, iat: now, exp: now + 3600 }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const sig = createHmac('sha256', secret).update(signingInput).digest('base64url')
  return `${signingInput}.${sig}`
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// —— 模拟最近 30 天历史用量：每天分散若干条，覆盖北京时间凌晨边界 ——
const now = Date.now()
const usage_logs = []
let id = 1
for (let dayOffset = 30; dayOffset >= 0; dayOffset--) {
  // 每天 3~8 条，tokens 递增
  const n = 3 + ((dayOffset % 6))
  for (let i = 0; i < n; i++) {
    const ts = now - dayOffset * 86400000 - i * 3600000 - 7 * 3600000 // 偏北京凌晨
    usage_logs.push({
      id: id++,
      user_id: 1,
      api_key_id: 1,
      model_slug: 'deepseek-v4-flash',
      prompt_tokens: 50000 + dayOffset * 100 + i * 50,
      cached_tokens: 0,
      completion_tokens: 120 + i * 3,
      total_tokens: 50000 + dayOffset * 100 + i * 50 + 120 + i * 3,
      image_count: 0,
      cost_cents: 50 + i,
      status: 'ok',
      error_message: '',
      client_meta: '',
      created_at: new Date(ts).toISOString(),
    })
  }
}

const model = { id: 1, slug: 'chat-mock', display_name: 'Chat', badge: '', card_color: '#111', model_type: 'chat', upstream_api_format: 'openai', upstream_path_override: '', upstream_base_url: UPSTREAM_BASE, upstream_model: 'chat-mock', upstream_api_key: '', allowed_origins: '', rpm_limit: 0, max_concurrent: 0, input_price_per_1m: 1, output_price_per_1m: 1, cache_price_per_1m: 0, multimodal_enabled: 0, image_billing_mode: 'token', image_price_per_1m: 0, image_price_per_image: 0, image_tokens_per_image: 512, thinking_enabled: 0, thinking_levels: '["off"]', default_thinking: 'off', claude_compat: 0, anthropic_base_url: '', anthropic_enabled: 0, responses_base_url: '', responses_enabled: 0, enabled: 1, sort_order: 1 }
const key = { plain: 'sk-e2e-' + Math.random().toString(36).slice(2, 12), }
const store = {
  seq: { users: 1, api_keys: 1, models: 1, usage_logs: usage_logs.length, ledger: 0 },
  users: [{ id: 1, oauth_id: ADMIN_OAUTH, name: 'tester', email: '', avatar_url: '', is_admin: 1, balance_cents: 100000, admin_note: '', rpm_limit: 0, max_concurrent: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
  api_keys: [{ id: 1, user_id: 1, name: 'tester', key_prefix: key.plain.slice(0, 8), key_hash: hashToken(key.plain), allowed_origins: '', rpm_limit: 0, max_concurrent: 0, last_used_at: null, created_at: new Date().toISOString(), revoked_at: null }],
  models: [model],
  usage_logs,
  ledger: [],
  docs: { id: 1, title: 'API 文档', external_url: '', content_md: '', updated_at: new Date().toISOString() },
  oauth_states: [],
  rate_limits: { enabled: 1, default_rpm: 999, default_max_concurrent: 999, updated_at: new Date().toISOString() },
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sseapi-chart-'))
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

async function main() {
  await boot()
  console.log('[boot] server up\n')
  const ADMIN_H = { authorization: `Bearer ${makeJwt(1, JWT_SECRET)}` }

  // 调用 /api/usage/summary
  const r = await fetch(`${BASE}/api/usage/summary?days=30`, { headers: ADMIN_H })
  const j = await r.json()
  const d = j.data || j
  console.log('summary.totals:', JSON.stringify(d.totals))
  console.log('byDay count:', (d.byDay || []).length)
  console.log('byDay samples:', JSON.stringify((d.byDay || []).slice(0, 3)))
  console.log('byDay last:', JSON.stringify((d.byDay || []).slice(-2)))

  // 复现前端 bars 计算
  const list = d.byDay || []
  const max = Math.max(1, ...list.map((x) => x.tokens || 0))
  const bars = list.map((x) => ({ day: x.day, tokens: x.tokens, h: Math.max(4, Math.round(((x.tokens || 0) / max) * 100)) }))
  console.log('bars (frontend模拟) 高度>0 数量:', bars.filter((b) => b.h > 0).length, '/', bars.length)
  console.log('bars nonzero sample:', JSON.stringify(bars.filter((b) => b.tokens > 0).slice(0, 3)))

  assert(r.ok, `api ok (status=${r.status})`)
  assert(d.totals && d.totals.request_count > 0, `totals.request_count >0`)
  assert(Array.isArray(d.byDay) && d.byDay.length > 0, `byDay has entries (got ${(d.byDay || []).length})`)
  assert(bars.some((b) => b.h > 4), `at least one bar has real height (>4%)`)
  assert(bars.some((b) => b.tokens > 10000), `some day has substantial tokens`)

  console.log(failed ? '\nUSAGE-CHART TESTS FAILED' : '\nUSAGE-CHART TESTS PASSED')
}

main()
  .catch((e) => { failed = true; console.error('\nFAILED:', e.message) })
  .finally(() => { child.kill('SIGTERM'); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(failed ? 1 : 0) })
