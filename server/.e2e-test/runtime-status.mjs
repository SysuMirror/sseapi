// Isolated runtime observation regression tests
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'

const PORT = 18142
const BASE = `http://127.0.0.1:${PORT}`
const JWT_SECRET = 'e2e-secret'
const ADMIN_OAUTH = '327'
const serverDir = path.resolve(import.meta.dirname, '..')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const hashToken = (raw) => createHash('sha256').update(raw).digest('hex')
const b64url = (s) => Buffer.from(JSON.stringify(s)).toString('base64url')
function makeJwt(userId) {
  const header = { alg: 'HS256', typ: 'JWT' }
  const now = Math.floor(Date.now() / 1000)
  const payload = { sub: userId, oauthId: ADMIN_OAUTH, isAdmin: 1, iat: now, exp: now + 3600 }
  const si = `${b64url(header)}.${b64url(payload)}`
  return `${si}.${createHmac('sha256', JWT_SECRET).update(si).digest('base64url')}`
}
const keyPlain = 'sk-e2e-' + Math.random().toString(36).slice(2, 12)

let failed = false
function assert(cond, msg) {
  if (!cond) { failed = true; console.log('FAIL:', msg) } else { console.log('  ok -', msg) }
}

// Hold upstream responses until observations have been asserted.
let hold = false
const pending = []
const deliver = fn => hold ? pending.push(fn) : fn()
function releaseMock() { hold = false; for (const fn of pending.splice(0)) fn() }
async function waitPending(n) {
  for (let i=0; i<100; i++) { if (pending.length === n) return; await wait(20) }
  throw new Error(`expected ${n} pending upstream responses, got ${pending.length}`)
}
const mock = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {}
    if (body.messages?.some(m => m.content === 'disconnect')) { res.destroy(); return }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({id:'x', choices:[{index:0,delta:{content:'hi'}}]}) + '\n\n');
      deliver(() => res.end('data: [DONE]\n\n')); return
    }
    deliver(() => {
      if (req.url === '/v1/models') { res.setHeader('content-type','application/json'); res.end(JSON.stringify({object:'list', data:[]})); return }
      if (req.url === '/v1/embeddings') { res.setHeader('content-type','application/json'); res.end(JSON.stringify({object:'list',data:[{object:'embedding',index:0,embedding:[0.1]}],usage:{prompt_tokens:1,total_tokens:1}})); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'cmpl_x', object: 'chat.completion', model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }))
    })
  })
})

const modelRow = (slug, rpm, conc) => ({
  id: 1, slug, display_name: slug, badge: '', card_color: '#111', model_type: 'chat',
  upstream_api_format: 'openai', upstream_path_override: '', upstream_base_url: `http://127.0.0.1:${PORT + 1}/v1`,
  upstream_model: slug, upstream_api_key: '', allowed_origins: '', rpm_limit: rpm, max_concurrent: conc,
  input_price_per_1m: 1, output_price_per_1m: 1, cache_price_per_1m: 0, multimodal_enabled: 0,
  image_billing_mode: 'token', image_price_per_1m: 0, image_price_per_image: 0, image_tokens_per_image: 512,
  thinking_enabled: 0, thinking_levels: '["off"]', default_thinking: 'off', claude_compat: 0,
  anthropic_base_url: '', anthropic_enabled: 1, responses_base_url: '', responses_enabled: 1,
  enabled: 1, sort_order: 1,
})

