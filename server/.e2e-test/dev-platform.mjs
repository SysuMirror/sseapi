// 端到端：验证管理台「集市开发者身份 + 需求单」对接开发者平台开放 API（SM2 签名）
//  ① dev-platform 生成 SM2 token 能被开发者平台验签（模拟平台验签 + nonce/时间窗）
//  ② /api/usage/by-user 每个用户带 dev 徽标（isDeveloper/roleLabel）
//  ③ /api/usage/by-user/:userId/reqs 拉取需求单
// 运行：node .e2e-test/dev-platform.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sm2 = require('sm-crypto').sm2

const PORT = 8107
const BASE = `http://127.0.0.1:${PORT}`
const DEV_PORT = 8108
const DEV_BASE = `http://127.0.0.1:${DEV_PORT}`
const JWT_SECRET = 'e2e-secret'
const ADMIN_OAUTH = '327'
const MODULE_SLUG = 'platform'
const MODULE_KP = sm2.generateKeyPairHex()
const MODULE_PRIV = MODULE_KP.privateKey
const MODULE_PUB = MODULE_KP.publicKey // 平台侧公钥（本测试用同一配对校验签名）

const serverDir = path.resolve(import.meta.dirname, '..')
const UPSTREAM_BASE = `http://127.0.0.1:${PORT + 100}/v1`
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const hashToken = (raw) => createHash('sha256').update(raw).digest('hex')
const b64url = (s) => Buffer.from(JSON.stringify(s)).toString('base64url')
function makeJwt(userId, isAdmin = 1) {
  const header = { alg: 'HS256', typ: 'JWT' }
  const now = Math.floor(Date.now() / 1000)
  const payload = { sub: userId, oauthId: ADMIN_OAUTH, isAdmin, iat: now, exp: now + 3600 }
  const si = `${b64url(header)}.${b64url(payload)}`
  return `${si}.${createHmac('sha256', JWT_SECRET).update(si).digest('base64url')}`
}

let failed = false
function assert(cond, msg) {
  if (!cond) { failed = true; console.log('FAIL:', msg) } else { console.log('  ok -', msg) }
}

// —— 模拟开发者平台开放 API：验签 + 返回开发者/需求单数据 ——
const devSeenNonce = new Map()
let devCalls = 0
const devApi = http.createServer((req, res) => {
  const raw = String(req.headers['x-model-authorization'] || '')
  const queryTime = String(req.headers['x-model-query-time'] || '')
  const parts = raw.split('.').map((s) => Buffer.from(s, 'base64url').toString('utf8'))
  if (parts.length !== 4) { res.writeHead(400); res.end(JSON.stringify({ code: 400, message: 'token格式错误' })); return }
  const [slug, ts, nonce, sign] = parts
  if (slug !== MODULE_SLUG) { res.writeHead(401); res.end(JSON.stringify({ code: 401, message: '模块不存在' })); return }
  const payload = `${slug}\n${ts}\n${nonce}\n${queryTime}`
  if (Math.abs(Date.now() - Number(ts)) > 5 * 60 * 1000) { res.writeHead(401); res.end(JSON.stringify({ code: 401, message: '时间窗' })); return }
  if (Math.abs(Date.now() - Number(queryTime)) > 60 * 1000) { res.writeHead(401); res.end(JSON.stringify({ code: 401, message: 'queryTime偏差' })); return }
  if (!sm2.doVerifySignature(payload, sign, MODULE_PUB, { hash: true, der: false })) { res.writeHead(401); res.end(JSON.stringify({ code: 401, message: 'SM2验签失败' })); return }
  if (devSeenNonce.has(nonce)) { res.writeHead(401); res.end(JSON.stringify({ code: 401, message: 'nonce重放' })); return }
  devSeenNonce.set(nonce, Date.now())
  devCalls++

  let body = null
  if (req.url.startsWith('/api/open/developers/check')) {
    const oauthId = new URL(req.url, DEV_BASE).searchParams.get('oauthId')
    if (oauthId === '999') {
      body = { found: true, isDeveloper: true, isAdmin: false, userId: 42, oauthId, name: 'Bob', nickname: '', displayName: 'Bob', profile: {} }
    } else if (oauthId === '555') {
      body = { found: true, isDeveloper: false, isAdmin: true, userId: 55, oauthId, name: 'Admin', nickname: '', displayName: 'Admin', profile: {} }
    } else {
      body = { found: false, isDeveloper: false, isAdmin: false, userId: null, oauthId, name: '', nickname: '', displayName: '' }
    }
  } else if (req.url.startsWith('/api/open/users/42/reqs')) {
    body = {
      page: 1, pageSize: 50, total: 2,
      items: [
        { id: 1, title: '需求A：API网关限流', description: '', bizId: 1, bizName: '基础服务', stage: 'dev', stageLabel: '开发中', priority: 1, dueDate: '2026-09-20', archived: false, ownerUserId: 42, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z' },
        { id: 2, title: '需求B：模块鉴权', description: '', bizId: 1, bizName: '基础服务', stage: 'review', stageLabel: '评审中', priority: 2, dueDate: '', archived: false, ownerUserId: 42, createdAt: '2026-09-02T00:00:00Z', updatedAt: '2026-09-06T00:00:00Z' },
      ],
      user: { userId: 42, oauthId: '999', name: 'Bob', nickname: '', displayName: 'Bob' },
    }
  } else if (req.url.startsWith('/api/open/users/55/reqs')) {
    body = { page: 1, pageSize: 50, total: 0, items: [], user: { userId: 55 } }
  } else {
    res.writeHead(404); res.end(JSON.stringify({ code: 404, message: 'not found' })); return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ code: 0, message: 'ok', data: body }))
})

