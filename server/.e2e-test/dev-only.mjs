// 端到端：验证「仅开发者可见/可调用」模型（dev_only）
// 场景：
//  ① 管理员 /api/models 能看到 dev_only 模型
//  ② 开发者(oauth 999) /api/models 能看到 dev_only 模型
//  ③ 普通用户(oauth 555) /api/models 看不到 dev_only 模型（但能看到普通模型）
//  ④ 开发者可正常调用 dev_only 模型（chat）
//  ⑤ 普通用户调用 dev_only 模型 → 403 dev_only_forbidden
//  ⑥ /v1/models 列表：开发者可见 dev_only，普通用户不可见
// 运行：node .e2e-test/dev-only.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sm2 = require('sm-crypto').sm2

const PORT = 8111
const BASE = `http://127.0.0.1:${PORT}`
const DEV_PORT = 8112
const DEV_BASE = `http://127.0.0.1:${DEV_PORT}`
const UPSTREAM_PORT = 8113
const UPSTREAM_BASE = `http://127.0.0.1:${UPSTREAM_PORT}/v1`
const JWT_SECRET = 'e2e-secret'
const ADMIN_OAUTH = '327'
const MODULE_SLUG = 'platform'
const MODULE_KP = sm2.generateKeyPairHex()
const MODULE_PRIV = MODULE_KP.privateKey
const MODULE_PUB = MODULE_KP.publicKey

const serverDir = path.resolve(import.meta.dirname, '..')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const hashToken = (raw) => createHash('sha256').update(raw).digest('hex')
const b64url = (s) => Buffer.from(JSON.stringify(s)).toString('base64url')
const OAUTH_BY_ID = { 1: ADMIN_OAUTH, 2: '999', 3: '555' }
function makeJwt(userId, isAdmin = 0) {
  const header = { alg: 'HS256', typ: 'JWT' }
  const now = Math.floor(Date.now() / 1000)
  const payload = { sub: userId, oauthId: OAUTH_BY_ID[userId], isAdmin, iat: now, exp: now + 3600 }
  const si = `${b64url(header)}.${b64url(payload)}`
  return `${si}.${createHmac('sha256', JWT_SECRET).update(si).digest('base64url')}`
}

let failed = false
function assert(cond, msg) {
  if (!cond) { failed = true; console.log('FAIL:', msg) } else { console.log('  ok -', msg) }
}

// mock 开发者平台：999=开发者，555=普通，其余=未找到
const devApi = http.createServer((req, res) => {
  const raw = String(req.headers['x-model-authorization'] || '')
  const queryTime = String(req.headers['x-model-query-time'] || '')
  const parts = raw.split('.').map((s) => Buffer.from(s, 'base64url').toString('utf8'))
  if (parts.length !== 4) { res.writeHead(400); res.end(JSON.stringify({ code: 400 })); return }
  const [slug, ts, nonce, sign] = parts
  if (slug !== MODULE_SLUG) { res.writeHead(401); res.end(JSON.stringify({ code: 401 })); return }
  const payload = `${slug}\n${ts}\n${nonce}\n${queryTime}`
  if (!sm2.doVerifySignature(payload, sign, MODULE_PUB, { hash: true, der: false })) { res.writeHead(401); res.end(JSON.stringify({ code: 401 })); return }
  let body = null
  if (req.url.startsWith('/api/open/developers/check')) {
    const oauthId = new URL(req.url, DEV_BASE).searchParams.get('oauthId')
    if (oauthId === '999') body = { found: true, isDeveloper: true, isAdmin: false, userId: 2, oauthId, name: 'Bob', displayName: 'Bob' }
    else if (oauthId === '555') body = { found: true, isDeveloper: false, isAdmin: false, userId: 3, oauthId, name: 'Carol', displayName: 'Carol' }
    else body = { found: false, isDeveloper: false, isAdmin: false, userId: null, oauthId, name: '', displayName: '' }
  } else { res.writeHead(404); res.end(JSON.stringify({ code: 404 })); return }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ code: 0, message: 'ok', data: body }))
})

