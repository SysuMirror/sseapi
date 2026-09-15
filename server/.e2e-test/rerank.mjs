// 端到端：验证 rerank 模型（硅流/SiliconFlow 格式）注册 → 代理 → 计费 → 探测。
// 启动 mock 上游（返回 SiliconFlow 风格 rerank），再启动后端，
// 断言：/v1/rerank 代理返回归一化 OpenAI 形状、usage_logs 按 meta.tokens 计费、探测 mode=rerank。
// 同时做 rerank-adapter 的单元断言（cohere/jina/tei/openai 多格式）。
// 运行：node .e2e-test/rerank.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import {
  buildRerankUpstreamRequest,
  normalizeRerankToOpenAi,
} from '../dist/services/rerank-adapter.js'

let failed = false
function assert(cond, msg) { if (!cond) { failed = true; console.log('FAIL:', msg) } else { console.log('  ok -', msg) } }

const UP_PORT = 8094
const PORT = 8100
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

// —— mock 上游：SiliconFlow 风格 /v1/rerank ——
const mockResults = [
  { index: 1, document: { text: '苹果' }, relevance_score: 0.85 },
  { index: 2, document: { text: '香蕉' }, relevance_score: 0.72 },
  { index: 3, document: { text: '猕猴桃' }, relevance_score: 0.31 },
]
const mockMeta = { tokens: { input_tokens: 150, output_tokens: 10, image_tokens: 0 }, billed_units: { input_tokens: 150, output_tokens: 10, image_tokens: 0, search_units: 1, classifications: 0 } }

const upstream = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'rerank-mock', model: 'BAAI/bge-reranker-v2-m3', results: mockResults, meta: mockMeta }))
  })
})