const modelRow = (slug, type = 'chat') => ({
  id: 1, slug, display_name: slug, badge: '', card_color: '#111', model_type: type,
  upstream_api_format: 'openai', upstream_path_override: '', upstream_base_url: UPSTREAM_BASE,
  upstream_model: slug, upstream_api_key: '', allowed_origins: '', rpm_limit: 0, max_concurrent: 0,
  input_price_per_1m: 1, output_price_per_1m: 1, cache_price_per_1m: 0, multimodal_enabled: 0,
  image_billing_mode: 'token', image_price_per_1m: 0, image_price_per_image: 0, image_tokens_per_image: 512,
  thinking_enabled: 0, thinking_levels: '["off"]', default_thinking: 'off', claude_compat: 0,
  anthropic_base_url: '', anthropic_enabled: 0, responses_base_url: '', responses_enabled: 0,
  enabled: 1, sort_order: 1,
})

const keyA = { plain: 'sk-e2e-' + Math.random().toString(36).slice(2, 12) }
const keyB = { plain: 'sk-e2e-' + Math.random().toString(36).slice(2, 12) }
const keyC = { plain: 'sk-e2e-' + Math.random().toString(36).slice(2, 12) }
const store = {
  seq: { users: 3, api_keys: 3, models: 1, usage_logs: 3, ledger: 0 },
  users: [
    { id: 1, oauth_id: ADMIN_OAUTH, name: 'Alice', email: '', avatar_url: '', is_admin: 1, balance_cents: 100000, admin_note: '', rpm_limit: 0, max_concurrent: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { id: 2, oauth_id: '999', name: 'Bob', email: '', avatar_url: '', is_admin: 0, balance_cents: 100000, admin_note: '', rpm_limit: 0, max_concurrent: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { id: 3, oauth_id: '555', name: 'Carol', email: '', avatar_url: '', is_admin: 0, balance_cents: 100000, admin_note: '', rpm_limit: 0, max_concurrent: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  ],
  api_keys: [
    { id: 1, user_id: 1, name: 'k', key_prefix: keyA.plain.slice(0, 8), key_hash: hashToken(keyA.plain), allowed_origins: '', rpm_limit: 0, max_concurrent: 0, last_used_at: null, created_at: new Date().toISOString(), revoked_at: null },
    { id: 2, user_id: 2, name: 'k', key_prefix: keyB.plain.slice(0, 8), key_hash: hashToken(keyB.plain), allowed_origins: '', rpm_limit: 0, max_concurrent: 0, last_used_at: null, created_at: new Date().toISOString(), revoked_at: null },
    { id: 3, user_id: 3, name: 'k', key_prefix: keyC.plain.slice(0, 8), key_hash: hashToken(keyC.plain), allowed_origins: '', rpm_limit: 0, max_concurrent: 0, last_used_at: null, created_at: new Date().toISOString(), revoked_at: null },
  ],
  models: [modelRow('deepseek-v4-flash')],
  usage_logs: [
    { id: 1, user_id: 1, api_key_id: 1, model_slug: 'deepseek-v4-flash', prompt_tokens: 10, cached_tokens: 0, completion_tokens: 5, total_tokens: 15, image_count: 0, cost_cents: 2, status: 'ok', error_message: '', client_meta: '', prompt: 'Alice 需求', created_at: new Date().toISOString() },
    { id: 2, user_id: 2, api_key_id: 2, model_slug: 'deepseek-v4-flash', prompt_tokens: 12, cached_tokens: 0, completion_tokens: 4, total_tokens: 16, image_count: 0, cost_cents: 2, status: 'ok', error_message: '', client_meta: '', prompt: 'Bob 需求', created_at: new Date().toISOString() },
    { id: 3, user_id: 3, api_key_id: 3, model_slug: 'deepseek-v4-flash', prompt_tokens: 8, cached_tokens: 0, completion_tokens: 6, total_tokens: 14, image_count: 0, cost_cents: 2, status: 'ok', error_message: '', client_meta: '', prompt: 'Carol 需求', created_at: new Date().toISOString() },
  ],
  ledger: [],
  docs: { id: 1, title: 'API 文档', external_url: '', content_md: '', updated_at: new Date().toISOString() },
  oauth_states: [],
  rate_limits: { enabled: 1, default_rpm: 999, default_max_concurrent: 999, updated_at: new Date().toISOString() },
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sseapi-devp-'))
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

async function main() {
  await new Promise((r) => devApi.listen(DEV_PORT, '127.0.0.1', r))
  await boot()
  console.log('[boot] ready\n')

  const ADMIN = { authorization: `Bearer ${makeJwt(1)}` }

  // ① by-user 每个用户带 dev 徽标
  console.log('[test] by-user 开发者徽标')
  const bu = await fetch(`${BASE}/api/usage/by-user?days=30`, { headers: ADMIN })
  const buj = await bu.json()
  assert(bu.status === 200, `by-user 200 (${bu.status})`)
  assert(buj.data.devChecked === true, `devChecked=true`)
  const alice = buj.data.byUser.find((u) => u.user_id === 1)
  const bob = buj.data.byUser.find((u) => u.user_id === 2)
  const carol = buj.data.byUser.find((u) => u.user_id === 3)
  assert(alice && alice.dev && alice.dev.roleLabel === '普通用户', `alice 普通用户 (got ${JSON.stringify(alice?.dev)})`)
  assert(bob && bob.dev && bob.dev.roleLabel === '开发者', `bob 开发者 (got ${bob?.dev?.roleLabel})`)
  assert(carol && carol.dev && carol.dev.roleLabel === '管理员', `carol 管理员 (got ${carol?.dev?.roleLabel})`)
  assert(devCalls >= 3, `至少 3 次开发者平台调用 (got ${devCalls})`)

  // ② bob 的需求单
  console.log('[test] bob 需求单')
  const qr = await fetch(`${BASE}/api/usage/by-user/2/reqs`, { headers: ADMIN })
  const qj = await qr.json()
  assert(qr.status === 200, `reqs 200 (${qr.status})`)
  assert(qj.data.isDeveloper === true, `isDeveloper=true`)
  assert(qj.data.reqs.total === 2, `reqs total=2 (got ${qj.data.reqs.total})`)
  assert(qj.data.reqs.items[0].bizName === '基础服务', `需求含业务名`)

  // ③ carol（平台管理员）需求单为空
  console.log('[test] carol(管理员) 需求单')
  const cr = await fetch(`${BASE}/api/usage/by-user/3/reqs`, { headers: ADMIN })
  const cj = await cr.json()
  assert(cj.data.isDeveloper === true, `carol isDeveloper=true (管理员也算)`)
  assert(cj.data.reqs.total === 0, `carol reqs total=0`)

  // ④ 普通用户禁止访问 reqs
  console.log('[test] 非管理员禁止 reqs')
  const nr = await fetch(`${BASE}/api/usage/by-user/2/reqs`, { headers: { authorization: `Bearer ${makeJwt(2, 0)}` } })
  assert(nr.status === 403, `普通用户 reqs 403 (got ${nr.status})`)

  console.log(failed ? '\nDEV-PLATFORM TESTS FAILED' : '\nDEV-PLATFORM TESTS PASSED')
}
main().catch((e) => { failed = true; console.error('\nFAILED:', e.message) }).finally(() => {
  child.kill('SIGTERM'); devApi.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
  setTimeout(() => process.exit(failed ? 1 : 0), 100)
})
