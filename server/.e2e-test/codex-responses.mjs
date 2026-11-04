// e2e: 用真实 Codex CLI (wire_api=responses) 打平台的 /v1/responses。
//
// 覆盖两条链路：
//   A. 原生透传：模型配了 responses_base_url，平台把上游 Responses SSE 原样透传
//   B. 转换兜底：模型只有 OpenAI chat 上游，平台把 Responses 请求转成 chat、再把
//      流式 chunk 反向规范成 Responses 事件（codex 0.162 已移除 wire_api=chat，
//      这条路径是绝大多数模型的唯一通路）
//
// 用法：node .e2e-test/codex-responses.mjs
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(__dirname, '..')
const PORT = 8100
const UPSTREAM_PORT = 8101
const BASE = `http://127.0.0.1:${PORT}`
const CODEX_BIN = '/tmp/codex-cli/node_modules/.bin/codex'

const MODE = process.argv[2] || 'both' // both | passthrough | relay

const hashToken = (raw) => createHash('sha256').update(raw).digest('hex')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 上游 mock ----------
// 一个「规范实现」的 Responses 上游：SSE 事件序列按 OpenAI 官方约定，
// 补全 codex 解析所需的每一个字段，用来对照平台转换层丢掉了什么。
const received = { responses: [], chat: [] }

function sseEvents(res, events) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  for (const ev of events) {
    res.write(`event: ${ev.type}\n`)
    res.write(`data: ${JSON.stringify(ev)}\n\n`)
  }
  res.write('data: [DONE]\n\n')
  res.end()
}

