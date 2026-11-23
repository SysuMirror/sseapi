#!/usr/bin/env node
/**
 * 探一遍生产里各 chat 模型的上游：/v1/chat/completions 与 /v1/responses 是否可用。
 * 只打印状态码与回答前若干字符，绝不打印上游凭据。
 */
import fs from 'node:fs'

const PROD_STORE = process.env.PROD_STORE || '/home/cloud/data/sseapi-store.json'
const store = JSON.parse(fs.readFileSync(PROD_STORE, 'utf8'))
const models = store.models.filter((m) => m.model_type === 'chat' && m.enabled)

const trim = (s) => String(s || '').replace(/\s+/g, ' ').slice(0, 140)

async function probe(url, key, payload) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 25000)
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(payload),
      signal: ac.signal,
    })
    const text = await r.text()
    return { status: r.status, text }
  } catch (e) {
    return { status: 0, text: String(e) }
  } finally {
    clearTimeout(t)
  }
}

for (const m of models) {
  const base = String(m.upstream_base_url || '').replace(/\/$/, '')
  const chat = await probe(`${base}/chat/completions`, m.upstream_api_key, {
    model: m.upstream_model,
    messages: [{ role: 'user', content: 'Reply with the single word PONG' }],
    max_tokens: 16,
    stream: false,
  })
  let chatText = ''
  try {
    chatText = JSON.parse(chat.text)?.choices?.[0]?.message?.content ?? ''
  } catch {
    chatText = chat.text
  }
  const hasOwn = String(m.responses_base_url || '').trim()
  const rbase = hasOwn ? String(m.responses_base_url).replace(/\/$/, '') : base
  const resp = await probe(`${rbase}/responses`, m.upstream_api_key, {
    model: m.upstream_model,
    input: 'Reply with the single word PONG',
  })
  let respText = ''
  try {
    const j = JSON.parse(resp.text)
    respText = j?.output_text ?? (Array.isArray(j?.output) ? trim(JSON.stringify(j.output.map((i) => i.type))) : resp.text)
  } catch {
    respText = resp.text
  }
  console.log(
    `${m.slug.padEnd(24)} chat:${String(chat.status).padEnd(4)} ${trim(chatText).padEnd(30)} | responses:${String(resp.status).padEnd(4)} ${trim(respText)}`,
  )
}
