#!/usr/bin/env node
/**
 * 用**真实上游 + 真实 Codex CLI** 验证已部署的 /v1/responses。
 *
 * 与 codex-responses.mjs 的分工：
 *   - codex-responses.mjs 对着 mock 上游，能精确断言事件序列、工具参数、错误语义；
 *   - 本脚本对着生产里那批真实上游（gpt-5.5 / qwen-3.8-flash-fast …），
 *     证明「修好的协议在真模型上确实跑得通」，而不只是对着 mock 自证。
 *
 * 隔离：从生产 store 只读地复制模型行（上游地址/密钥），但服务跑在临时 DATA_DIR，
 * MinIO 显式禁用，密钥是临时生成的 sk-e2e-real-*。不写生产数据、不建生产 key。
 * 上游凭据只在内存里流转，任何日志都不打印。
 *
 * 用法：node .e2e-test/real-upstream-verify.mjs [slug ...]
 *   默认 slug：gpt-5.5 qwen-3.8-flash-fast
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(__dirname, '..')
const repoRoot = path.resolve(serverDir, '..')

const PORT = 8100
const BASE = `http://127.0.0.1:${PORT}`
const CODEX_BIN = '/tmp/codex-cli/node_modules/.bin/codex'
const SDK_PY = '/tmp/openai-venv/bin/python'
const PROD_STORE = process.env.PROD_STORE || path.join(repoRoot, 'data', 'sseapi-store.json')
const SLUGS = process.argv.slice(2)
const targets = SLUGS.length ? SLUGS : ['gpt-5.5', 'qwen-3.8-flash-fast']

const hashToken = (raw) => createHash('sha256').update(raw).digest('hex')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 从生产 store 只读复制模型行 ----------
if (!fs.existsSync(PROD_STORE)) {
  console.error(`找不到生产 store：${PROD_STORE}（可用 PROD_STORE= 指定）`)
  process.exit(2)
}
const prod = JSON.parse(fs.readFileSync(PROD_STORE, 'utf8'))
const picked = []
for (const slug of targets) {
  const m = prod.models.find((x) => x.slug === slug)
  if (!m) {
    console.error(`生产 store 里没有模型 ${slug}`)
    process.exit(2)
  }
  if (!m.enabled) {
    console.error(`模型 ${slug} 在生产里是 enabled=0，跳过`)
    continue
  }
  picked.push(m)
  console.log(`[seed] ${slug} → ${m.upstream_base_url} (upstream_model=${m.upstream_model}, responses_base_url=${m.responses_base_url || '(空 → 走转换反代)'})`)
}
if (!picked.length) process.exit(2)

// ---------- 临时 store ----------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sseapi-real-'))
const plainKey = 'sk-e2e-real-' + Math.random().toString(36).slice(2, 12)
const models = picked.map((m, i) => ({ ...m, id: i + 1, sort_order: i + 1 }))
const store = {
  seq: { users: 1, api_keys: 1, models: models.length, usage_logs: 0, ledger: 0 },
  users: [{ id: 1, oauth_id: 'e2e', name: 'e2e', email: '', avatar_url: '', is_admin: 1, balance_cents: 100000000, admin_note: '', rpm_limit: 0, max_concurrent: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
  api_keys: [{ id: 1, user_id: 1, name: 'real-verify', key_prefix: plainKey.slice(0, 8), key_hash: hashToken(plainKey), allowed_origins: '', rpm_limit: 0, max_concurrent: 0, last_used_at: null, created_at: new Date().toISOString(), revoked_at: null }],
  models,
  usage_logs: [],
  ledger: [],
  docs: { id: 1, title: 'API 文档', external_url: '', content_md: '', updated_at: '' },
  oauth_states: [],
  rate_limits: { enabled: 1, default_rpm: 999, default_max_concurrent: 999, updated_at: '' },
}
fs.writeFileSync(path.join(dataDir, 'sseapi-store.json'), JSON.stringify(store, null, 2))

// ---------- 起被测服务（就是生产正在跑的那份 dist） ----------
const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: serverDir,
  env: {
    ...process.env,
    PORT: String(PORT),
    DATA_DIR: dataDir,
    JWT_SECRET: 'e2e',
    PLATFORM_ADMIN_OAUTH_IDS: 'e2e',
    // 屏蔽 server/.env 的 MinIO，否则会从桶里读生产 store 覆盖本地 seed
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
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${plainKey}` } })
      if (r.ok) return
    } catch {}
    await wait(250)
  }
  throw new Error('server 未启动: ' + serverLog.slice(-800))
}

// ---------- 真实 Codex CLI ----------
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-real-'))
function writeCodexConfig(model) {
  fs.writeFileSync(
    path.join(codexHome, 'config.toml'),
    `model = "${model}"
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
`,
  )
}

function runCodex(model, prompt, timeoutMs = 240000) {
  writeCodexConfig(model)
  return new Promise((resolve) => {
    const c = spawn(CODEX_BIN, ['exec', '--skip-git-repo-check', '--json', prompt], {
      env: { ...process.env, CODEX_HOME: codexHome, SSEAPI_KEY: plainKey, HOME: codexHome },
      cwd: serverDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    c.stdout.on('data', (d) => (stdout += d))
    c.stderr.on('data', (d) => (stderr += d))
    const timer = setTimeout(() => c.kill('SIGKILL'), timeoutMs)
    c.on('close', (code) => {
      clearTimeout(timer)
      resolve({ status: code, stdout, stderr })
    })
  })
}

function runSdk(model, script) {
  return new Promise((resolve) => {
    const c = spawn(SDK_PY, [script], { env: { ...process.env, BASE, KEY: plainKey, MODEL: model }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    c.stdout.on('data', (d) => (out += d))
    c.stderr.on('data', (d) => (out += d))
    const timer = setTimeout(() => c.kill('SIGKILL'), 240000)
    c.on('close', (code) => {
      clearTimeout(timer)
      resolve({ status: code, out })
    })
  })
}

const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'ok   ' : 'FAIL '} - ${name}`)
  if (!ok && detail) console.log('         ' + detail.replace(/\n/g, '\n         ').slice(0, 1200))
}

// 把 codex 的 JSONL 事件流解析成类型列表
function codexEvents(stdout) {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

await boot()
console.log(`[boot] 被测服务就绪 ${BASE}（临时 DATA_DIR=${dataDir}，MinIO 已禁用）\n`)

for (const model of models) {
  const slug = model.slug
  console.log(`══ ${slug} ══`)

  // 1) 纯文本一轮：Codex 必须看到 agent_message + turn.completed
  const r1 = await runCodex(slug, 'Reply with the single word PONG')
  const ev1 = codexEvents(r1.stdout)
  const types1 = ev1.map((e) => e.type)
  const msg1 = ev1.find((e) => e.type === 'item.completed' && e.item?.type === 'agent_message')
  const usage1 = ev1.find((e) => e.type === 'turn.completed')?.usage
  report(`${slug}: codex 收到 agent_message`, Boolean(msg1?.item?.text), `codex events=${JSON.stringify(types1)}\nstatus=${r1.status}\nstderr=${r1.stderr.slice(-600)}`)
  report(`${slug}: codex 收到 turn.completed 且 usage 非零`, Boolean(usage1 && usage1.input_tokens > 0), `usage=${JSON.stringify(usage1)}`)
  report(`${slug}: codex 进程正常退出`, r1.status === 0, `status=${r1.status} stderr=${r1.stderr.slice(-600)}`)

  // 2) 工具闭环：让 codex 用它内置 shell 工具跑 echo，再回 PONG
  const r2 = await runCodex(
    slug,
    'Use your shell tool to run the command `echo hello-from-tool`, then reply with the single word PONG.',
  )
  const ev2 = codexEvents(r2.stdout)
  const cmdItem = ev2.find((e) => e.type === 'item.completed' && e.item?.type === 'command_execution')
  const msg2 = ev2.find((e) => e.type === 'item.completed' && e.item?.type === 'agent_message')
  if (cmdItem) {
    report(`${slug}: codex 完成一次工具调用（function_call 往返）`, true)
  } else {
    // 真实模型可以自主决定不调用工具，这不是协议问题；工具往返是否合规由下面的 SDK 检查负责
    console.log(`  skip   - ${slug}: codex 这一轮模型没调用工具（events=${JSON.stringify(ev2.map((e) => e.type))}）；工具往返合规性由 SDK 检查覆盖`)
  }
  report(`${slug}: 工具调用轮之后 codex 仍拿到最终回复`, Boolean(msg2?.item?.text), `last agent_message=${msg2?.item?.text ?? '(none)'}\nstatus=${r2.status}\nstderr=${r2.stderr.slice(-600)}`)

  // 3) 官方 OpenAI SDK 符合性（协议形状，不断言内容）
  const sdk = await runSdk(slug, path.join(__dirname, 'responses-sdk-real.py'))
  report(`${slug}: 官方 OpenAI SDK 符合性`, sdk.status === 0, sdk.out)

  console.log('')
}

child.kill('SIGKILL')
fs.rmSync(dataDir, { recursive: true, force: true })
fs.rmSync(codexHome, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log(`==== REAL-UPSTREAM VERIFY: ${results.length - failed.length}/${results.length} ok ====`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log('  - ' + f.name)
  console.log('\n--- 被测服务日志尾部 ---\n' + serverLog.slice(-2500))
  process.exit(1)
}
console.log('==== ALL PASSED ====')