// 上游原生流式 Responses
function upstreamResponsesStream(res, body) {
  const respId = 'resp_up_1'
  const msgId = 'msg_up_1'
  const text = 'PONG'
  const seq = () => seq.n++
  seq.n = 0

  // 与 chat mock 对齐：首轮先回一个 tool_call，拿到工具结果后再回文本
  const inputItems = Array.isArray(body.input) ? body.input : []
  const seenToolResult = inputItems.some((it) => it && it.type === 'function_call_output')
  const tools = Array.isArray(body.tools) ? body.tools : []
  if (!seenToolResult && tools.length) {
    const name = tools[0].name || tools[0]?.function?.name || 'exec_command'
    const fcId = 'fc_up_1'
    const callId = 'call_up_tool'
    const args = '{"cmd":"echo hello-from-tool"}'
    sseEvents(res, [
      { type: 'response.created', sequence_number: seq(), response: { id: respId, object: 'response', status: 'in_progress', model: body.model, output: [] } },
      { type: 'response.in_progress', sequence_number: seq(), response: { id: respId, object: 'response', status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', sequence_number: seq(), output_index: 0, item: { id: fcId, type: 'function_call', call_id: callId, name, arguments: '' } },
      { type: 'response.function_call_arguments.delta', sequence_number: seq(), item_id: fcId, output_index: 0, delta: args },
      { type: 'response.function_call_arguments.done', sequence_number: seq(), item_id: fcId, output_index: 0, arguments: args },
      { type: 'response.output_item.done', sequence_number: seq(), output_index: 0, item: { id: fcId, type: 'function_call', call_id: callId, name, arguments: args, status: 'completed' } },
      {
        type: 'response.completed', sequence_number: seq(),
        response: {
          id: respId, object: 'response', status: 'completed', model: body.model,
          output: [{ id: fcId, type: 'function_call', call_id: callId, name, arguments: args, status: 'completed' }],
          usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
        },
      },
    ])
    return
  }

  const events = [
    {
      type: 'response.created',
      sequence_number: seq(),
      response: {
        id: respId, object: 'response', created_at: 1700000000, status: 'in_progress',
        model: body.model, output: [], parallel_tool_calls: true, tool_choice: 'auto',
        tools: [], usage: null, error: null, incomplete_details: null, instructions: null,
        metadata: {}, temperature: 1, top_p: 1, max_output_tokens: null,
      },
    },
    { type: 'response.in_progress', sequence_number: seq(), response: { id: respId, object: 'response', status: 'in_progress', output: [] } },
    {
      type: 'response.output_item.added', sequence_number: seq(), output_index: 0,
      item: { id: msgId, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
    },
    {
      type: 'response.content_part.added', sequence_number: seq(), item_id: msgId,
      output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] },
    },
    { type: 'response.output_text.delta', sequence_number: seq(), item_id: msgId, output_index: 0, content_index: 0, delta: text, logprobs: [] },
    { type: 'response.output_text.done', sequence_number: seq(), item_id: msgId, output_index: 0, content_index: 0, text, logprobs: [] },
    {
      type: 'response.content_part.done', sequence_number: seq(), item_id: msgId,
      output_index: 0, content_index: 0, part: { type: 'output_text', text, annotations: [] },
    },
    {
      type: 'response.output_item.done', sequence_number: seq(), output_index: 0,
      item: {
        id: msgId, type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    },
    {
      type: 'response.completed', sequence_number: seq(),
      response: {
        id: respId, object: 'response', created_at: 1700000000, status: 'completed',
        model: body.model,
        output: [{
          id: msgId, type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        }],
        usage: {
          input_tokens: 11, output_tokens: 4, total_tokens: 15,
          input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ]
  sseEvents(res, events)
}

// 上游 OpenAI chat：流式（供平台转换兜底路径使用）
//
// 行为像真的 agent 上游：
//   - 首轮（上下文里还没有 tool 结果）→ 返回一个 tool_call，逼客户端走工具闭环
//   - 拿到 tool 结果后再来 → 返回最终文本 PONG
function upstreamChatStream(res, body) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const chunk = (delta, finish = null, usage) => {
    const j = { id: 'cmpl_1', object: 'chat.completion.chunk', created: 1700000000, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] }
    if (usage) j.usage = usage
    res.write(`data: ${JSON.stringify(j)}\n\n`)
  }
  const seenToolResult = (body.messages || []).some((m) => m.role === 'tool')
  const tools = Array.isArray(body.tools) ? body.tools : []
  const firstTool = tools[0]?.function?.name || tools[0]?.name || 'exec_command'

  if (!seenToolResult && tools.length) {
    // 工具调用分片：先给 id/name，再分片给 arguments
    chunk({ role: 'assistant', content: '' })
    chunk({ tool_calls: [{ index: 0, id: 'call_e2e_tool', type: 'function', function: { name: firstTool, arguments: '' } }] })
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"cmd":"echo ' } }] })
    chunk({ tool_calls: [{ index: 0, function: { arguments: 'hello-from-tool"}' } }] })
    chunk({}, 'tool_calls', { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 })
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }

  chunk({ role: 'assistant', content: '' })
  for (const part of ['PON', 'G']) chunk({ content: part })
  chunk({}, 'stop', { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 })
  res.write('data: [DONE]\n\n')
  res.end()
}

const mock = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    let body = {}
    try { body = raw ? JSON.parse(raw) : {} } catch { body = {} }
    if (req.url.startsWith('/v1/responses')) {
      received.responses.push(body)
      if (process.env.DUMP) fs.writeFileSync('/tmp/last-responses-req.json', JSON.stringify(body, null, 1))
      // 错误路径复现：真实上游（如 gpt-proxy）在密钥冷却时长这样
      if (body.model === 'up-503') {
        res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '120' })
        res.end(JSON.stringify({ error: { message: 'All API keys are cooling down', type: 'server_error' } }))
        return
      }
      if (body.model === 'up-sse-err') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.write('data: {"error": {"message": "All API keys are cooling down", "type": "server_error"}}\n\n')
        res.end()
        return
      }
      if (body.stream) return upstreamResponsesStream(res, body)
      const items = Array.isArray(body.input) ? body.input : []
      const hasToolResult = items.some((it) => it && it.type === 'function_call_output')
      const toolList = Array.isArray(body.tools) ? body.tools : []
      const output =
        !hasToolResult && toolList.length
          ? [{
              id: 'fc_up_1', type: 'function_call', status: 'completed',
              call_id: 'call_up_tool',
              name: toolList[0].name || toolList[0]?.function?.name || 'exec_command',
              arguments: '{"cmd":"echo hello-from-tool"}',
            }]
          : [{ type: 'message', id: 'msg_up_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'PONG', annotations: [] }] }]
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'resp_up_1', object: 'response', status: 'completed', model: body.model, output, usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }))
      return
    }
    if (req.url.startsWith('/v1/chat/completions')) {
      received.chat.push(body)
      if (process.env.DUMP) fs.writeFileSync('/tmp/last-chat-req.json', JSON.stringify(body, null, 1))
      if (body.stream) return upstreamChatStream(res, body)
      const seenToolResult = (body.messages || []).some((m) => m.role === 'tool')
      const tools = Array.isArray(body.tools) ? body.tools : []
      const firstName = tools[0]?.function?.name || tools[0]?.name || 'exec_command'
      const message =
        !seenToolResult && tools.length
          ? {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'call_e2e_tool', type: 'function', function: { name: firstName, arguments: '{"cmd":"echo hello-from-tool"}' } }],
            }
          : { role: 'assistant', content: 'PONG' }
      const finish = !seenToolResult && tools.length ? 'tool_calls' : 'stop'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'cmpl_1', object: 'chat.completion', model: body.model, choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":{"message":"not found"}}')
  })
})