// mock 上游：chat 返回 ok
let upstreamHits = 0
const upstream = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {}
    upstreamHits++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: 'cmpl_d' + upstreamHits, object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } },
    }))
  })
})

const modelRow = (slug, devOnly) => ({
  id: 0, slug, display_name: slug, badge: '', card_color: '#111', model_type: 'chat',
  upstream_api_format: 'openai', upstream_path_override: '', upstream_base_url: UPSTREAM_BASE,
  upstream_model: slug, upstream_api_key: '', allowed_origins: '', rpm_limit: 0, max_concurrent: 0,
  input_price_per_1m: 1, output_price_per_1m: 1, cache_price_per_1m: 0, multimodal_enabled: 0,
  image_billing_mode: 'token', image_price_per_1m: 0, image_price_per_image: 0, image_tokens_per_image: 512,
  thinking_enabled: 0, thinking_levels: '["off"]', default_thinking: 'off', claude_compat: 0,
  anthropic_base_url: '', anthropic_enabled: 0, responses_base_url: '', responses_enabled: 0,
  context_length: 0, dev_only: devOnly ? 1 : 0, enabled: 1, sort_order: 1,
})

const keyAdmin = { plain: 'sk-e2e-' + Math.random().toString(36).slice(2, 12) }
const keyDev = { plain: 'sk-e2e-' + Math.random().toString(36).slice(2, 12) }
const keyNormal = { plain: 'sk-e2e-' + Math.random().toString(36).slice(2, 12) }
const store = {
  seq: { users: 3, api_keys: 3, models: 2, usage_logs: 0, ledger: 0 },
  users: [
    { id: 1, oauth_id: ADMIN_OAUTH, name: 'Alice', email: '', avatar_url: '', is_admin: 1, balance_cents: 100000, admin_note: '', rpm_limit: 0, max_concurrent: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { id: 2, oauth_id: '999', name: 'Bob', email: '', avatar_url: '', is_admin: 0, balance_cents: 100000, admin_note: '', rpm_limit: 0, max_concurrent: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { id: 3, oauth_id: '555', name: 'Carol', email: '', avatar_url: '', is_admin: 0, balance_cents: 100000, admin_note: '', rpm_limit: 0, max_concurrent: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  ],
  api_keys: [
    { id: 1, user_id: 1, name: 'k', key_prefix: keyAdmin.plain.slice(0, 8), key_hash: hashToken(keyAdmin.plain), allowed_origins: '', rpm_limit: 0, max_concurrent: 0, last_used_at: null, created_at: new Date().toISOString(), revoked_at: null },
    { id: 2, user_id: 2, name: 'k', key_prefix: keyDev.plain.slice(0, 8), key_hash: hashToken(keyDev.plain), allowed_origins: '', rpm_limit: 0, max_concurrent: 0, last_used_at: null, created_at: new Date().toISOString(), revoked_at: null },
    { id: 3, user_id: 3, name: 'k', key_prefix: keyNormal.plain.slice(0, 8), key_hash: hashToken(keyNormal.plain), allowed_origins: '', rpm_limit: 0, max_concurrent: 0, last_used_at: null, created_at: new Date().toISOString(), revoked_at: null },
  ],
  models: [modelRow('dev-secret', true), modelRow('public-model', false)],
  usage_logs: [], ledger: [],
  docs: { id: 1, title: 'docs', external_url: '', content_md: '', updated_at: new Date().toISOString() },
  oauth_states: [],
  rate_limits: { enabled: 1, default_rpm: 999, default_max_concurrent: 999, updated_at: new Date().toISOString() },
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sseapi-devonly-'))
fs.writeFileSync(path.join(dataDir, 'sseapi-store.json'), JSON.stringify(store, null, 2))

const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: serverDir,
  env: {
    ...process.env, PORT: String(PORT), DATA_DIR: dataDir, JWT_SECRET,
    SSEAPI_API_PUBLIC_URL: BASE, PLATFORM_ADMIN_OAUTH_IDS: ADMIN_OAUTH,
    DEVELOPER_API_BASE: DEV_BASE, DEVELOPER_MODULE_SLUG: MODULE_SLUG, DEVELOPER_MODULE_PRIVATE_KEY: MODULE_PRIV,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let outLog = ''
child.stdout.on('data', (d) => (outLog += d))
child.stderr.on('data', (d) => (outLog += d))

async function boot() {
  for (let i = 0; i < 40; i++) { try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return } catch {} await wait(200) }
  throw new Error('server 未启动: ' + outLog.slice(-500))
}
async function consoleModels(jwt) {
  const r = await fetch(`${BASE}/api/models`, { headers: { authorization: `Bearer ${jwt}` } })
  const j = await r.json()
  return j.data
}
async function v1Models(key) {
  const r = await fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${key}` } })
  const j = await r.json()
  return j.data
}
async function chat(key, model) {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream: false }),
  })
  return r
}

async function main() {
  await new Promise((r) => devApi.listen(DEV_PORT, '127.0.0.1', r))
  await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r))
  await boot()
  console.log('[boot] ready\n')

  const slugOf = (a) => (a || []).map((m) => m.slug)

  // ① 管理员可见 dev_only
  console.log('[test] 管理员 /api/models 可见 dev_only')
  const adm = await consoleModels(makeJwt(1, 1))
  assert(slugOf(adm).includes('dev-secret'), `管理员见 dev-secret (got ${slugOf(adm).join(',')})`)

  // ② 开发者可见 dev_only
  console.log('[test] 开发者 /api/models 可见 dev_only')
  const dev = await consoleModels(makeJwt(2, 0))
  assert(slugOf(dev).includes('dev-secret'), `开发者见 dev-secret (got ${slugOf(dev).join(',')})`)

  // ③ 普通用户不可见 dev_only
  console.log('[test] 普通用户 /api/models 隐藏 dev_only')
  const nor = await consoleModels(makeJwt(3, 0))
  assert(!slugOf(nor).includes('dev-secret'), `普通用户不见 dev-secret (got ${slugOf(nor).join(',')})`)
  assert(slugOf(nor).includes('public-model'), `普通用户见 public-model (got ${slugOf(nor).join(',')})`)

  // ④ 开发者可调用 dev_only
  console.log('[test] 开发者调用 dev_only → 200')
  const devCall = await chat(keyDev.plain, 'dev-secret')
  assert(devCall.status === 200, `开发者调用 200 (got ${devCall.status})`)

  // ⑤ 普通用户调用 dev_only → 403
  console.log('[test] 普通用户调用 dev_only → 403')
  const norCall = await chat(keyNormal.plain, 'dev-secret')
  const nc = await norCall.json()
  assert(norCall.status === 403, `普通用户调用 403 (got ${norCall.status})`)
  assert(nc.error?.type === 'dev_only_forbidden', `error.type=dev_only_forbidden (got ${nc.error?.type})`)

  // ⑥ /v1/models 列表
  console.log('[test] /v1/models 列表')
  const v1dev = await v1Models(keyDev.plain)
  assert(slugOf(v1dev).includes('dev-secret'), `/v1/models 开发者见 dev-secret (got ${slugOf(v1dev).join(',')})`)
  const v1nor = await v1Models(keyNormal.plain)
  assert(!slugOf(v1nor).includes('dev-secret'), `/v1/models 普通用户不见 dev-secret (got ${slugOf(v1nor).join(',')})`)

  console.log(failed ? '\nDEV-ONLY TESTS FAILED' : '\nDEV-ONLY TESTS PASSED')
}
main().catch((e) => { failed = true; console.error('\nFAILED:', e.message) }).finally(() => {
  child.kill('SIGTERM'); devApi.close(); upstream.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
  setTimeout(() => process.exit(failed ? 1 : 0), 100)
})