const store = {
  seq: { users: 1, api_keys: 1, models: 3, usage_logs: 0, ledger: 0 },
  users: [{ id: 1, oauth_id: ADMIN_OAUTH, name: 'e2e', email: '', avatar_url: '', is_admin: 1, balance_cents: 100000, admin_note: '', rpm_limit: 0, max_concurrent: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
  api_keys: [{ id: 1, user_id: 1, name: 'e2e', key_prefix: keyPlain.slice(0, 8), key_hash: hashToken(keyPlain), allowed_origins: '', rpm_limit: 0, max_concurrent: 0, last_used_at: null, created_at: new Date().toISOString(), revoked_at: null }],
  models: [
    modelRow('conc-slow', 0, 6), // Model-only concurrency limit.
    modelRow('rpm-fast', 0, 0), // All limits zero.
    {...modelRow('embedding',0,0), id:3, model_type:'embedding'},
  ],
  usage_logs: [], ledger: [],
  docs: { id: 1, title: 'API 文档', external_url: '', content_md: '', updated_at: new Date().toISOString() },
  oauth_states: [],
  // 关闭默认限流（用模型自身的 limit 验证），避免默认值干扰
  rate_limits: { enabled: 1, default_rpm: 0, default_max_concurrent: 0, updated_at: new Date().toISOString() },
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sseapi-rl-'))
store.users.push({ ...store.users[0], id: 2, oauth_id: '328', name: 'second' })
store.api_keys.push({ ...store.api_keys[0], id: 2, user_id: 2, key_hash: hashToken('sk-second') })
store.api_keys.push({ ...store.api_keys[0], id: 3, key_hash: hashToken('sk-third') })
fs.writeFileSync(path.join(dataDir, 'sseapi-store.json'), JSON.stringify(store, null, 2))

const child = spawn(process.execPath, [path.join(process.env.SSEAPI_TEST_BUILD_DIR || path.join(serverDir, 'dist'), 'index.js')], {
  cwd: dataDir,
  env: { PATH: process.env.PATH, PORT: String(PORT), DATA_DIR: dataDir, JWT_SECRET, SSEAPI_API_PUBLIC_URL: BASE, PLATFORM_ADMIN_OAUTH_IDS: ADMIN_OAUTH },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let outLog = ''
child.stdout.on('data', (d) => (outLog += d))
child.stderr.on('data', (d) => (outLog += d))

async function boot() {
  for (let i = 0; i < 40; i++) { try { const r = await fetch(`${BASE}/api/health`, { headers: { authorization: `Bearer ${keyPlain}` } }); if (r.ok) return } catch {} await wait(200) }
  throw new Error('server 未启动: ' + outLog.slice(-500))
}
const H = { authorization: `Bearer ${keyPlain}` }
async function chat(model, opts = {}) {
  const r = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], ...opts }) })
  return r
}