// ---------- 平台测试实例 ----------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sseapi-codex-'))
const plainKey = 'sk-e2e-codex-' + Math.random().toString(36).slice(2, 12)
const UPSTREAM = `http://127.0.0.1:${UPSTREAM_PORT}/v1`
const base = {
  id: 1, slug: 'm', display_name: 'm', badge: '', card_color: '#111', model_type: 'chat',
  upstream_api_format: 'openai', upstream_path_override: '', upstream_base_url: UPSTREAM,
  upstream_model: 'upstream-model', upstream_api_key: '', allowed_origins: '',
  rpm_limit: 0, max_concurrent: 0, input_price_per_1m: 1, output_price_per_1m: 1,
  cache_price_per_1m: 0, multimodal_enabled: 0, image_billing_mode: 'token',
  image_price_per_1m: 0, image_price_per_image: 0, image_tokens_per_image: 512,
  thinking_enabled: 0, thinking_levels: '["off"]', default_thinking: 'off',
  claude_compat: 0, context_length: 0, dev_only: 0, enabled: 1, sort_order: 1,
  created_at: '', updated_at: '',
}
const modelPassthrough = { ...base, id: 1, slug: 'codex-passthrough', responses_base_url: UPSTREAM, responses_enabled: 1 }
const modelRelay = { ...base, id: 2, slug: 'codex-relay', responses_base_url: '', responses_enabled: 1 }
const modelUp503 = { ...base, id: 3, slug: 'codex-up503', upstream_model: 'up-503', responses_base_url: UPSTREAM, responses_enabled: 1 }
const modelUpSseErr = { ...base, id: 4, slug: 'codex-up-sse-err', upstream_model: 'up-sse-err', responses_base_url: UPSTREAM, responses_enabled: 1 }

