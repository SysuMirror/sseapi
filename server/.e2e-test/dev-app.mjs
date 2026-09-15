// 本地演示实例：种子数据 + mock 上游，供浏览器人工验证用法/管理台
// 运行：node .e2e-test/dev-app.mjs  （前台保持运行）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

const PORT = 8120
const BASE = `http://127.0.0.1:${PORT}`
const JWT_SECRET = 'demo-secret'
const ADMIN_OAUTH = '327'
const serverDir = path.resolve(import.meta.dirname, '..')
const UPSTREAM_BASE = `http://127.0.0.1:${PORT + 1}/v1`
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const hashToken = (raw) => createHash('sha256').update(raw).digest('hex')

// mock 上游 chat
const mock = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {}
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: 'cmpl_demo', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: '这是一个演示回复。' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28, prompt_tokens_details: { cached_tokens: 5 } },
    }))
  })
})

const modelRow = (slug, type = 'chat') => ({
  id: 1, slug, display_name: slug, badge: '', card_color: '#3370ff', model_type: type,
  upstream_api_format: 'openai', upstream_path_override: '', upstream_base_url: UPSTREAM_BASE,
  upstream_model: slug, upstream_api_key: '', allowed_origins: '', rpm_limit: 0, max_concurrent: 0,
  input_price_per_1m: 1, output_price_per_1m: 2, cache_price_per_1m: 0.1, multimodal_enabled: 0,
  image_billing_mode: 'token', image_price_per_1m: 0, image_price_per_image: 0, image_tokens_per_image: 512,
  thinking_enabled: 0, thinking_levels: '["off"]', default_thinking: 'off', claude_compat: 0,
  anthropic_base_url: '', anthropic_enabled: 0, responses_base_url: '', responses_enabled: 0,
  enabled: 1, sort_order: 1,
})

// 预置若干 usage 记录（含 prompt），覆盖近 3 天、两个用户、多个模型
const now = Date.now()
const usage_logs = []
let id = 1
const mk = (userId, slug, prompt, comp, cached, status, ageMin) => {
  usage_logs.push({
    id: id++, user_id: userId, api_key_id: userId, model_slug: slug,
    prompt_tokens: 40, cached_tokens: cached, completion_tokens: comp,
    total_tokens: 40 + comp, image_count: 0, cost_cents: Math.round((40 + comp) * 0.0001 * 100),
    status, error_message: status === 'ok' ? '' : 'upstream error', client_meta: 'demo',
    prompt, created_at: new Date(now - ageMin * 60000).toISOString(),
  })
}
for (let d = 2; d >= 0; d--) {
  for (let k = 0; k < 6; k++) {
    const age = d * 1440 + k * 30
    mk(1, 'deepseek-v4-flash', `演示提示词: 帮我写一个关于第${d}天的话题 ${k}`, 120 + k, k > 2 ? 10 : 0, 'ok', age)
    mk(2, 'qwen3.8-27b-awq', `用户 Bob 的请求 第${d}天 ${k}`, 80 + k, 0, k === 0 ? 'error' : 'ok', age + 5)
    mk(1, 'bge-m3', `embedding 调用 ${d}-${k}`, 30, 0, 'ok', age + 10)
  }
}

const keyA = { plain: 'sk-demo-' + Math.random().toString(36).slice(2, 10) }
const store = {
  seq: { users: 2, api_keys: 1, models: 1, usage_logs: usage_logs.length, ledger: 0 },
  users: [
    { id: 1, oauth_id: ADMIN_OAUTH, name: '张三', email: 'admin@demo.cn', avatar_url: '', is_admin: 1, balance_cents: 1000000, admin_note: '', rpm_limit: 0, max_concurrent: 100, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { id: 2, oauth_id: '999', name: '李四', email: 'bob@demo.cn', avatar_url: '', is_admin: 0, balance_cents: 500000, admin_note: '', rpm_limit: 0, max_concurrent: 50, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  ],
  api_keys: [{ id: 1, user_id: 1, name: 'demo', key_prefix: keyA.plain.slice(0, 8), key_hash: hashToken(keyA.plain), allowed_origins: '', rpm_limit: 0, max_concurrent: 0, last_used_at: null, created_at: new Date().toISOString(), revoked_at: null }],
  models: [modelRow('deepseek-v4-flash', 'chat'), modelRow('qwen3.8-27b-awq', 'chat'), modelRow('bge-m3', 'embedding')],
  usage_logs, ledger: [],
  docs: { id: 1, title: 'API 文档', external_url: '', content_md: '', updated_at: new Date().toISOString() },
  oauth_states: [],
  rate_limits: { enabled: 1, default_rpm: 999, default_max_concurrent: 999, updated_at: new Date().toISOString() },
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sseapi-demo-'))
fs.writeFileSync(path.join(dataDir, 'sseapi-store.json'), JSON.stringify(store, null, 2))

const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: serverDir,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, JWT_SECRET, SSEAPI_API_PUBLIC_URL: BASE, PLATFORM_ADMIN_OAUTH_IDS: ADMIN_OAUTH },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let outLog = ''
child.stdout.on('data', (d) => (outLog += d))
child.stderr.on('data', (d) => (outLog += d))

process.on('SIGINT', () => { child.kill('SIGTERM'); mock.close(); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(0) })
process.on('SIGTERM', () => { child.kill('SIGTERM'); mock.close(); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(0) })

async function boot() {
  await new Promise((r) => mock.listen(PORT + 1, '127.0.0.1', r))
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`${BASE}/api/health`); if (r.ok) break } catch {} await wait(200) }
  console.log('[dev-app] server on', BASE, '| data', dataDir, '| key', keyA.plain)
}
boot().catch((e) => { console.error('boot fail', e); child.kill('SIGTERM'); mock.close(); process.exit(1) })
// 保持事件循环
setInterval(() => {}, 1 << 30)
