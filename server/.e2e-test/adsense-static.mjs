import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import ts from 'typescript'

// Execute the actual static-serving section without importing database startup.
const source = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const section = source.slice(source.indexOf('const dist = config.frontendDist'), source.indexOf('app.use((err:'))
assert.ok(section.includes('const sendIndex'))
const mount = new Function('app', 'express', 'fs', 'path', 'config', 'process', 'console', ts.transpile(section, { target: ts.ScriptTarget.ES2022 }))
const loader = 'pagead2.googlesyndication.com/pagead/js/adsbygoogle.js'
const html = '<!doctype html><html><head><title>Test</title></head><body>app</body></html>'

async function fixture(client, markup, run) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'adsense-static-'))
  const warnings = []
  if (markup !== null) fs.writeFileSync(path.join(dist, 'index.html'), markup)
  fs.mkdirSync(path.join(dist, 'assets'))
  fs.writeFileSync(path.join(dist, 'assets/app.js'), 'window.asset=true;')
  const app = express()
  app.get('/api/health', (_req, res) => res.json({ ok: true }))
  mount(app, express, fs, path, { frontendDist: dist }, { env: { ADSENSE_CLIENT: client } }, { warn: s => warnings.push(s) })
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const get = route => fetch(`http://127.0.0.1:${server.address().port}${route}`)
  try { await run(get, warnings, dist) } finally {
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(dist, { recursive: true, force: true })
  }
}

for (const [name, client, enabled] of [
  ['valid', 'ca-pub-1234567890123456', true],
  ['trimmed', ' ca-pub-1234567890123456 ', true],
  ['missing', undefined, false],
  ['empty', '', false],
  ['invalid length', 'ca-pub-123', false],
  ['injection rejected', 'ca-pub-1234567890123456\" onload=\"alert(1)', false],
]) {
  test(name + ' client across SPA routes', () => fixture(client, html, async (get, warnings, dist) => {
    for (const route of ['/', '/index.html', '/login', '/docs']) {
      const res = await get(route)
      assert.equal(res.status, 200)
      assert.match(res.headers.get('content-type'), /text\/html/)
      const body = await res.text()
      assert.equal(body.split(loader).length - 1, enabled ? 1 : 0)
      if (enabled) {
        assert.ok(body.indexOf(loader) < body.indexOf('</head>'))
        assert.match(body, /<script async src="https:.*" crossorigin="anonymous"><\/script>/)
      } else assert.equal(body, html)
    }
    assert.equal(fs.readFileSync(path.join(dist, 'index.html'), 'utf8'), html)
    assert.equal(warnings.length, client && !enabled ? 1 : 0)
  }))
}
test('static asset and API behavior preserved', () => fixture('ca-pub-1234567890123456', html, async get => {
  assert.equal(await (await get('/assets/app.js')).text(), 'window.asset=true;')
  assert.deepEqual(await (await get('/api/health')).json(), { ok: true })
  for (const route of ['/api/missing', '/v1/missing']) {
    const res = await get(route)
    assert.equal(res.status, 404)
    assert.ok(!(await res.text()).includes(loader))
  }
}))
test('existing loader remains single', () => fixture('ca-pub-1234567890123456', html.replace('</head>', `<script async src="https://${loader}?client=ca-pub-1234567890123456" crossorigin="anonymous"></script></head>`), async get => {
  assert.equal((await (await get('/')).text()).split(loader).length - 1, 1)
}))
test('missing closing head warns without injecting', () => fixture('ca-pub-1234567890123456', '<html><body>app</body></html>', async (get, warnings) => {
  assert.equal((await (await get('/')).text()).includes(loader), false)
  assert.equal(warnings.length, 1)
}))
test('missing index falls through and assets remain available', () => fixture('ca-pub-1234567890123456', null, async get => {
  assert.equal((await get('/')).status, 404)
  assert.equal((await get('/login')).status, 404)
  assert.equal(await (await get('/assets/app.js')).text(), 'window.asset=true;')
}))
