#!/usr/bin/env node
/**
 * 单点检查：真实上游的流式 SSE 里 usage 块排在 finish_reason **之后**，
 * 反代必须继续读到流结束才能拿到它，否则 response.completed.usage 全是 0。
 *
 * 起一个临时实例（临时 DATA_DIR、MinIO 关掉），只发一次流式 /v1/responses 请求，
 * 打印 response.completed 里的 usage。不打印上游凭据。
 *
 * 用法：node .e2e-test/real-usage-check.mjs [slug]   （默认 text-2.5-flash）
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(__dirname, '..')
const PORT = 8100
const BASE = `http://127.0.0.1:${PORT}`
const PROD_STORE = process.env.PROD_STORE || '/home/cloud/data/sseapi-store.json'
const SLUG = process.argv[2] || 'text-2.5-flash'

const hashToken = (raw) => createHash('sha256').update(raw).digest('hex')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const prod = JSON.parse(fs.readFileSync(PROD_STORE, 'utf8'))
const src = prod.models.find((m) => m.slug === SLUG)
if (!src) {
  console.error(`生产 store 里没有 ${SLUG}`)
  process.exit(2)
}
console.log(`[seed] ${SLUG} → ${src.upstream_base_url}（responses_base_url=${src.responses_base_url || '(空 → 走转换反代)'}）`)

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sseapi-usage-'))
const plainKey = 'sk-e2e-usage-' + Math.random().toString(36).slice(2, 12)
fs.writeFileSync(
  path.join(dataDir, 'sseapi-store.json'),
  JSON.stringify(
    {
      seq: { users: 1, api_keys: 1, models: 1, usage_logs: 0, ledger: 0 },
      users: [{ id: 1, oauth_id: 'e2e', name: 'e2e', email: '', avatar_url: '', is_admin: 1, balance_cents: 100000000, admin_note: '', rpm_limit: 0, max_concurrent: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
      api_keys: [{ id: 1, user_id: 1, name: 'usage', key_prefix: plainKey.slice(0, 8), key_hash: hashToken(plainKey), allowed_origins: '', rpm_limit: 0, max_concurrent: 0, last_used_at: null, created_at: new Date().toISOString(), revoked_at: null }],
      models: [{ ...src, id: 1, sort_order: 1 }],
      usage_logs: [],
      ledger: [],
      docs: { id: 1, title: 'API 文档', external_url: '', content_md: '', updated_at: '' },
      oauth_states: [],
      rate_limits: { enabled: 1, default_rpm: 999, default_max_concurrent: 999, updated_at: '' },
    },
    null,
    2,
  ),
)

const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: serverDir,
  env: {
    ...process.env,
    PORT: String(PORT),
    DATA_DIR: dataDir,
    JWT_SECRET: 'e2e',
    PLATFORM_ADMIN_OAUTH_IDS: 'e2e',
    MINIO_ENDPOINT: '',
    MINIO_ACCESS_KEY: '',
    MINIO_SECRET: '',
    MINIO_BUCKET: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
child.stdout.on('data', (d) => (log += d))
child.stderr.on('data', (d) => (log += d))

try {
  let up = false
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${plainKey}` } })
      if (r.ok) { up = true; break }
    } catch {}
    await wait(250)
  }
  if (!up) throw new Error('server 未启动: ' + log.slice(-500))

  const res = await fetch(`${BASE}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${plainKey}` },
    body: JSON.stringify({ model: SLUG, input: 'Reply with the single word PONG', stream: true }),
  })
  const text = await res.text()
  const types = []
  let completed = null
  let failed = null
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    let j
    try { j = JSON.parse(t.slice(5).trim()) } catch { continue }
    if (j?.type) types.push(j.type)
    if (j?.type === 'response.completed') completed = j.response
    if (j?.type === 'response.failed') failed = j.response?.error
  }
  const first = types[0]
  const last = types[types.length - 1]
  const usage = completed?.usage
  const inTok = usage?.input_tokens ?? 0
  const outTok = usage?.output_tokens ?? 0

  console.log(`  事件序列: ${types.join(' → ')}`)
  console.log(`  首事件=${first}  末事件=${last}`)
  console.log(`  usage: ${JSON.stringify(usage)}`)
  if (failed) console.log(`  response.failed: ${JSON.stringify(failed)}`)

  const ok = first === 'response.created' && last === 'response.completed' && inTok > 0 && outTok > 0
  console.log(ok ? '\n==== USAGE CHECK PASSED ====' : '\n==== USAGE CHECK FAILED ====')
  process.exitCode = ok ? 0 : 1
} catch (e) {
  console.error('CHECK ERROR:', e.message)
  console.error(log.slice(-800))
  process.exitCode = 1
} finally {
  child.kill('SIGKILL')
  fs.rmSync(dataDir, { recursive: true, force: true })
}
