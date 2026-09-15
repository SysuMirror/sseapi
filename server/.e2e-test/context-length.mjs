// 端到端：验证「上下文长度」检测
// 场景：
//  1) 模型 context_length=100，输入较短 → 放行（转上游成功）
//  2) 模型 context_length=100，输入超长 → 400 context_length_exceeded，不转上游
//  3) 模型 context_length=0（不限制），超长输入 → 放行
//  4) 管理台保存 contextLength 后，mapModelAdmin 返回该值
// 运行：node .e2e-test/context-length.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'

const PORT = 8109
const BASE = `http://127.0.0.1:${PORT}`
const JWT_SECRET = 'e2e-secret'
const ADMIN_OAUTH = '327'
const serverDir = path.resolve(import.meta.dirname, '..')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const hashToken = (raw) => createHash('sha256').update(raw).digest('hex')
const b64url = (s) => Buffer.from(JSON.stringify(s)).toString('base64url')
function makeJwt(userId, secret) {
  const header = { alg: 'HS256', typ: 'JWT' }
  const now = Math.floor(Date.now() / 1000)
  const payload = { sub: userId, oauthId: ADMIN_OAUTH, isAdmin: 1, iat: now, exp: now + 3600 }
  const si = `${b64url(header)}.${b64url(payload)}`
  return `${si}.${createHmac('sha256', secret).update(si).digest('base64url')}`
}

let failed = false
function assert(cond, msg) {
  if (!cond) { failed = true; console.log('FAIL:', msg) } else { console.log('  ok -', msg) }
}

// mock 上游：记录是否收到请求、返回 ok
const received = []
const mock = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {}
    received.push(body)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: 'cmpl_c' + received.length, object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } },
    }))
  })
})

const modelRow = (slug, contextLength) => ({
  id: 1, slug, display_name: slug, badge: '', card_color: '#111',
  model_type: 'chat', upstream_api_format: 'openai', upstream_path_override: '',
  upstream_base_url: `http://127.0.0.1:${PORT + 1}/v1`, upstream_model: slug, upstream_api_key: '',
  allowed_origins: '', rpm_limit: 0, max_concurrent: 0,
  input_price_per_1m: 1, output_price_per_1m: 1, cache_price_per_1m: 0,
  multimodal_enabled: 0, image_billing_mode: 'token', image_price_per_1m: 0, image_price_per_image: 0,
  image_tokens_per_image: 512, thinking_enabled: 0, thinking_levels: '["off"]',
  default_thinking: 'off', claude_compat: 0, anthropic_base_url: '', anthropic_enabled: 0,
  responses_base_url: '', responses_enabled: 0,
  context_length: contextLength || 0,
  enabled: 1, sort_order: 1,
})

const keyPlain = 'sk-e2e-' + Math.random().toString(36).slice(2, 12)
const store = {
  seq: { users: 1, api_keys: 1, models: 2, usage_logs: 0, ledger: 0 },
  users: [{ id: 1, oauth_id: ADMIN_OAUTH, name: 'admin', email: '', avatar_url: '', is_admin: 1, balance_cents: 100000, admin_note: '', rpm_limit: 0, max_concurrent: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
  api_keys: [{ id: 1, user_id: 1, name: 't', key_prefix: keyPlain.slice(0, 8), key_hash: hashToken(keyPlain), allowed_origins: '', rpm_limit: 0, max_concurrent: 0, last_used_at: null, created_at: new Date().toISOString(), revoked_at: null }],
  models: [modelRow('ctx-100', 100), modelRow('ctx-0', 0)], usage_logs: [], ledger: [],
  docs: { id: 1, title: 'docs', external_url: '', content_md: '', updated_at: new Date().toISOString() },
  oauth_states: [],
  rate_limits: { enabled: 1, default_rpm: 999, default_max_concurrent: 999, updated_at: new Date().toISOString() },
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sseapi-ctx-'))
fs.writeFileSync(path.join(dataDir, 'sseapi-store.json'), JSON.stringify(store, null, 2))

const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: serverDir,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, JWT_SECRET, SSEAPI_API_PUBLIC_URL: BASE },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let outLog = ''
child.stdout.on('data', (d) => (outLog += d))
child.stderr.on('data', (d) => (outLog += d))

async function boot() {
  for (let i = 0; i < 40; i++) { try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return } catch {} await wait(200) }
  throw new Error('server 未启动: ' + outLog.slice(-400))
}
async function chat(model, text) {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${keyPlain}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: text }], stream: false }),
  })
  return r
}

async function main() {
  await new Promise((r) => mock.listen(PORT + 1, '127.0.0.1', r))
  await boot()
  console.log('[boot] ready\n')

  const shortText = 'hi'
  const longText = 'X'.repeat(4000) // JSON.stringify ~4000+ chars → tokens ~> 1600 > 100
  const ADMIN = { authorization: `Bearer ${makeJwt(1, JWT_SECRET)}` }

  // —— 管理台保存 contextLength ——
  console.log('[test] 管理台保存 contextLength')
  const create = await fetch(`${BASE}/api/admin/models`, {
    method: 'POST', headers: { ...ADMIN, 'content-type': 'application/json' },
    body: JSON.stringify({ slug: 'ctx-edit', displayName: 'CtxEdit', modelType: 'chat', upstreamBaseUrl: `http://127.0.0.1:${PORT + 1}/v1`, upstreamModel: 'ctx-edit', contextLength: 200 }),
  })
  assert(create.status === 200, `create ctx-edit 200 (${create.status})`)
  const created = await create.json()
  const id = created.data.id
  const read = await fetch(`${BASE}/api/admin/models`, { headers: ADMIN })
  const rj = await read.json()
  const saved = rj.data.find((m) => m.slug === 'ctx-edit')
  assert(saved && saved.contextLength === 200, `mapModelAdmin 返回 contextLength=200 (got ${saved?.contextLength})`)

  // ② ctx-100 短输入 → 放行
  console.log('[test] ctx-100 短输入放行')
  const short = await chat('ctx-100', shortText)
  const sj = await short.json()
  assert(short.status === 200, `短输入 200 (got ${short.status})`)
  assert(sj.choices?.[0]?.message?.content === 'ok', `短输入返回 ok`)

  // ③ ctx-100 超长 → 400 context_length_exceeded，上游未收到
  console.log('[test] ctx-100 超长拒绝')
  received.length = 0
  const over = await chat('ctx-100', longText)
  const oj = await over.json()
  assert(over.status === 400, `超长 400 (got ${over.status})`)
  assert(oj.error?.type === 'context_length_exceeded', `error.type=context_length_exceeded (got ${oj.error?.type})`)
  assert(received.length === 0, `超长未转发上游 (received=${received.length})`)

  // ④ ctx-0 超长输入 → 放行（不限制）
  console.log('[test] ctx-0 不限制')
  received.length = 0
  const un = await chat('ctx-0', longText)
  assert(un.status === 200, `ctx-0 超长 200 (got ${un.status})`)
  assert(received.length === 1, `ctx-0 转发上游 (received=${received.length})`)

  console.log(failed ? '\nCONTEXT-LENGTH TESTS FAILED' : '\nCONTEXT-LENGTH TESTS PASSED')
}
main().catch((e) => { failed = true; console.error('\nFAILED:', e.message) }).finally(() => {
  child.kill('SIGTERM'); mock.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
  setTimeout(() => process.exit(failed ? 1 : 0), 100)
})
