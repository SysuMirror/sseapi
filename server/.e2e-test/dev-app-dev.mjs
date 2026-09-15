// 本地演示实例（带开发者平台 mock）：供浏览器验证管理台「用户用量」开发者徽标 + 需求单
// 运行：node .e2e-test/dev-app-dev.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sm2 = require('sm-crypto').sm2

const PORT = 8121
const BASE = `http://127.0.0.1:${PORT}`
const DEV_PORT = 8132
const DEV_BASE = `http://127.0.0.1:${DEV_PORT}`
const JWT_SECRET = 'demo-secret'
const ADMIN_OAUTH = '327'
const MODULE_SLUG = 'platform'
const MODULE_KP = sm2.generateKeyPairHex()
const MODULE_PRIV = MODULE_KP.privateKey
const MODULE_PUB = MODULE_KP.publicKey

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

// mock 开发者平台开放 API（SM2 验签 + 开发者/需求数据）
const devSeenNonce = new Map()
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

  let body = null
  if (req.url.startsWith('/api/open/developers/check')) {
    const oauthId = new URL(req.url, DEV_BASE).searchParams.get('oauthId')
    if (oauthId === '999') {
      body = { found: true, isDeveloper: true, isAdmin: false, userId: 42, oauthId, name: '李四', nickname: '', displayName: '李四', profile: {} }
    } else {
      body = { found: false, isDeveloper: false, isAdmin: false, userId: null, oauthId, name: '', nickname: '', displayName: '' }
    }
  } else if (req.url.startsWith('/api/open/users/42/reqs')) {
    body = {
      page: 1, pageSize: 50, total: 3,
      items: [
        { id: 1, title: 'API 网关限流策略', description: '', bizId: 1, bizName: '基础服务', stage: 'dev', stageLabel: '开发中', priority: 1, dueDate: '2026-09-20', archived: false, ownerUserId: 42, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z' },
        { id: 2, title: '模块 SM2 鉴权接入', description: '', bizId: 2, bizName: '开发者平台', stage: 'review', stageLabel: '评审中', priority: 2, dueDate: '', archived: false, ownerUserId: 42, createdAt: '2026-09-02T00:00:00Z', updatedAt: '2026-09-06T00:00:00Z' },
        { id: 3, title: '用量报表优化', description: '', bizId: 1, bizName: '基础服务', stage: 'deploy', stageLabel: '待发布', priority: 3, dueDate: '2026-09-30', archived: false, ownerUserId: 42, createdAt: '2026-09-03T00:00:00Z', updatedAt: '2026-09-07T00:00:00Z' },
      ],
      user: { userId: 42, oauthId: '999', name: '李四', nickname: '', displayName: '李四' },
    }
  } else {
    res.writeHead(404); res.end(JSON.stringify({ code: 404, message: 'not found' })); return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ code: 0, message: 'ok', data: body }))
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
  for (let k = 0; k < 4; k++) {
    const age = d * 1440 + k * 30
    mk(1, 'deepseek-v4-flash', `张三: 演示提示词 第${d}天 ${k}`, 120, k > 2 ? 10 : 0, 'ok', age)
    mk(2, 'qwen3.8-27b-awq', `李四: 请求 第${d}天 ${k}`, 80, 0, k === 0 ? 'error' : 'ok', age + 5)
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
  models: [modelRow('deepseek-v4-flash', 'chat'), modelRow('qwen3.8-27b-awq', 'chat')],
  usage_logs, ledger: [],
  docs: { id: 1, title: 'API 文档', external_url: '', content_md: '', updated_at: new Date().toISOString() },
  oauth_states: [],
  rate_limits: { enabled: 1, default_rpm: 999, default_max_concurrent: 999, updated_at: new Date().toISOString() },
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sseapi-demo2-'))
fs.writeFileSync(path.join(dataDir, 'sseapi-store.json'), JSON.stringify(store, null, 2))

const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: serverDir,
  env: {
    ...process.env, PORT: String(PORT), DATA_DIR: dataDir, JWT_SECRET, SSEAPI_API_PUBLIC_URL: BASE, PLATFORM_ADMIN_OAUTH_IDS: ADMIN_OAUTH,
    DEVELOPER_API_BASE: DEV_BASE, DEVELOPER_MODULE_SLUG: MODULE_SLUG, DEVELOPER_MODULE_PRIVATE_KEY: MODULE_PRIV,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let outLog = ''
child.stdout.on('data', (d) => (outLog += d))
child.stderr.on('data', (d) => (outLog += d))

process.on('SIGINT', () => { child.kill('SIGTERM'); mock.close(); devApi.close(); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(0) })
process.on('SIGTERM', () => { child.kill('SIGTERM'); mock.close(); devApi.close(); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(0) })

async function boot() {
  await new Promise((r) => devApi.listen(DEV_PORT, '127.0.0.1', r))
  await new Promise((r) => mock.listen(PORT + 1, '127.0.0.1', r))
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`${BASE}/api/health`); if (r.ok) break } catch {} await wait(200) }
  console.log('[dev-app-dev] server on', BASE, '| dev', DEV_BASE, '| key', keyA.plain)
}
boot().catch((e) => { console.error('boot fail', e); child.kill('SIGTERM'); mock.close(); devApi.close(); process.exit(1) })
setInterval(() => {}, 1 << 30)
