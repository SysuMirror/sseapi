// e2e 冒烟：验证 /v1/messages (anthropic独立上游透传) / /v1/responses (responses独立上游透传) / /v1/chat/completions (openai)
// 以及 anthropic/responses 的「转换兜底」路径（未配置独立上游时）。
import { spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(__dirname, '..')
const PORT = 8099
const BASE = `http://127.0.0.1:${PORT}`
const JWT_SECRET = 'e2e-secret'
const ADMIN_OAUTH = '327'

function hashToken(raw) {
  return createHash('sha256').update(raw).digest('hex')
}
function b64url(s) {
  return Buffer.from(s).toString('base64url')
}
// 构造 HMAC-SHA256 JWT（与平台 jwt.verify 一致）
function makeJwt(userId, secret) {
  const header = { alg: 'HS256', typ: 'JWT' }
  const now = Math.floor(Date.now() / 1000)
  const payload = { sub: userId, oauthId: ADMIN_OAUTH, isAdmin: 1, iat: now, exp: now + 3600 }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const sig = createHmac('sha256', secret).update(signingInput).digest('base64url')
  return `${signingInput}.${sig}`
}
function makeApiKey() {
  const plain = 'sk-e2e-' + Math.random().toString(36).slice(2, 12)
  return { plain, prefix: plain.slice(0, 8), hash: hashToken(plain) }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 上游 mock：记录收到的请求体，返回固定形状 ----
const received = { messages: [], responses: [], chat: [] }
const mock = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {}
    if (req.url === '/v1/messages') {
      received.messages.push(body)
      let buf = ''
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const artText = '<antArtifact identifier="demo" type="application/vnd.ant.code" title="Demo">\nconsole.log(1)\n</antArtifact>'
        const dsmlText = '<|DSML|tool_calls>\n<|DSML|invoke name="Bash">\n<|DSML|parameter name="command" string="true">ls</|DSML|parameter>\n</|DSML|invoke>\n</|DSML|tool_calls>'
        let deltaText = 'hi from anthropic mock'
        if (body.model === 'mock-art-anthropic') deltaText = '代码如下: ' + artText
        else if (body.model === 'mock-dsml-anthropic') deltaText = '执行: ' + dsmlText
        for (const ev of [
          { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 3, output_tokens: 0 } } } },
          { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
          { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: deltaText } } },
          { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]) res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`)
        res.end()
        return
      }
      const json = { id: 'msg_m1', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'hi from anthropic mock' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 5 } }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(json))
      return
    }
    if (req.url === '/v1/responses') {
      received.responses.push(body)
      const json = { id: 'resp_m1', object: 'response', status: 'completed', model: body.model, output: [{ type: 'message', id: 'msg_r1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hi from responses mock' }] }], usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 } }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(json))
      return
    }
    if (req.url === '/v1/chat/completions') {
      received.chat.push(body)
      // chat-slow：延迟响应，用于验证「实时并发」统计在请求进行中 >0
      const delay = body.model === 'chat-slow' ? 900 : 0
      const dsmlContent = '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="Bash">\n<｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>'
      const artContent = '<antArtifact identifier="demo" type="application/vnd.ant.code" title="Demo">\nconsole.log(1)\n</antArtifact>'
      let streamParts = ['hi from', ' chat mock']
      if (body.model === 'mock-dsml') streamParts = ['我会先查目录: ', dsmlContent]
      else if (body.model === 'mock-art') streamParts = ['代码如下: ', artContent]
      // mock-tools：返回标准 OpenAI tool_calls（流式分片 / 非流式），用于验证协议双向转换
      const isToolsModel = body.model === 'mock-tools'
      // mock-err：模拟上游拒绝（400），验证平台错误收敛（不把 SSE 包在非 200 里）
      if (body.model === 'mock-err') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: '上游额度不足', type: 'invalid_request_error' } }))
        return
      }
      const respond = () => {
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          if (isToolsModel) {
            // 流式工具调用：role 首块 + 文本 + 分片 tool_calls（id/name -> arguments 增量）+ finish
            const chunks = [
              { id: 'cmpl_2', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '我来查看目录。' }, finish_reason: null }] },
              { id: 'cmpl_2', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_e2e1', type: 'function', function: { name: 'Explore', arguments: '{"pa' } }] }, finish_reason: null }] },
              { id: 'cmpl_2', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"D:\\\\work"}' } }] }, finish_reason: null }] },
              { id: 'cmpl_2', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 } },
            ]
            for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
            res.write('data: [DONE]\n\n')
            res.end()
            return
          }
          // OpenAI 流式：role 首块 + 若干 content delta + finish + usage + [DONE]
          res.write(`data: ${JSON.stringify({ id: 'cmpl_1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`)
          for (const part of streamParts) {
            res.write(`data: ${JSON.stringify({ id: 'cmpl_1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })}\n\n`)
          }
          res.write(`data: ${JSON.stringify({ id: 'cmpl_1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        let json
        if (isToolsModel) {
          json = { id: 'cmpl_2', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: '我来查看目录。', tool_calls: [{ id: 'call_e2e2', type: 'function', function: { name: 'Explore', arguments: '{"path":"D:\\\\work"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 } }
        } else {
          json = { id: 'cmpl_1', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: body.model === 'mock-dsml' ? dsmlContent : body.model === 'mock-art' ? artContent : 'hi from chat mock' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(json))
      }
      if (delay) setTimeout(respond, delay)
      else respond()
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'not found' } }))
  })
})

// ---- 准备临时数据目录 ----
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sseapi-e2e-'))
const key = makeApiKey()
const UPSTREAM_BASE = `http://127.0.0.1:${PORT + 1}/v1`
const modelOpenAi = { id: 1, slug: 'chat-mock', display_name: 'Chat Mock', badge: '', card_color: '#111', model_type: 'chat', upstream_api_format: 'openai', upstream_path_override: '', upstream_base_url: UPSTREAM_BASE, upstream_model: 'chat-mock', upstream_api_key: '', allowed_origins: '', rpm_limit: 0, max_concurrent: 0, input_price_per_1m: 1, output_price_per_1m: 1, cache_price_per_1m: 0, multimodal_enabled: 0, image_billing_mode: 'token', image_price_per_1m: 0, image_price_per_image: 0, image_tokens_per_image: 512, thinking_enabled: 0, thinking_levels: '["off"]', default_thinking: 'off', claude_compat: 0, anthropic_base_url: '', anthropic_enabled: 0, responses_base_url: '', responses_enabled: 0, enabled: 1, sort_order: 1 }
const modelAnthropicOwn = { ...modelOpenAi, id: 2, slug: 'anthropic-own', display_name: 'Anthropic Own', upstream_base_url: UPSTREAM_BASE, anthropic_base_url: UPSTREAM_BASE, anthropic_enabled: 1, responses_base_url: UPSTREAM_BASE, responses_enabled: 0, claude_compat: 0 }
const modelResponsesOwn = { ...modelOpenAi, id: 3, slug: 'responses-own', display_name: 'Responses Own', upstream_base_url: UPSTREAM_BASE, anthropic_base_url: '', anthropic_enabled: 0, responses_base_url: UPSTREAM_BASE, responses_enabled: 1, claude_compat: 1 }
const modelAnthropicRelay = { ...modelOpenAi, id: 4, slug: 'anthropic-relay', display_name: 'Anthropic Relay', upstream_base_url: UPSTREAM_BASE, anthropic_base_url: '', anthropic_enabled: 1, responses_base_url: '', responses_enabled: 0, claude_compat: 1 }
const modelResponsesRelay = { ...modelOpenAi, id: 5, slug: 'responses-relay', display_name: 'Responses Relay', upstream_base_url: UPSTREAM_BASE, anthropic_base_url: '', anthropic_enabled: 0, responses_base_url: '', responses_enabled: 1, claude_compat: 1 }
const modelChatSlow = { ...modelOpenAi, id: 6, slug: 'chat-slow', display_name: 'Chat Slow', upstream_base_url: UPSTREAM_BASE, upstream_model: 'chat-slow', claude_compat: 0 }
const modelDsmlRelay = { ...modelOpenAi, id: 7, slug: 'dsml-relay', display_name: 'DSML Relay', upstream_base_url: UPSTREAM_BASE, upstream_model: 'mock-dsml', anthropic_enabled: 1, responses_enabled: 0, claude_compat: 1 }
const modelArtRelay = { ...modelOpenAi, id: 8, slug: 'art-relay', display_name: 'Art Relay', upstream_base_url: UPSTREAM_BASE, upstream_model: 'mock-art', anthropic_enabled: 1, responses_enabled: 0, claude_compat: 1 }
const modelArtOwnAnthropic = { ...modelOpenAi, id: 9, slug: 'art-own-anthropic', display_name: 'Art Own Anthropic', upstream_base_url: UPSTREAM_BASE, upstream_model: 'mock-art-anthropic', anthropic_base_url: UPSTREAM_BASE, anthropic_enabled: 1, responses_enabled: 0, claude_compat: 1 }
const modelDsmlOwnAnthropic = { ...modelOpenAi, id: 10, slug: 'dsml-own-anthropic', display_name: 'DSML Own Anthropic', upstream_base_url: UPSTREAM_BASE, upstream_model: 'mock-dsml-anthropic', anthropic_base_url: UPSTREAM_BASE, anthropic_enabled: 1, responses_enabled: 0, claude_compat: 1 }
const modelToolsRelay = { ...modelOpenAi, id: 11, slug: 'tools-relay', display_name: 'Tools Relay', upstream_base_url: UPSTREAM_BASE, upstream_model: 'mock-tools', anthropic_enabled: 1, responses_enabled: 0, claude_compat: 1 }
const modelErrRelay = { ...modelOpenAi, id: 12, slug: 'err-relay', display_name: 'Err Relay', upstream_base_url: UPSTREAM_BASE, upstream_model: 'mock-err', anthropic_enabled: 1, responses_enabled: 0, claude_compat: 1 }
const store = {
  seq: { users: 1, api_keys: 1, models: 6, usage_logs: 0, ledger: 0 },
  users: [{ id: 1, oauth_id: ADMIN_OAUTH, name: 'e2e', email: '', avatar_url: '', is_admin: 1, balance_cents: 100000, admin_note: '', rpm_limit: 0, max_concurrent: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
  api_keys: [{ id: 1, user_id: 1, name: 'e2e', key_prefix: key.prefix, key_hash: key.hash, allowed_origins: '', rpm_limit: 0, max_concurrent: 0, last_used_at: null, created_at: new Date().toISOString(), revoked_at: null }],
  models: [modelOpenAi, modelAnthropicOwn, modelResponsesOwn, modelAnthropicRelay, modelResponsesRelay, modelChatSlow, modelDsmlRelay, modelArtRelay, modelArtOwnAnthropic, modelDsmlOwnAnthropic, modelToolsRelay, modelErrRelay],
  usage_logs: [], ledger: [],
  docs: { id: 1, title: 'API 文档', external_url: '', content_md: '', updated_at: new Date().toISOString() },
  oauth_states: [],
  rate_limits: { enabled: 1, default_rpm: 999, default_max_concurrent: 999, updated_at: new Date().toISOString() },
}
fs.writeFileSync(path.join(dataDir, 'sseapi-store.json'), JSON.stringify(store, null, 2))

// ---- 启动 mock 上游 ----
const UPSTREAM_PORT = PORT + 1
await new Promise((r) => mock.listen(UPSTREAM_PORT, '127.0.0.1', r))

// ---- 启动目标 server（独立进程，使用本脚本所在进程是无法改内存的）----
const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: serverDir,
  env: {
    ...process.env,
    PORT: String(PORT),
    DATA_DIR: dataDir,
    JWT_SECRET,
    SSEAPI_API_PUBLIC_URL: BASE,
    PLATFORM_ADMIN_OAUTH_IDS: ADMIN_OAUTH,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let outLog = ''
child.stdout.on('data', (d) => (outLog += d))
child.stderr.on('data', (d) => (outLog += d))

async function boot() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${key.plain}` } })
      if (r.ok) return
    } catch {}
    await wait(200)
  }
  throw new Error('server 未启动: ' + outLog.slice(-500))
}

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAIL: ' + msg)
  console.log('  ok -', msg)
}

let failed = false
try {
  await boot()
  console.log('[boot] server up\n')

  const H = { authorization: `Bearer ${key.plain}` }
  const XK = { 'x-api-key': key.plain } // Anthropic 风格认证头
  const ADMIN_H = { authorization: `Bearer ${makeJwt(1, JWT_SECRET)}` }

  // 0) Anthropic 风格认证：x-api-key 头鉴权通过
  console.log('[test] anthropic auth via x-api-key')
  {
    const r = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: { ...XK, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'anthropic-own', max_tokens: 10, messages: [{ role: 'user', content: 'hello' }] }) })
    const j = await r.json()
    assert(r.ok && j.type === 'message', `x-api-key auth ok (status=${r.status})`)
  }

  // 1) anthropic 独立上游透传
  console.log('[test] anthropic own upstream passthrough')
  {
    const r = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'anthropic-own', max_tokens: 10, messages: [{ role: 'user', content: 'hello' }] }) })
    const j = await r.json()
    assert(r.ok && j.type === 'message', `messages passthrough ok (status=${r.status})`)
    const last = received.messages[received.messages.length - 1]
    assert(last.model === 'chat-mock', 'anthropic upstream 收到透传 body 且 model 被替换为 upstream_model')
  }

  // 2) anthropic 未配置独立上游 + claude_compat=0 => 应报错（不 serve）
  console.log('[test] anthropic not enabled -> 400')
  {
    const r = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'chat-mock', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }) })
    assert(r.status === 400, `messages rejection ok (status=${r.status})`)
  }

  // 3) responses 独立上游透传
  console.log('[test] responses own upstream passthrough')
  {
    const r = await fetch(`${BASE}/v1/responses`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'responses-own', input: 'hello', stream: false }) })
    const j = await r.json()
    assert(r.ok && j.object === 'response', `responses passthrough ok (status=${r.status})`)
    assert(received.responses.length === 1 && received.responses[0].model === 'chat-mock', 'responses 上游收到透传 body')
  }

  // 4) chat completions (openai 上游) 正常
  console.log('[test] chat completions openai upstream')
  {
    const r = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'chat-mock', messages: [{ role: 'user', content: 'hi' }], stream: false }) })
    const j = await r.json()
    assert(r.ok && j.object === 'chat.completion', `chat ok (status=${r.status})`)
    assert(received.chat.length === 1 && received.chat[0].model === 'chat-mock', 'chat 上游收到 body')
  }

  // 5) anthropic 反代（开开关、无独立 base、claude_compat=1）→ 转 chat 打到 openai 上游
  console.log('[test] anthropic relay -> chat conversion')
  {
    const r = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'anthropic-relay', max_tokens: 10, messages: [{ role: 'user', content: 'hello relay' }] }) })
    const j = await r.json()
    assert(r.ok && j.type === 'message', `anthropic relay ok (status=${r.status})`)
    assert(received.chat.length === 2 && received.chat[1].model === 'chat-mock', 'anthropic relay 转 chat 打到 openai 上游（model 替换）')
  }

  // 6) responses 反代（开开关、无独立 base、claude_compat=1）→ 转 chat 打到 openai 上游
  console.log('[test] responses relay -> chat conversion')
  {
    const r = await fetch(`${BASE}/v1/responses`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'responses-relay', input: 'hello relay', stream: false }) })
    const j = await r.json()
    assert(r.ok && j.object === 'response', `responses relay ok (status=${r.status})`)
    assert(received.chat.length === 3 && received.chat[2].model === 'chat-mock', 'responses relay 转 chat 打到 openai 上游')
  }

  // 7) test-protocol 路由：探测 anthropic 独立上游（mock 返回 message 形状）→ supported
  console.log('[test] test-protocol anthropic supported')
  {
    const r = await fetch(`${BASE}/api/admin/models/2/test-protocol`, { method: 'POST', headers: { ...ADMIN_H, 'content-type': 'application/json' }, body: JSON.stringify({ protocol: 'anthropic' }) })
    const j = await r.json()
    const d = j.data || j
    assert(d.supported === true && d.mode === 'passthrough', `test-protocol anthropic supported (status=${r.status}, supported=${d.supported})`)
  }

  // 8) test-protocol 路由：探测 responses 独立上游 → supported
  console.log('[test] test-protocol responses supported')
  {
    const r = await fetch(`${BASE}/api/admin/models/3/test-protocol`, { method: 'POST', headers: { ...ADMIN_H, 'content-type': 'application/json' }, body: JSON.stringify({ protocol: 'responses' }) })
    const j = await r.json()
    const d = j.data || j
    assert(d.supported === true && d.mode === 'passthrough', `test-protocol responses supported (status=${r.status}, supported=${d.supported})`)
  }

  // 9) test-protocol 路由：探测未配置 base 的 relay 模型 → 反代链路可用（viaRelay=true, supported=true）
  console.log('[test] test-protocol relay (no base) -> relay link reachable')
  {
    const r = await fetch(`${BASE}/api/admin/models/4/test-protocol`, { method: 'POST', headers: { ...ADMIN_H, 'content-type': 'application/json' }, body: JSON.stringify({ protocol: 'anthropic' }) })
    const j = await r.json()
    const d = j.data || j
    assert(d.mode === 'relay' && d.viaRelay === true && d.supported === true, `test-protocol relay reachable (status=${r.status}, supported=${d.supported}, viaRelay=${d.viaRelay})`)
  }

  // 9b) test-protocol 路由：responses 反代链路（model 5）
  console.log('[test] test-protocol responses relay reachable')
  {
    const r = await fetch(`${BASE}/api/admin/models/5/test-protocol`, { method: 'POST', headers: { ...ADMIN_H, 'content-type': 'application/json' }, body: JSON.stringify({ protocol: 'responses' }) })
    const j = await r.json()
    const d = j.data || j
    assert(d.mode === 'relay' && d.viaRelay === true && d.supported === true, `responses relay reachable (status=${r.status}, supported=${d.supported}, viaRelay=${d.viaRelay})`)
  }

  // 10) 实时并发统计：进行中的请求应计入 global/endpoints，结束应释放
  console.log('[test] runtime concurrency status')
  {
    const slow = fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'chat-slow', messages: [{ role: 'user', content: 'hi' }], stream: false }) })
    await wait(150)
    const r1 = await fetch(`${BASE}/api/admin/rate-limits/status`, { headers: ADMIN_H })
    const s1 = await r1.json()
    const d1 = s1.data || s1
    const top = d1.endpoints.find((e) => e.name === 'chat/completions') || { current: 0 }
    assert(d1.global.current >= 1, `status global.current >=1 (got ${d1.global.current})`)
    assert(top.current >= 1, `status chat/completions current >=1 (got ${top.current})`)
    const slowRes = await slow
    await slowRes.text()
    await wait(50)
    const r2 = await fetch(`${BASE}/api/admin/rate-limits/status`, { headers: ADMIN_H })
    const s2 = await r2.json()
    const d2 = s2.data || s2
    const top2 = d2.endpoints.find((e) => e.name === 'chat/completions') || { current: 0 }
    assert(d2.global.current === 0 || d2.global.current <= d1.global.current, `status global released (got ${d2.global.current})`)
    assert(top2.current === 0, `status chat/completions released (got ${top2.current})`)
  }

  // 11) 流式 anthropic 反代：SSE 序列应含 content_block_stop（在 message_delta 前）
  console.log('[test] streaming anthropic relay SSE sequence')
  {
    const r = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'anthropic-relay', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hi stream' }] }) })
    const text = await r.text()
    const evs = [...text.matchAll(/^event:\s*(\S+)/gm)].map((m) => m[1])
    assert(evs.includes('content_block_start'), `stream has content_block_start`)
    assert(evs.includes('content_block_stop'), `stream has content_block_stop (got ${evs.join(',')})`)
    assert(evs.includes('message_delta'), `stream has message_delta`)
    assert(evs.includes('message_stop'), `stream has message_stop`)
    // content_block_stop 必须在 message_delta 之前
    const stopIdx = evs.indexOf('content_block_stop')
    const deltaIdx = evs.indexOf('message_delta')
    assert(stopIdx > -1 && deltaIdx > -1 && stopIdx < deltaIdx, `content_block_stop before message_delta (stop=${stopIdx}, delta=${deltaIdx})`)
    // message_delta 应带真实/估算的 output_tokens（>0）
    const deltaBlock = text.split('\n').find((l) => l.startsWith('data:') && l.includes('"type":"message_delta"'))
    const deltaData = deltaBlock ? JSON.parse(deltaBlock.slice(5).trim()) : null
    const outTokens = deltaData?.usage?.output_tokens ?? 0
    assert(outTokens > 0, `message_delta output_tokens >0 (got ${outTokens})`)
  }

  // 11b) 流式结算落库：usage_logs 里 completion_tokens 应 >0（修复前恒为 0）
  console.log('[test] streaming settleBilling writes completion_tokens >0')
  {
    // case 11 的 anthropic-relay 流式请求已结算；等 store 落盘后再读
    await wait(200)
    const storeOnDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'sseapi-store.json'), 'utf8'))
    const lastLog = (storeOnDisk.usage_logs || []).slice(-1)[0]
    assert(!!lastLog, `a usage_log entry exists for streaming request`)
    if (lastLog) {
      assert(lastLog.completion_tokens > 0, `completion_tokens >0 (got ${lastLog.completion_tokens})`)
      assert(lastLog.total_tokens === lastLog.prompt_tokens + lastLog.completion_tokens, `total = prompt + completion`)
    }
  }

  // 12) 流式 DSML 反代：应转换成 tool_use 结构化块，DSML 标签不泄漏为文本
  console.log('[test] streaming DSML -> tool_use conversion')
  {
    const r = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'dsml-relay', max_tokens: 64, stream: true, messages: [{ role: 'user', content: '列出目录' }] }) })
    const text = await r.text()
    const evs = [...text.matchAll(/^event:\s*(\S+)/gm)].map((m) => m[1])
    assert(evs.includes('content_block_start'), `stream has content_block_start (got ${evs.join(',')})`)
    const datas = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean).map((s) => JSON.parse(s))
    const toolStart = datas.find((d) => d.type === 'content_block_start' && d.content_block?.type === 'tool_use')
    assert(!!toolStart, `content_block_start type=tool_use present`)
    if (toolStart) {
      assert(toolStart.content_block.name === 'Bash', `tool name Bash (got ${toolStart.content_block.name})`)
      assert(toolStart.content_block.input?.command === 'ls', `input.command ls (got ${JSON.stringify(toolStart.content_block.input)})`)
    }
    const inputDelta = datas.filter((d) => d.type === 'content_block_delta' && d.delta?.type === 'input_json_delta')
    assert(inputDelta.length >= 1, `input_json_delta present (count ${inputDelta.length})`)
    const textLeak = datas.some((d) => d.type === 'content_block_delta' && d.delta?.type === 'text_delta' && String(d.delta?.text ?? '').includes('DSML'))
    assert(!textLeak, `no DSML tag leaked as text_delta`)
    const deltaData = datas.find((d) => d.type === 'message_delta')
    assert(deltaData?.delta?.stop_reason === 'tool_use', `stop_reason tool_use (got ${deltaData?.delta?.stop_reason})`)
  }

  // 13) 流式 antArtifact 反代：应转换成 artifact 结构化块
  console.log('[test] streaming antArtifact -> artifact conversion')
  {
    const r = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'art-relay', max_tokens: 64, stream: true, messages: [{ role: 'user', content: '生成代码片段' }] }) })
    const text = await r.text()
    const evs = [...text.matchAll(/^event:\s*(\S+)/gm)].map((m) => m[1])
    assert(evs.includes('content_block_start'), `stream has content_block_start`)
    const datas = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean).map((s) => JSON.parse(s))
    const artStart = datas.find((d) => d.type === 'content_block_start' && d.content_block?.type === 'artifact')
    assert(!!artStart, `content_block_start type=artifact present`)
    if (artStart) {
      assert(artStart.content_block.identifier === 'demo', `identifier demo (got ${artStart.content_block.identifier})`)
      assert(artStart.content_block.content_type === 'application/vnd.ant.code', `content_type (got ${artStart.content_block.content_type})`)
    }
    const textLeak = datas.some((d) => d.type === 'content_block_delta' && d.delta?.type === 'text_delta' && String(d.delta?.text ?? '').includes('antArtifact'))
    assert(!textLeak, `no antArtifact tag leaked as text_delta`)
  }

  // 14) 透传路径（有 anthropic_base_url）：上游返回 <antArtifact> 文本，也应重建为 artifact 块
  console.log('[test] anthropic 透传 antArtifact -> artifact')
  {
    const r = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'art-own-anthropic', max_tokens: 64, stream: true, messages: [{ role: 'user', content: '生成代码' }] }) })
    const text = await r.text()
    const evs = [...text.matchAll(/^event:\s*(\S+)/gm)].map((m) => m[1])
    assert(evs.includes('content_block_start'), `passthrough stream has content_block_start (got ${evs.join(',')})`)
    const datas = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean).map((s) => JSON.parse(s))
    const artStart = datas.find((d) => d.type === 'content_block_start' && d.content_block?.type === 'artifact')
    assert(!!artStart, `passthrough content_block_start type=artifact present`)
    if (artStart) {
      assert(artStart.content_block.identifier === 'demo', `passthrough identifier demo (got ${artStart.content_block.identifier})`)
      assert(artStart.content_block.content_type === 'application/vnd.ant.code', `passthrough content_type (got ${artStart.content_block.content_type})`)
    }
    const textLeak = datas.some((d) => d.type === 'content_block_delta' && d.delta?.type === 'text_delta' && String(d.delta?.text ?? '').includes('antArtifact'))
    assert(!textLeak, `passthrough antArtifact not leaked as text_delta`)
  }

  // 15) 透传路径：上游返回 DSML 文本，也应重建为 tool_use 块，且 stop_reason=tool_use
  console.log('[test] anthropic 透传 DSML -> tool_use')
  {
    const r = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'dsml-own-anthropic', max_tokens: 64, stream: true, messages: [{ role: 'user', content: '列出目录' }] }) })
    const text = await r.text()
    const evs = [...text.matchAll(/^event:\s*(\S+)/gm)].map((m) => m[1])
    assert(evs.includes('content_block_start'), `passthrough DSML stream has content_block_start (got ${evs.join(',')})`)
    const datas = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean).map((s) => JSON.parse(s))
    const toolStart = datas.find((d) => d.type === 'content_block_start' && d.content_block?.type === 'tool_use')
    assert(!!toolStart, `passthrough content_block_start type=tool_use present`)
    if (toolStart) {
      assert(toolStart.content_block.name === 'Bash', `passthrough tool name Bash (got ${toolStart.content_block.name})`)
      assert(toolStart.content_block.input?.command === 'ls', `passthrough input.command ls (got ${JSON.stringify(toolStart.content_block.input)})`)
    }
    const textLeak = datas.some((d) => d.type === 'content_block_delta' && d.delta?.type === 'text_delta' && String(d.delta?.text ?? '').includes('DSML'))
    assert(!textLeak, `passthrough DSML not leaked as text_delta`)
    const deltaData = datas.find((d) => d.type === 'message_delta')
    assert(deltaData?.delta?.stop_reason === 'tool_use', `passthrough stop_reason tool_use (got ${deltaData?.delta?.stop_reason})`)
  }

  // 16) 标准协议工具调用（流式）：OpenAI tool_calls 分片 -> Anthropic tool_use 事件
  console.log('[test] streaming standard tool_calls -> tool_use events')
  {
    const r = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({
      model: 'tools-relay', max_tokens: 64, stream: true,
      tools: [{ name: 'Explore', description: 'Explore files', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
      messages: [{ role: 'user', content: '探索当前目录' }],
    }) })
    const text = await r.text()
    const datas = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean).map((s) => JSON.parse(s))
    const toolStart = datas.find((d) => d.type === 'content_block_start' && d.content_block?.type === 'tool_use')
    assert(!!toolStart, `tool_use content_block_start present`)
    if (toolStart) {
      assert(toolStart.content_block.id === 'call_e2e1', `tool id kept (got ${toolStart.content_block.id})`)
      assert(toolStart.content_block.name === 'Explore', `tool name kept (got ${toolStart.content_block.name})`)
    }
    const inputDeltas = datas.filter((d) => d.type === 'content_block_delta' && d.delta?.type === 'input_json_delta')
    assert(inputDeltas.length === 2, `two input_json_delta chunks (got ${inputDeltas.length})`)
    // 分片拼起来应是完整合法 JSON（不做中途 parse）
    const joined = inputDeltas.map((d) => d.delta.partial_json).join('')
    const parsed = JSON.parse(joined)
    assert(parsed.path === 'D:\\work', `joined arguments valid JSON (got ${joined})`)
    const deltaData = datas.find((d) => d.type === 'message_delta')
    assert(deltaData?.delta?.stop_reason === 'tool_use', `stop_reason tool_use (got ${deltaData?.delta?.stop_reason})`)
    assert(deltaData?.usage?.output_tokens > 0, `usage output_tokens (got ${deltaData?.usage?.output_tokens})`)
  }

  // 17) 标准协议工具调用（非流式）+ 第二轮 tool_result 往返
  console.log('[test] non-stream tool_calls -> tool_use + tool_result roundtrip')
  {
    const r1 = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({
      model: 'tools-relay', max_tokens: 64, stream: false,
      tools: [{ name: 'Explore', description: 'Explore files', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
      messages: [{ role: 'user', content: '探索当前目录' }],
    }) })
    const resp = await r1.json()
    assert(resp.stop_reason === 'tool_use', `non-stream stop_reason tool_use (got ${resp.stop_reason})`)
    const tu = (resp.content || []).find((b) => b.type === 'tool_use')
    assert(!!tu, `tool_use block present`)
    if (tu) {
      assert(tu.id === 'call_e2e2', `tool_use id kept (got ${tu.id})`)
      assert(tu.name === 'Explore', `tool_use name (got ${tu.name})`)
      assert(tu.input?.path === 'D:\\work', `tool_use input object (got ${JSON.stringify(tu.input)})`)
    }
    // 第二轮：客户端回传 assistant tool_use + tool_result
    const r2 = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({
      model: 'tools-relay', max_tokens: 64, stream: false,
      tools: [{ name: 'Explore', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
      messages: [
        { role: 'user', content: '探索当前目录' },
        { role: 'assistant', content: resp.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu.id, content: 'src/\npackage.json' }] },
      ],
    }) })
    assert(r2.ok, `second turn ok (got ${r2.status})`)
    // mock 透传收到的 openai 请求应包含 role=tool 与 tool_call_id
    const lastOpenaiReq = received.chat[received.chat.length - 1]
    const toolMsg = (lastOpenaiReq.messages || []).find((m) => m.role === 'tool')
    assert(!!toolMsg, `tool_result converted to role=tool`)
    if (toolMsg) {
      assert(toolMsg.tool_call_id === 'call_e2e2', `tool_call_id stable (got ${toolMsg.tool_call_id})`)
      assert(String(toolMsg.content).includes('src/'), `tool content forwarded (got ${toolMsg.content})`)
    }
    const asstMsg = (lastOpenaiReq.messages || []).find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))
    assert(!!asstMsg, `assistant tool_calls in history`)
    if (asstMsg) assert(asstMsg.tool_calls[0].function.name === 'Explore', `history tool name (got ${asstMsg.tool_calls?.[0]?.function?.name})`)
  }

  // 18) 上游 400 时错误收敛：流式=HTTP 200 + SSE error 事件；非流式=保留状态码 + Anthropic 错误形状
  console.log('[test] upstream 400 error normalization (stream & non-stream)')
  {
    const r1 = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({
      model: 'err-relay', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }],
    }) })
    assert(r1.status === 200, `stream upstream-400 -> HTTP 200 (got ${r1.status})`)
    const text1 = await r1.text()
    const errEv = text1.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5).trim()))[0]
    assert(errEv?.type === 'error', `first SSE event is error (got ${JSON.stringify(errEv)})`)
    assert(errEv?.error?.type === 'invalid_request_error', `error type normalized (got ${errEv?.error?.type})`)
    assert(String(errEv?.error?.message).includes('上游额度不足'), `upstream message kept (got ${errEv?.error?.message})`)
    assert(!text1.includes('message_start'), `no message_start wrapped into error stream`)

    const r2 = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({
      model: 'err-relay', max_tokens: 16, stream: false, messages: [{ role: 'user', content: 'hi' }],
    }) })
    assert(r2.status === 400, `non-stream keeps status 400 (got ${r2.status})`)
    const j2 = await r2.json()
    assert(j2?.type === 'error' && j2?.error?.type === 'invalid_request_error', `non-stream error normalized (got ${JSON.stringify(j2)})`)
  }

  console.log('\nALL E2E PROTOCOL TESTS PASSED')
} catch (e) {
  failed = true
  console.error('\nE2E FAILED:', e.message)
} finally {
  child.kill('SIGTERM')
  mock.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
