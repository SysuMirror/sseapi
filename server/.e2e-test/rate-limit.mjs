// 限流有效性端到端验证
// 场景：
//  A) 并发：模型 max_concurrent=2，并发发 6 个慢请求 → 应恰好 2 个 200，4 个 429
//  B) RPM：模型 rpm_limit=3，连续发 6 个请求 → 前 3 个放行，后 3 个 429
//  C) 释放：并发压测结束后，再次发 1 个 → 应放行（close/finish 能正确复位）
// 运行：node .e2e-test/rate-limit.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'

const PORT = 8102
const BASE = `http://127.0.0.1:${PORT}`
const JWT_SECRET = 'e2e-secret'
const ADMIN_OAUTH = '327'
const serverDir = path.resolve(import.meta.dirname, '..')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const hashToken = (raw) => createHash('sha256').update(raw).digest('hex')
const b64url = (s) => Buffer.from(JSON.stringify(s)).toString('base64url')
function makeJwt(userId) {
  const header = { alg: 'HS256', typ: 'JWT' }
  const now = Math.floor(Date.now() / 1000)
  const payload = { sub: userId, oauthId: ADMIN_OAUTH, isAdmin: 1, iat: now, exp: now + 3600 }
  const si = `${b64url(header)}.${b64url(payload)}`
  return `${si}.${createHmac('sha256', JWT_SECRET).update(si).digest('base64url')}`
}
const keyPlain = 'sk-e2e-' + Math.random().toString(36).slice(2, 12)

let failed = false
function assert(cond, msg) {
  if (!cond) { failed = true; console.log('FAIL:', msg) } else { console.log('  ok -', msg) }
}

// mock 上游：conc-slow 延迟 800ms，普通 0ms
const mock = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {}
    const delay = body.model === 'conc-slow' ? 800 : 0
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'cmpl_x', object: 'chat.completion', model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }))
    }, delay)
  })
})

const modelRow = (slug, rpm, conc) => ({
  id: 1, slug, display_name: slug, badge: '', card_color: '#111', model_type: 'chat',
  upstream_api_format: 'openai', upstream_path_override: '', upstream_base_url: `http://127.0.0.1:${PORT + 1}/v1`,
  upstream_model: slug, upstream_api_key: '', allowed_origins: '', rpm_limit: rpm, max_concurrent: conc,
  input_price_per_1m: 1, output_price_per_1m: 1, cache_price_per_1m: 0, multimodal_enabled: 0,
  image_billing_mode: 'token', image_price_per_1m: 0, image_price_per_image: 0, image_tokens_per_image: 512,
  thinking_enabled: 0, thinking_levels: '["off"]', default_thinking: 'off', claude_compat: 0,
  anthropic_base_url: '', anthropic_enabled: 0, responses_base_url: '', responses_enabled: 0,
  enabled: 1, sort_order: 1,
})

const store = {
  seq: { users: 1, api_keys: 1, models: 3, usage_logs: 0, ledger: 0 },
  users: [{ id: 1, oauth_id: ADMIN_OAUTH, name: 'e2e', email: '', avatar_url: '', is_admin: 1, balance_cents: 100000, admin_note: '', rpm_limit: 0, max_concurrent: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
  api_keys: [{ id: 1, user_id: 1, name: 'e2e', key_prefix: keyPlain.slice(0, 8), key_hash: hashToken(keyPlain), allowed_origins: '', rpm_limit: 0, max_concurrent: 0, last_used_at: null, created_at: new Date().toISOString(), revoked_at: null }],
  models: [
    modelRow('conc-slow', 0, 2),   // A: 并发=2
    modelRow('rpm-fast', 3, 0),     // B: RPM=3
  ],
  usage_logs: [], ledger: [],
  docs: { id: 1, title: 'API 文档', external_url: '', content_md: '', updated_at: new Date().toISOString() },
  oauth_states: [],
  // 关闭默认限流（用模型自身的 limit 验证），避免默认值干扰
  rate_limits: { enabled: 1, default_rpm: 0, default_max_concurrent: 0, updated_at: new Date().toISOString() },
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sseapi-rl-'))
fs.writeFileSync(path.join(dataDir, 'sseapi-store.json'), JSON.stringify(store, null, 2))

const child = spawn(process.execPath, [path.join(process.env.SSEAPI_TEST_BUILD_DIR || path.join(serverDir, 'dist'), 'index.js')], {
  cwd: dataDir,
  env: { PATH: process.env.PATH, PORT: String(PORT), DATA_DIR: dataDir, JWT_SECRET, SSEAPI_API_PUBLIC_URL: BASE, PLATFORM_ADMIN_OAUTH_IDS: ADMIN_OAUTH },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let outLog = ''
child.stdout.on('data', (d) => (outLog += d))
child.stderr.on('data', (d) => (outLog += d))

async function boot() {
  for (let i = 0; i < 40; i++) { try { const r = await fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${keyPlain}` } }); if (r.ok) return } catch {} await wait(200) }
  throw new Error('server 未启动: ' + outLog.slice(-500))
}
const H = { authorization: `Bearer ${keyPlain}` }
async function chat(model, opts = {}) {
  const r = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], ...opts }) })
  return r
}

async function main() {
  await new Promise((r) => mock.listen(PORT + 1, '127.0.0.1', r))
  await boot()
  console.log('[boot] ready\n')

  // A) 并发限制：max_concurrent=2 → 并发 6 个慢请求，应恰好 2 个 200、4 个 429
  console.log('[test A] 并发限制 max_concurrent=2')
  const reqs = Array.from({ length: 6 }, () => chat('conc-slow'))
  const results = await Promise.all(
    reqs.map((p) => p.then((r) => ({ status: r.status })).catch((e) => ({ status: 'ERR:' + (e.message || e.code || e) }))),
  )
  const statuses = results.map((r) => r.status)
  const ok200 = statuses.filter((s) => s === 200).length
  const rate429 = statuses.filter((s) => s === 429).length
  assert(ok200 === 2, `并发下应恰好 2 个 200 (got ${ok200})`)
  assert(rate429 === 4, `并发下应 4 个 429 (got ${rate429})`)
  assert(statuses.every((s) => s === 200 || s === 429), `并发结果只应是 200/429 (got ${statuses.join(',')})`)

  // 等所有请求结束（含 800ms 的慢请求）
  await wait(1200)

  // C) 释放：并发结束后应能再次放行（close/finish 正确复位）
  console.log('[test C] 并发释放后可再次放行')
  const r7 = await chat('conc-slow')
  assert(r7.status === 200, `并发结束后再次请求应 200 (got ${r7.status})`)

  // B) RPM 限制：rpm_limit=3 → 连续 6 个，前 3 放行、后 3 个 429
  console.log('[test B] RPM 限制 rpm_limit=3')
  const rpmRes = []
  for (let i = 0; i < 6; i++) rpmRes.push((await chat('rpm-fast')).status)
  const rpmOk = rpmRes.filter((s) => s === 200).length
  const rpm429 = rpmRes.filter((s) => s === 429).length
  assert(rpmOk === 3, `RPM 下应恰 3 个 200 (got ${rpmOk})`)
  assert(rpm429 === 3, `RPM 下应 3 个 429 (got ${rpm429})`)

  console.log(failed ? '\nRATE-LIMIT TESTS FAILED' : '\nRATE-LIMIT TESTS PASSED')
}
main().catch((e) => { failed = true; console.error('\nFAILED:', e.message) }).finally(() => {
  child.kill('SIGTERM'); mock.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
  setTimeout(() => process.exit(failed ? 1 : 0), 100)
})
