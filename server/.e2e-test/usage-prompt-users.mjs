// 端到端：验证 ① /v1 调用时 usage_logs 记录提示词 prompt ② /api/usage/by-user 管理台按用户聚合
// 运行：node .e2e-test/usage-prompt-users.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'

const PORT = 8105
const BASE = `http://127.0.0.1:${PORT}`
const JWT_SECRET = 'e2e-secret'
const ADMIN_OAUTH = '327'
const serverDir = path.resolve(import.meta.dirname, '..')
const UPSTREAM_BASE = `http://127.0.0.1:${PORT + 1}/v1`
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

let failed = false
function assert(cond, msg) {
  if (!cond) { failed = true; console.log('FAIL:', msg) } else { console.log('  ok -', msg) }
}

// 上游 mock
const mock = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {}
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: 'cmpl_z', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: '你好！' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, prompt_tokens_details: { cached_tokens: 0 } },
    }))
  })
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
const store = {
  seq: { users: 2, api_keys: 2, models: 1, usage_logs: 0, ledger: 0 },
  users: [
    { id: 1, oauth_id: ADMIN_OAUTH, name: 'Alice', email: '', avatar_url: '', is_admin: 1, balance_cents: 100000, admin_note: '', rpm_limit: 0, max_concurrent: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { id: 2, oauth_id: '999', name: 'Bob', email: '', avatar_url: '', is_admin: 0, balance_cents: 100000, admin_note: '', rpm_limit: 0, max_concurrent: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  ],
  api_keys: [
    { id: 1, user_id: 1, name: 'k', key_prefix: keyA.plain.slice(0, 8), key_hash: hashToken(keyA.plain), allowed_origins: '', rpm_limit: 0, max_concurrent: 0, last_used_at: null, created_at: new Date().toISOString(), revoked_at: null },
    { id: 2, user_id: 2, name: 'k', key_prefix: keyB.plain.slice(0, 8), key_hash: hashToken(keyB.plain), allowed_origins: '', rpm_limit: 0, max_concurrent: 0, last_used_at: null, created_at: new Date().toISOString(), revoked_at: null },
  ],
  models: [modelRow('deepseek-v4-flash')],
  usage_logs: [], ledger: [],
  docs: { id: 1, title: 'API 文档', external_url: '', content_md: '', updated_at: new Date().toISOString() },
  oauth_states: [],
  rate_limits: { enabled: 1, default_rpm: 999, default_max_concurrent: 999, updated_at: new Date().toISOString() },
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sseapi-pu-'))
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
  for (let i = 0; i < 40; i++) { try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return } catch {} await wait(200) }
  throw new Error('server 未启动: ' + outLog.slice(-500))
}
async function chat(key, messages) {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4-flash', messages, stream: false }),
  })
  return r
}

async function main() {
  await new Promise((r) => mock.listen(PORT + 1, '127.0.0.1', r))
  await boot()
  console.log('[boot] ready\n')

  // 1) Alice 发一条带提示词的 chat → 日志应记录 prompt
  console.log('[test] chat 记录提示词')
  await chat(keyA.plain, [{ role: 'user', content: '帮我写一首关于春天的诗' }])
  await wait(150)
  const ADMIN = { authorization: `Bearer ${makeJwt(1)}` }
  const lr = await fetch(`${BASE}/api/usage/logs?days=30&page_size=10`, { headers: ADMIN })
  const lj = await lr.json()
  const item = lj.data.items[0]
  assert(item && item.prompt_tokens === 12, `日志 prompt_tokens=12 (got ${item?.prompt_tokens})`)
  assert(typeof item.prompt === 'string' && item.prompt.includes('春天'), `日志含提示词 (got ${JSON.stringify(item.prompt)})`)
  assert(item.model_type === 'chat', `日志 model_type=chat (got ${item.model_type})`)
  assert(lj.data.total >= 1, `日志 total>=1 (got ${lj.data.total})`)

  // 2) Bob 也发请求（管理员通过 userId 下钻查看）
  console.log('[test] 第二用户请求')
  await chat(keyB.plain, [{ role: 'user', content: '介绍一下 SQL' }])
  await wait(400)
  const lr2 = await fetch(`${BASE}/api/usage/logs?days=30&page_size=10&userId=2`, { headers: ADMIN })
  const lj2 = await lr2.json()
  assert(lj2.data.total >= 1 && (lj2.data.items[0]?.prompt || '').includes('SQL'), `bob logs 含提示词 (total=${lj2.data.total})`)

  // 3) 管理台 /api/usage/by-user 按用户聚合
  console.log('[test] by-user 聚合')
  const bu = await fetch(`${BASE}/api/usage/by-user?days=30`, { headers: ADMIN })
  const buj = await bu.json()
  assert(bu.status === 200, `by-user status 200 (${bu.status})`)
  assert(buj.data.byUser.length === 2, `byUser 2 users (got ${buj.data.byUser.length})`)
  assert(buj.data.totals.request_count >= 2, `totals.request_count>=2 (got ${buj.data.totals.request_count})`)
  const alice = buj.data.byUser.find((u) => u.user_id === 1)
  const bob = buj.data.byUser.find((u) => u.user_id === 2)
  assert(alice && alice.requests === 1, `alice requests=1 (got ${alice?.requests})`)
  assert(bob && bob.requests === 1, `bob requests=1 (got ${bob?.requests})`)
  assert(alice.name === 'Alice', `alice name (got ${alice.name})`)

  // 4) by-user 下钻 detail
  console.log('[test] by-user detail 下钻')
  const du = await fetch(`${BASE}/api/usage/by-user?days=30&userId=1`, { headers: ADMIN })
  const duj = await du.json()
  assert(duj.data.detail.total === 1, `detail total=1 (got ${duj.data.detail.total})`)
  assert((duj.data.detail.items[0]?.prompt || '').includes('春天'), `detail item 含提示词`)

  // 5) 普通用户不可访问 by-user
  console.log('[test] 非管理员禁止 by-user')
  const nb = await fetch(`${BASE}/api/usage/by-user?days=30`, { headers: { authorization: `Bearer ${makeJwt(2)}` } })
  assert(nb.status === 403, `普通用户 by-user 403 (got ${nb.status})`)

  console.log(failed ? '\nUSAGE-PROMPT-USERS TESTS FAILED' : '\nUSAGE-PROMPT-USERS TESTS PASSED')
}
main().catch((e) => { failed = true; console.error('\nFAILED:', e.message) }).finally(() => {
  child.kill('SIGTERM'); mock.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
  setTimeout(() => process.exit(failed ? 1 : 0), 100)
})