const adminHeaders = { authorization: `Bearer ${makeJwt(1)}`, 'content-type': 'application/json' }
async function status() {
  const r = await fetch(`${BASE}/api/admin/rate-limits/status`, { headers: adminHeaders })
  if (!r.ok) throw new Error(`status ${r.status}: ${await r.text()}`)
  assert(r.headers.get('cache-control') === 'no-store', 'status no-store')
  return (await r.json()).data
}
async function poll(n) {
  for (let i = 0; i < 60; i++) { const s = await status(); if (s.global.current === n) return s; await wait(30) }
  throw new Error('status did not reach ' + n)
}
function check(s, n) {
  assert(s.scope === 'process' && Number.isFinite(Date.parse(s.sampledAt)), 'sample metadata')
  assert(s.global.limit === 0, 'global has no hard limit')
  for (const dim of ['endpoints', 'models', 'users', 'keys']) assert(s[dim].reduce((a, x) => a + x.current, 0) === n, `${dim} sum=${n}`)
}
async function configure(enabled) {
  const r = await fetch(`${BASE}/api/admin/rate-limits`, { method: 'PUT', headers: adminHeaders, body: JSON.stringify({enabled,defaultRpm:0,defaultMaxConcurrent:0}) })
  if (!r.ok) throw new Error(await r.text())
}
async function batch(model, enabled) {
  await configure(enabled)
  hold = true
  const jobs = Array.from({length:6}, (_,i) => fetch(`${BASE}/v1/${i === 5 ? 'chat/completions' : 'messages'}`, {
    method:'POST', headers:{'content-type':'application/json',authorization:`Bearer ${i < 3 ? keyPlain : i < 5 ? 'sk-second' : 'sk-third'}`},
    body:JSON.stringify({model,max_tokens:5,messages:[{role:'user',content:'hi'}]})
  }).then(async r => { await r.text(); return r.status }))
  await waitPending(6)
  const s = await poll(6); check(s,6)
  assert(s.endpoints.find(x => x.name === 'messages')?.current === 5, 'five messages')
  assert(s.endpoints.find(x => x.name === 'chat/completions')?.current === 1, 'one chat')
  assert(s.users.find(x => x.id === '1')?.current === 4 && s.users.find(x => x.id === '2')?.current === 2, 'multiple users')
  assert(s.keys.find(x => x.id === '1')?.current === 3 && s.keys.find(x => x.id === '2')?.current === 2 && s.keys.find(x => x.id === '3')?.current === 1, 'multiple keys')
  if (enabled && model === 'conc-slow') { assert((await chat(model)).status === 429, 'rejection is not observed'); check(await status(),6) }
  releaseMock()
  assert((await Promise.all(jobs)).every(x => x === 200), 'all six complete')
  check(await poll(0),0)
}
function lifecycle() {
  const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sseapi-lifecycle-'))
  fs.writeFileSync(path.join(unitDir,'sseapi-store.json'),JSON.stringify(store))
  const build = process.env.SSEAPI_TEST_BUILD_DIR || path.join(serverDir,'dist')
  const script = `
    import { EventEmitter } from 'node:events';
    import assert from 'node:assert/strict';
    import { pathToFileURL } from 'node:url';
    const build = process.env.TEST_BUILD;
    const { initDb } = await import(pathToFileURL(build + '/db.js'));
    await initDb();
    const {trackEndpoint,getRuntimeStatus} = await import(pathToFileURL(build + '/services/rate-limits.js'));
    const req = {user:{id:1},apiKeyId:1};
    const res = new EventEmitter();
    const release = trackEndpoint('messages',req,res,'conc-slow');
    assert.equal(getRuntimeStatus().global.current,1);
    res.emit('finish');res.emit('close');release();
    assert.equal(getRuntimeStatus().global.current,0);
    assert.equal(res.eventNames().length,0);
    for (const state of ['destroyed','writableEnded']) {
      const closed = Object.assign(new EventEmitter(),{[state]:true});
      trackEndpoint('messages',req,closed,'conc-slow')();
      assert.equal(closed.eventNames().length,0);
      assert.equal(getRuntimeStatus().global.current,0);
    }
    trackEndpoint('messages',{...req,aborted:true},new EventEmitter(),'conc-slow')();
    assert.equal(getRuntimeStatus().global.current,0);
    console.log('LIFECYCLE PRE-CLOSED AND IDEMPOTENT RELEASE PASSED');
  `
  try {
    const result = spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:unitDir,env:{PATH:process.env.PATH,DATA_DIR:unitDir,TEST_BUILD:build},encoding:'utf8',timeout:10000})
    if(result.status !== 0) throw new Error(result.stderr || String(result.error))
    console.log(result.stdout.trim())
  } finally { fs.rmSync(unitDir,{recursive:true,force:true}) }
}
async function main() {
  lifecycle()
  await new Promise(r => mock.listen(PORT + 1,'127.0.0.1',r)); await boot()
  await batch('conc-slow',false)
  await batch('rpm-fast',false)
  // Enabled all-zero settings remain unlimited.
  await batch('rpm-fast',true)
  await batch('conc-slow',true)
  await configure(false)
  hold = true
  const stream = chat('conc-slow',{stream:true}); await poll(1)
  const sr = await stream; assert(sr.status === 200,'stream begins'); check(await status(),1)
  await waitPending(1); releaseMock()
  await sr.text(); check(await poll(0),0)
  hold = true
  const controller = new AbortController()
  const aborted = fetch(`${BASE}/v1/chat/completions`,{method:'POST',headers:{...H,'content-type':'application/json'},signal:controller.signal,body:JSON.stringify({model:'conc-slow',messages:[{role:'user',content:'hi'}]})}).catch(e => e)
  await waitPending(1); await poll(1); controller.abort(); await aborted; check(await poll(0),0)
  releaseMock()
  assert((await chat('conc-slow',{messages:[{role:'user',content:'disconnect'}]})).status === 502,'upstream exception completes')
  check(await poll(0),0)
  for (const [endpoint, body] of [
    ['responses',{model:'rpm-fast',input:'hi'}],
    ['embeddings',{model:'embedding',input:'hi'}],
    ['models',null],
  ]) {
    hold = true
    const job = fetch(`${BASE}/v1/${endpoint}`, {method:body?'POST':'GET',headers:{...H,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}).then(async r => {await r.text();return r.status})
    await waitPending(1)
    const snapshot = await poll(1)
    assert(snapshot.endpoints.find(x => x.name===endpoint)?.current === 1, `${endpoint} observed`)
    if (body) check(snapshot,1)
    else {
      assert(snapshot.withoutModel === 1, 'model listing has withoutModel=1')
      assert(snapshot.models.every(x => x.current === 0), 'model listing not attributed to model')
      assert(snapshot.users.find(x => x.id === '1')?.current === 1 && snapshot.keys.find(x => x.id === '1')?.current === 1,'model listing user/key observed')
    }
    releaseMock(); assert(await job === 200, `${endpoint} completes`); check(await poll(0),0)
  }
  console.log(failed ? 'RUNTIME STATUS TESTS FAILED' : 'RUNTIME STATUS TESTS PASSED')
}
main().catch(e => {failed=true; console.error(e)}).finally(async () => {
  child.kill('SIGTERM'); await new Promise(r => child.once('exit',r)); mock.closeAllConnections(); mock.close()
  fs.rmSync(dataDir,{recursive:true,force:true}); process.exitCode = failed ? 1 : 0
})