const modelRow = (fmt = 'siliconflow') => ({ id: 1, slug: 'bge-reranker', display_name: 'BGE Reranker', badge: '', card_color: '#111', model_type: 'rerank', upstream_api_format: fmt, upstream_path_override: '', upstream_base_url: UPSTREAM, upstream_model: 'BAAI/bge-reranker-v2-m3', upstream_api_key: '', allowed_origins: '', rpm_limit: 0, max_concurrent: 0, input_price_per_1m: 10, output_price_per_1m: 10, cache_price_per_1m: 0, multimodal_enabled: 0, image_billing_mode: 'token', image_price_per_1m: 0, image_price_per_image: 0, image_tokens_per_image: 512, thinking_enabled: 0, thinking_levels: '["off"]', default_thinking: 'off', claude_compat: 0, anthropic_base_url: '', anthropic_enabled: 0, responses_base_url: '', responses_enabled: 0, enabled: 1, sort_order: 1 })
const plainKey = 'sk-e2e-' + Math.random().toString(36).slice(2, 12)
const store = {
  seq: { users: 1, api_keys: 1, models: 1, usage_logs: 0, ledger: 0 },
  users: [{ id: 1, oauth_id: ADMIN_OAUTH, name: 'admin', email: '', avatar_url: '', is_admin: 1, balance_cents: 100000, admin_note: '', rpm_limit: 0, max_concurrent: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
  api_keys: [{ id: 1, user_id: 1, name: 't', key_prefix: plainKey.slice(0, 8), key_hash: hashToken(plainKey), allowed_origins: '', rpm_limit: 0, max_concurrent: 0, last_used_at: null, created_at: new Date().toISOString(), revoked_at: null }],
  models: [modelRow()], usage_logs: [], ledger: [],
  docs: { id: 1, title: 'API 文档', external_url: '', content_md: '', updated_at: new Date().toISOString() },
  oauth_states: [],
  rate_limits: { enabled: 1, default_rpm: 999, default_max_concurrent: 999, updated_at: new Date().toISOString() },
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sseapi-rerank-'))
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

async function main() {
  await new Promise((r) => upstream.listen(UP_PORT, r))
  await boot()
  console.log('[boot] ready\n')

  // —— 单元：rerank-adapter 多格式 ——
  console.log('[unit] rerank-adapter 多格式')
  const baseRow = modelRow()
  const built = buildRerankUpstreamRequest(baseRow, { model: baseRow.upstream_model, query: '苹果', documents: ['苹果', '香蕉'], top_n: 2, return_documents: true })
  assert(built.urlPath === '/v1/rerank', `siliconflow path /v1/rerank (${built.urlPath})`)
  assert(built.payload.model === 'BAAI/bge-reranker-v2-m3', `payload.model`)
  assert(Array.isArray(built.payload.documents) && built.payload.documents.length === 2, `payload.documents array`)

  const teiRow = modelRow('tei')
  const teiBuilt = buildRerankUpstreamRequest(teiRow, { model: 'x', query: 'q', documents: ['a', 'b'] })
  assert(teiBuilt.urlPath === '/rerank', `tei path /rerank (${teiBuilt.urlPath})`)
  assert(teiBuilt.payload.texts.length === 2 && teiBuilt.payload.query === 'q', `tei payload {query, texts}`)

  const norm = normalizeRerankToOpenAi(baseRow, { results: mockResults, meta: mockMeta }, 'bge-reranker', 1, true)
  assert(norm.object === 'list', `normalized object=list`)
  assert(norm.data.length === 3, `normalized data len=3 (${norm.data.length})`)
  assert(norm.data[0].index === 1 && norm.data[0].score === 0.85, `normalized data[0] index/score`)
  assert(norm.data[0].document === '苹果', `normalized data[0].document text`)
  assert(norm.usage.prompt_tokens === 150 && norm.usage.completion_tokens === 10, `usage from meta.tokens (${norm.usage.prompt_tokens}/${norm.usage.completion_tokens})`)
  assert(norm.usage.total_tokens === 160, `total=160 (${norm.usage.total_tokens})`)

  // —— E2E：/v1/rerank 代理 + 计费 ——
  console.log('[e2e] POST /v1/rerank')
  const r = await fetch(`${BASE}/v1/rerank`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${plainKey}` },
    body: JSON.stringify({ model: 'bge-reranker', query: '苹果', documents: ['苹果', '香蕉', '猕猴桃'], top_n: 3, return_documents: true }),
  })
  const body = await r.json()
  assert(r.status === 200, `status 200 (${r.status})`)
  assert(body.object === 'list' && Array.isArray(body.data), `body.data array`)
  assert(body.data.length === 3, `body.data len=3 (${body.data.length})`)
  assert(body.usage?.prompt_tokens === 150, `body.usage.prompt_tokens=150 (${body.usage?.prompt_tokens})`)
  assert(body.usage?.total_tokens === 160, `body.usage.total_tokens=160 (${body.usage?.total_tokens})`)

  // —— 计费落库 ——
  await wait(300)
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'sseapi-store.json'), 'utf8'))
  const lastLog = (onDisk.usage_logs || []).slice(-1)[0]
  assert(!!lastLog, `a usage_log written`)
  if (lastLog) {
    assert(lastLog.model_slug === 'bge-reranker', `log.model_slug=${lastLog.model_slug}`)
    assert(lastLog.prompt_tokens === 150, `log.prompt_tokens=150 (${lastLog.prompt_tokens})`)
    assert(lastLog.completion_tokens === 10, `log.completion_tokens=10 (${lastLog.completion_tokens})`)
    assert(lastLog.total_tokens === 160, `log.total_tokens=160 (${lastLog.total_tokens})`)
    assert(lastLog.status === 'ok', `log.status=ok`)
  }

  // —— 探测：admin /models/1/test（rerank） ——
  console.log('[e2e] admin probe rerank')
  const p = await fetch(`${BASE}/api/admin/models/1/test`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${makeJwt(1, JWT_SECRET)}` }, body: JSON.stringify({ stream: false, prompt: '苹果\n香蕉\n猕猴桃\n西瓜' }) })
  const pj = await p.json()
  const pd = pj.data || pj
  assert(pd.mode === 'rerank', `probe mode=rerank (${pd.mode})`)
  assert(pd.ok === true, `probe ok=true`)
  assert(pd.usageParsed?.prompt === 150, `probe usageParsed.prompt=150 (${pd.usageParsed?.prompt})`)
  assert(pd.usageParsed?.source === 'upstream', `probe usage source=upstream`)
  assert(pd.content && pd.content.includes('条重排结果'), `probe content 条数 (${pd.content})`)

  console.log(failed ? '\nRERANK TESTS FAILED' : '\nRERANK TESTS PASSED')
}
main().catch((e) => { failed = true; console.error('\nFAILED:', e.message) }).finally(() => {
  child.kill('SIGTERM'); upstream.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
  setTimeout(() => process.exit(failed ? 1 : 0), 100)
})
