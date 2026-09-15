// 端到端：验证管理员「连通性/协议测试」探测对 DeepSeek 风格上游的 token 检测 & 完整响应透出。
// 启动一个 mock 上游（返回 usage + reasoning_content），再启动后端，
// 用 JWT 调 /api/admin/models/test（json 与 stream 两档）断言：
//   - usageParsed.found=true 且 prompt/completion/total 来自上游 usage
//   - reasoningContent 被透出
//   - rawTail / usageRaw 能定位到末尾 usage chunk
// 运行：node .e2e-test/probe-usage.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'

const UP_PORT = 8096
const PORT = 8099
const BASE = `http://127.0.0.1:${PORT}`
const UPSTREAM = `http://127.0.0.1:${UP_PORT}/v1`
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
function assert(cond, msg) { if (!cond) { failed = true; console.log('FAIL:', msg) } else { console.log('  ok -', msg) } }

const USAGE = { prompt_tokens: 12, completion_tokens: 145, total_tokens: 157, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 96 } }
const REASON = '用户让我用一句话介绍自己。这个要求很直接，需要简洁、全面且友好。'
const CONTENT = '你好！我是DeepSeek，由深度求索公司创造的AI助手，擅长通过文字与你交流。'

function serveStream(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = (obj) => { res.write(`data: ${JSON.stringify(obj)}\n\n`) }
  send({ id: 'x1', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-flash', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: REASON.slice(0, 10) } }] })
  send({ id: 'x1', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-flash', choices: [{ index: 0, delta: { reasoning_content: REASON.slice(10) } }] })
  send({ id: 'x1', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-flash', choices: [{ index: 0, delta: { content: CONTENT.slice(0, 12) } }] })
  send({ id: 'x1', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-flash', choices: [{ index: 0, delta: { content: CONTENT.slice(12) } }] })
  send({ id: 'x1', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-flash', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: USAGE })
  send({ id: 'x1', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-flash', choices: [] })
  res.write('data: [DONE]\n\n')
  res.end()
}
function serveJson(req, res) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ id: 'x1', object: 'chat.completion', created: 1, model: 'deepseek-v4-flash', choices: [{ index: 0, message: { role: 'assistant', reasoning_content: REASON, content: CONTENT }, finish_reason: 'stop' }], usage: USAGE, service_tier: 'default' }))
}

const upstream = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    const stream = (() => { try { return JSON.parse(body).stream } catch { return false } })()
    if (stream) serveStream(req, res)
    else serveJson(req, res)
  })
})

const modelRow = { id: 1, slug: 'deepseek-v4-flash', display_name: 'DeepSeek', badge: '', card_color: '#111', model_type: 'chat', upstream_api_format: 'openai', upstream_path_override: '', upstream_base_url: UPSTREAM, upstream_model: 'deepseek-v4-flash', upstream_api_key: '', allowed_origins: '', rpm_limit: 0, max_concurrent: 0, input_price_per_1m: 1, output_price_per_1m: 1, cache_price_per_1m: 0, multimodal_enabled: 0, image_billing_mode: 'token', image_price_per_1m: 0, image_price_per_image: 0, image_tokens_per_image: 512, thinking_enabled: 1, thinking_levels: '["off","low","high"]', default_thinking: 'off', claude_compat: 0, anthropic_base_url: '', anthropic_enabled: 0, responses_base_url: '', responses_enabled: 0, enabled: 1, sort_order: 1 }
const key = { plain: 'sk-e2e-' + Math.random().toString(36).slice(2, 12) }
const store = {
  seq: { users: 1, api_keys: 1, models: 1, usage_logs: 0, ledger: 0 },
  users: [{ id: 1, oauth_id: ADMIN_OAUTH, name: 'admin', email: '', avatar_url: '', is_admin: 1, balance_cents: 100000, admin_note: '', rpm_limit: 0, max_concurrent: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
  api_keys: [{ id: 1, user_id: 1, name: 't', key_prefix: key.plain.slice(0, 8), key_hash: hashToken(key.plain), allowed_origins: '', rpm_limit: 0, max_concurrent: 0, last_used_at: null, created_at: new Date().toISOString(), revoked_at: null }],
  models: [modelRow], usage_logs: [], ledger: [],
  docs: { id: 1, title: 'API 文档', external_url: '', content_md: '', updated_at: new Date().toISOString() },
  oauth_states: [],
  rate_limits: { enabled: 1, default_rpm: 999, default_max_concurrent: 999, updated_at: new Date().toISOString() },
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sseapi-probe-'))
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
  throw new Error('server 未启动: ' + outLog.slice(-400))
}
async function probe(body) {
  const r = await fetch(`${BASE}/api/admin/models/1/test`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${makeJwt(1, JWT_SECRET)}` }, body: JSON.stringify(body) })
  const j = await r.json()
  return j.data || j
}

async function main() {
  await new Promise((r) => upstream.listen(UP_PORT, r))
  await boot()
  console.log('[boot] ready\n')

  console.log('[test] json (non-stream) probe')
  const j = await probe({ stream: false, prompt: '你好' })
  assert(j.ok === true, `json ok=true (${j.ok})`)
  assert(j.usageParsed?.found === true, `usageParsed.found (${j.usageParsed?.found})`)
  assert(j.usageParsed?.prompt === 12, `prompt=12 (${j.usageParsed?.prompt})`)
  assert(j.usageParsed?.completion === 145, `completion=145 (${j.usageParsed?.completion})`)
  assert(j.usageParsed?.total === 157, `total=157 (${j.usageParsed?.total})`)
  assert(j.usageParsed?.reasoning === 96, `reasoning=96 (${j.usageParsed?.reasoning})`)
  assert(j.reasoningContent && j.reasoningContent.includes('一句话'), `reasoningContent 透出`)
  assert(j.content && j.content.includes('DeepSeek'), `content 透出`)
  assert(j.rawTail && j.rawTail.includes('total_tokens'), `rawTail 含 usage`)

  console.log('[test] stream probe')
  const s = await probe({ stream: true, prompt: '你好' })
  assert(s.ok === true, `stream ok=true (${s.ok})`)
  assert(s.mode === 'stream', `mode=stream (${s.mode})`)
  assert(s.usageParsed?.found === true, `usageParsed.found (${s.usageParsed?.found})`)
  assert(s.usageParsed?.completion === 145, `stream completion=145 (${s.usageParsed?.completion})`)
  assert(s.usageParsed?.reasoning === 96, `stream reasoning=96 (${s.usageParsed?.reasoning})`)
  assert(s.chunkCount >= 6, `chunkCount>=6 (${s.chunkCount})`)
  assert(s.reasoningContent && s.reasoningContent.length > 0, `stream reasoningContent 透出`)
  assert(s.usageRaw && s.usageRaw.includes('"usage"'), `usageRaw 定位 usage chunk`)
  assert(s.rawTail && s.rawTail.includes('[DONE]'), `rawTail 含 [DONE]`)

  console.log(failed ? '\nPROBE-USAGE TESTS FAILED' : '\nPROBE-USAGE TESTS PASSED')
}
main().catch((e) => { failed = true; console.error('\nFAILED:', e.message) }).finally(() => {
  child.kill('SIGTERM'); upstream.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
  setTimeout(() => process.exit(failed ? 1 : 0), 100)
})