const store = {
  seq: { users: 1, api_keys: 1, models: 4, usage_logs: 0, ledger: 0 },
  users: [{ id: 1, oauth_id: 'e2e', name: 'e2e', email: '', avatar_url: '', is_admin: 1, balance_cents: 1000000, admin_note: '', rpm_limit: 0, max_concurrent: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
  api_keys: [{ id: 1, user_id: 1, name: 'codex', key_prefix: plainKey.slice(0, 8), key_hash: hashToken(plainKey), allowed_origins: '', rpm_limit: 0, max_concurrent: 0, last_used_at: null, created_at: new Date().toISOString(), revoked_at: null }],
  models: [modelPassthrough, modelRelay, modelUp503, modelUpSseErr],
  usage_logs: [], ledger: [],
  docs: { id: 1, title: 'API 文档', external_url: '', content_md: '', updated_at: '' },
  oauth_states: [],
  rate_limits: { enabled: 1, default_rpm: 999, default_max_concurrent: 999, updated_at: '' },
}
fs.writeFileSync(path.join(dataDir, 'sseapi-store.json'), JSON.stringify(store, null, 2))

await new Promise((r) => mock.listen(UPSTREAM_PORT, '127.0.0.1', r))

const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: serverDir,
  env: {
    ...process.env,
    PORT: String(PORT),
    DATA_DIR: dataDir,
    JWT_SECRET: 'e2e',
    PLATFORM_ADMIN_OAUTH_IDS: 'e2e',
    // 屏蔽 server/.env 里的 MinIO 配置，否则会从桶里读生产 store，覆盖本地测试数据
    MINIO_ENDPOINT: '',
    MINIO_ACCESS_KEY: '',
    MINIO_SECRET: '',
    MINIO_BUCKET: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
child.stdout.on('data', (d) => (serverLog += d))
child.stderr.on('data', (d) => (serverLog += d))

async function boot() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${plainKey}` } })
      if (r.ok) return
    } catch {}
    await wait(200)
  }
  throw new Error('server 未启动: ' + serverLog.slice(-800))
}

// ---------- codex 配置 ----------
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'))
function writeCodexConfig(model) {
  const toml = `model = "${model}"
model_provider = "sseapi"
approval_policy = "never"
sandbox_mode = "read-only"

[model_providers.sseapi]
name = "SSEAPI"
base_url = "${BASE}/v1"
env_key = "SSEAPI_KEY"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0

[features]
`
  fs.writeFileSync(path.join(codexHome, 'config.toml'), toml)
}

// 必须用异步 spawn：spawnSync 会阻塞本进程事件循环，同进程的 mock 上游就无法应答，
// 导致 codex 的流一直挂住（这是 harness 自身的坑，不是被测代码的问题）。
function runCodex(model) {
  writeCodexConfig(model)
  return new Promise((resolve) => {
    const child = spawn(CODEX_BIN, ['exec', '--skip-git-repo-check', '--json', 'Reply with the single word PONG'], {
      env: { ...process.env, CODEX_HOME: codexHome, SSEAPI_KEY: plainKey, HOME: codexHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ status: code, stdout, stderr })
    })
  })
}

// 官方 OpenAI Python SDK 符合性测试（严格校验事件顺序与响应 schema）
const SDK_PY = '/tmp/openai-venv/bin/python'
const SDK_SCRIPT = path.join(__dirname, 'responses-sdk-conformance.py')

function runSdk(model) {
  return new Promise((resolve) => {
    const child = spawn(SDK_PY, [SDK_SCRIPT], {
      env: { ...process.env, BASE, KEY: plainKey, MODEL: model },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ status: code, out })
    })
  })
}

function hasPong(out) {
  return /PONG/.test(out)
}

let failed = false
const results = []
function report(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ok  ' : ' FAIL '} - ${name}${ok ? '' : '\n         ' + String(detail).split('\n').slice(0, 12).join('\n         ')}`)
  if (!ok) failed = true
}

try {
  await boot()
  console.log('[boot] platform up, upstream mock up\n')

  if (MODE === 'standup') {
    writeCodexConfig('codex-passthrough')
    console.log('BASE=' + BASE)
    console.log('CODEX_HOME=' + codexHome)
    console.log('SSEAPI_KEY=' + plainKey)
    console.log('DATA_DIR=' + dataDir)
    console.log('(Ctrl-C to stop)')
    await new Promise(() => {})
  }

  if (MODE === 'both' || MODE === 'passthrough') {
    console.log('[codex] passthrough (responses_base_url 直连上游 Responses)')
    received.responses.length = 0
    const r = await runCodex('codex-passthrough')
    report('codex 透传链路拿到 PONG', hasPong(r.stdout), `exit=${r.status}\nstdout=${r.stdout.slice(-1500)}\nstderr=${r.stderr.slice(-1500)}`)
    report('上游确实收到 Responses 请求', received.responses.length > 0, `received=${received.responses.length}`)
    const toolRound = received.responses.find((b) => (b.input || []).some((i) => i && i.type === 'function_call_output'))
    report('透传链路完成工具闭环（带上 function_call_output 回上游）', Boolean(toolRound), `rounds=${received.responses.length}`)
  }

  if (MODE === 'both' || MODE === 'relay') {
    console.log('[codex] relay (只有 chat 上游，平台转换兜底)')
    received.chat.length = 0
    const r = await runCodex('codex-relay')
    report('codex 兜底链路拿到 PONG', hasPong(r.stdout), `exit=${r.status}\nstdout=${r.stdout.slice(-2500)}\nstderr=${r.stderr.slice(-2500)}`)
    report('上游确实收到 chat 请求', received.chat.length > 0, `received=${received.chat.length}`)

    const firstReq = received.chat[0] || {}
    const firstTool = (firstReq.tools || [])[0]
    report('tools 已转成 Chat 嵌套形状', Boolean(firstTool && firstTool.function && firstTool.function.name), `tools[0]=${JSON.stringify(firstTool)?.slice(0, 200)}`)
    report('developer 指令转成了 system 角色（而非 user）', (firstReq.messages || [])[0]?.role === 'system', `roles=${JSON.stringify((firstReq.messages || []).map((m) => m.role))}`)

    const lastReq = received.chat[received.chat.length - 1] || {}
    const msgs = lastReq.messages || []
    const assistantWithCalls = msgs.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length)
    const toolMsg = msgs.find((m) => m.role === 'tool')
    report('工具调用转成了 assistant.tool_calls', Boolean(assistantWithCalls), `msgs=${JSON.stringify(msgs.map((m) => m.role))}`)
    report('工具结果转成了 role=tool 且 tool_call_id 对齐', Boolean(toolMsg) && toolMsg.tool_call_id === assistantWithCalls?.tool_calls?.[0]?.id, `tool=${JSON.stringify(toolMsg)?.slice(0, 200)}`)
  }

  if (MODE === 'both' || MODE === 'errors') {
    // 上游 503（真实状态码 + Retry-After）→ 客户端应看到上游的真实错误文案
    console.log('[codex] 错误路径：上游 503')
    const r503 = await runCodex('codex-up503')
    const text503 = r503.stdout + r503.stderr
    report('上游 503 时客户端能看到真实错误文案', /cooling down/.test(text503), `exit=${r503.status}\n${text503.slice(-1200)}`)

    // 上游 200 + SSE 里塞错误 → 平台应规范成 response.failed（而不是「流意外结束」）
    console.log('[codex] 错误路径：上游 200 + SSE 错误体')
    const rSse = await runCodex('codex-up-sse-err')
    const textSse = rSse.stdout + rSse.stderr
    report('上游 200+SSE 错误时客户端能看到真实错误文案', /cooling down/.test(textSse), `exit=${rSse.status}\n${textSse.slice(-1200)}`)
  }

  if (MODE === 'both' || MODE === 'passthrough' || MODE === 'relay' || MODE === 'sdk') {
    for (const model of MODE === 'both' || MODE === 'sdk' ? ['codex-relay', 'codex-passthrough'] : [MODE === 'passthrough' ? 'codex-passthrough' : 'codex-relay']) {
      console.log(`[sdk] 官方 OpenAI SDK 符合性 (${model})`)
      const s = await runSdk(model)
      console.log(s.out.trimEnd())
      report(`官方 SDK 符合性通过 (${model})`, s.status === 0, `exit=${s.status}`)
    }
  }
} catch (e) {
  failed = true
  console.error('HARNESS ERROR:', e.message)
} finally {
  child.kill('SIGKILL')
  mock.close()
  try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(codexHome, { recursive: true, force: true }) } catch {}
}

console.log('\n==== ' + (failed ? 'FAILED' : 'ALL PASSED') + ' ====')
process.exit(failed ? 1 : 0)
