// 浏览器验证「用量」页新聚合 UI：注入多模型/多状态/多小时的 usage_logs，
// 启动后端（同时 serve ../web/dist 前端）→ 供浏览器导航验证过滤器、日/时桶图、调用明细。
// 手动运行：node .e2e-test/live-usage.mjs  然后浏览器打开 http://127.0.0.1:8098
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'

const PORT = 8098
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

const now = Date.now()
const anchor = now - 3600000
const usage_logs = []
let id = 1
const push = (model_slug, status, ts, prompt, comp, cached, cost) => {
  usage_logs.push({
    id: id++, user_id: 1, api_key_id: 1, model_slug,
    prompt_tokens: prompt, cached_tokens: cached, completion_tokens: comp,
    total_tokens: prompt + comp, image_count: 0, cost_cents: cost,
    status, error_message: status === 'ok' ? '' : 'upstream err', client_meta: '',
    created_at: new Date(ts).toISOString(),
  })
}
for (let d = 6; d >= 0; d--) {
  for (let h = 0; h < 8; h++) {
    const ts = anchor - d * 86400000 - h * 3600000
    push('deepseek-v4-flash', 'ok', ts, 30000 + h * 200, 150 + h, 40, 33)
    push('deepseek-v4-flash', 'error', ts + 600000, 0, 0, 0, 0)
    push('qwen3.8-27b-awq', 'ok', ts + 1200000, 6000, 60, 0, 6)
    push('bge-m3', 'ok', ts + 1800000, 200, 0, 0, 1)
  }
}

const model = (slug, type, idn) => ({ id: idn, slug, display_name: slug, badge: '', card_color: '#111', model_type: type, upstream_api_format: 'openai', upstream_path_override: '', upstream_base_url: UPSTREAM_BASE, upstream_model: slug, upstream_api_key: '', allowed_origins: '', rpm_limit: 0, max_concurrent: 0, input_price_per_1m: 1, output_price_per_1m: 1, cache_price_per_1m: 0, multimodal_enabled: 0, image_billing_mode: 'token', image_price_per_1m: 0, image_price_per_image: 0, image_tokens_per_image: 512, thinking_enabled: 0, thinking_levels: '["off"]', default_thinking: 'off', claude_compat: 0, anthropic_base_url: '', anthropic_enabled: 0, responses_base_url: '', responses_enabled: 0, enabled: 1, sort_order: 1 })
const key = { plain: 'sk-e2e-' + Math.random().toString(36).slice(2, 12) }
const store = {
  seq: { users: 1, api_keys: 1, models: 1, usage_logs: usage_logs.length, ledger: 0 },
  users: [{ id: 1, oauth_id: ADMIN_OAUTH, name: 'tester', email: '', avatar_url: '', is_admin: 1, balance_cents: 100000, admin_note: '', rpm_limit: 0, max_concurrent: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
  api_keys: [{ id: 1, user_id: 1, name: 'tester', key_prefix: key.plain.slice(0, 8), key_hash: hashToken(key.plain), allowed_origins: '', rpm_limit: 0, max_concurrent: 0, last_used_at: null, created_at: new Date().toISOString(), revoked_at: null }],
  models: [model('deepseek-v4-flash', 'chat', 1), model('qwen3.8-27b-awq', 'chat', 2), model('bge-m3', 'embedding', 3), { ...model('bge-reranker', 'rerank', 4), upstream_api_format: 'siliconflow', upstream_model: 'BAAI/bge-reranker-v2-m3' }],
  usage_logs, ledger: [],
  docs: { id: 1, title: 'API 文档', external_url: '', content_md: '', updated_at: new Date().toISOString() },
  oauth_states: [],
  rate_limits: { enabled: 1, default_rpm: 999, default_max_concurrent: 999, updated_at: new Date().toISOString() },
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sseapi-live-'))
fs.writeFileSync(path.join(dataDir, 'sseapi-store.json'), JSON.stringify(store, null, 2))

const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: serverDir,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, JWT_SECRET, SSEAPI_API_PUBLIC_URL: BASE, PLATFORM_ADMIN_OAUTH_IDS: ADMIN_OAUTH },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let outLog = ''
child.stdout.on('data', (d) => (outLog += d))
child.stderr.on('data', (d) => (outLog += d))

async function boot() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('server 未启动: ' + outLog.slice(-500))
}

async function main() {
  await boot()
  console.log(`[boot] usage UI live at ${BASE}  (接口: /api/usage/aggregate)`)
  console.log('JWT:', makeJwt(1, JWT_SECRET))
  // 预热一次请求用于 console
  const r = await fetch(`${BASE}/api/usage/aggregate?days=7&granularity=day`, { headers: { authorization: `Bearer ${makeJwt(1, JWT_SECRET)}` } })
  const j = await r.json()
  console.log('aggregate totals:', JSON.stringify(j.data?.totals))
  console.log('byTime buckets:', (j.data?.byTime || []).length)
  console.log('前端的登录流程需使用上文 JWT 注入 localStorage，或用页面 OAuth 登录（mock 环境需代理 /api/auth/oauth/*）。')
  console.log(`\n[ready] 保持运行。Ctrl+C 退出。`)
}

main().catch((e) => { console.error('FAILED:', e.message); child.kill('SIGTERM') })
