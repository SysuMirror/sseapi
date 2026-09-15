// 端点到端：验证 /v1/chat/completions 自动补挂 reasoning_content
// 场景：
//  1) 第一轮：客户端发 assistant 消息（content + tool_calls + reasoning_content，非流式）→ 平台转发，mock 缓存该轮 reasoning。
//     （实际这里客户端会带 reasoning，验证「已有则不覆盖」）
//  2) 第二轮：客户端只回传 assistant 消息（content + tool_calls，但剥离了 reasoning_content）→ 平台应在转发前补挂回缓存值。
// 同时验证非流式响应侧也会记忆 reasoning（为后续轮次补挂）。
// mock 记录每轮收到的请求体，并让「第二轮」返回带 reasoning+tool_calls 的响应以继续循环。
// 运行：node .e2e-test/chat-reasoning.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'

const PORT = 8101
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

// —— mock 上游：记录请求体；返回带 reasoning_content + tool_calls 的响应 ——
const received = []
const TOOL_REASONING = '用户询问目录内容，我需要先查看当前目录结构。'
const mock = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {}
    received.push(body)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'cmpl_r' + received.length,
        object: 'chat.completion',
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              reasoning_content: TOOL_REASONING,
              content: '我先查看目录。',
              tool_calls: [
                { id: 'call_x1', type: 'function', function: { name: 'Explore', arguments: '{"path":"D:\\\\work"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 6, completion_tokens: 12, total_tokens: 18, prompt_tokens_details: { cached_tokens: 0 } },
      }),
    )
  })
})

const modelRow = () => ({
  id: 1, slug: 'mock-reason', display_name: 'Mock Reason', badge: '', card_color: '#111',
  model_type: 'chat', upstream_api_format: 'openai', upstream_path_override: '',
  upstream_base_url: `http://127.0.0.1:${PORT + 1}/v1`, upstream_model: 'mock-reason', upstream_api_key: '',
  allowed_origins: '', rpm_limit: 0, max_concurrent: 0,
  input_price_per_1m: 1, output_price_per_1m: 1, cache_price_per_1m: 0,
  multimodal_enabled: 0, image_billing_mode: 'token', image_price_per_1m: 0, image_price_per_image: 0,
  image_tokens_per_image: 512, thinking_enabled: 1, thinking_levels: '["off","low","medium","high"]',
  default_thinking: 'off', claude_compat: 0, anthropic_base_url: '', anthropic_enabled: 0,
  responses_base_url: '', responses_enabled: 0, enabled: 1, sort_order: 1,
})

const keyPlain = 'sk-e2e-' + Math.random().toString(36).slice(2, 12)
const store = {
  seq: { users: 1, api_keys: 1, models: 1, usage_logs: 0, ledger: 0 },
  users: [{ id: 1, oauth_id: ADMIN_OAUTH, name: 'admin', email: '', avatar_url: '', is_admin: 1, balance_cents: 100000, admin_note: '', rpm_limit: 0, max_concurrent: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
  api_keys: [{ id: 1, user_id: 1, name: 't', key_prefix: keyPlain.slice(0, 8), key_hash: hashToken(keyPlain), allowed_origins: '', rpm_limit: 0, max_concurrent: 0, last_used_at: null, created_at: new Date().toISOString(), revoked_at: null }],
  models: [modelRow()], usage_logs: [], ledger: [],
  docs: { id: 1, title: 'docs', external_url: '', content_md: '', updated_at: new Date().toISOString() },
  oauth_states: [],
  rate_limits: { enabled: 1, default_rpm: 999, default_max_concurrent: 999, updated_at: new Date().toISOString() },
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sseapi-reason-'))
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

const H = { authorization: `Bearer ${keyPlain}` }

async function main() {
  await new Promise((r) => mock.listen(PORT + 1, r))
  await boot()
  console.log('[boot] ready\n')

  // 第一轮：客户端已带 reasoning_content（content + tool_calls + reasoning）。平台应保留原值，不覆盖。
  console.log('[test] turn1: 客户端自带 reasoning_content → 不覆盖')
  const r1 = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'mock-reason',
      messages: [
        { role: 'user', content: '查看目录' },
        { role: 'assistant', content: '我先查看目录。', tool_calls: [{ id: 'call_x1', type: 'function', function: { name: 'Explore', arguments: '{"path":"D:\\\\work"}' } }], reasoning_content: TOOL_REASONING },
      ],
      stream: false,
    }),
  })
  const j1 = await r1.json()
  assert(r1.status === 200, `turn1 status 200 (${r1.status})`)
  const sent1 = received[0]
  const asst1 = sent1.messages.find((m) => m.role === 'assistant')
  assert(asst1.reasoning_content === TOOL_REASONING, `turn1 已带 reasoning_content 不覆盖 (${JSON.stringify(asst1.reasoning_content)})`)
  assert(j1.choices?.[0]?.message?.reasoning_content === TOOL_REASONING, `turn1 响应含 reasoning_content`)

  // 第二轮：客户端剥离 reasoning_content（assistant 消息仅 content + tool_calls）。平台应补挂回缓存值。
  console.log('[test] turn2: 客户端剥离 reasoning_content → 自动补挂')
  const r2 = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'mock-reason',
      messages: [
        { role: 'user', content: '查看目录' },
        { role: 'assistant', content: '我先查看目录。', tool_calls: [{ id: 'call_x1', type: 'function', function: { name: 'Explore', arguments: '{"path":"D:\\\\work"}' } }] },
        { role: 'tool', tool_call_id: 'call_x1', content: '["src","README.md"]' },
      ],
      stream: false,
    }),
  })
  const j2 = await r2.json()
  assert(r2.status === 200, `turn2 status 200 (${r2.status})`)
  const sent2 = received[received.length - 1]
  const asst2 = sent2.messages.find((m) => m.role === 'assistant')
  assert(asst2.reasoning_content === TOOL_REASONING, `turn2 补挂 reasoning_content（应等于缓存值）(got ${JSON.stringify(asst2.reasoning_content)})`)

  // 第三轮：非带 tool_calls 的 assistant 文本消息（无 tool_calls）→ 不补挂（避免污染）
  console.log('[test] turn3: 无 tool_calls 的 assistant → 不补挂')
  const r3 = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'mock-reason',
      messages: [
        { role: 'user', content: '继续' },
        { role: 'assistant', content: '好的，继续。' },
      ],
      stream: false,
    }),
  })
  await r3.json()
  const sent3 = received[received.length - 1]
  const asst3 = sent3.messages.find((m) => m.role === 'assistant')
  assert(asst3.reasoning_content == null, `turn3 无 tool_calls 不补挂 (got ${JSON.stringify(asst3.reasoning_content)})`)

  console.log(failed ? '\nCHAT-REASONING TESTS FAILED' : '\nCHAT-REASONING TESTS PASSED')
}
main().catch((e) => { failed = true; console.error('\nFAILED:', e.message) }).finally(() => {
  child.kill('SIGTERM'); mock.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
  setTimeout(() => process.exit(failed ? 1 : 0), 100)
})
