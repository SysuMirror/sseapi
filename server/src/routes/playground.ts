// 控制台 playground：登录用户（JWT）直接对话，不走 sk- key。
//
// 与 /v1/chat/completions 的区别：
//   - 鉴权用 authJwt（浏览器里的登录态），不用 authApiKey；
//   - 上游非 2xx 时**不伪装成 SSE**，原样把 JSON 错误透传（参照实现里的
//     `isStream = wantStream || …` 会把这个错误糊成流）;
//   - 客户端点「停止」时中断上游并照常结算已产出的部分。
import { Router, type Response } from 'express'
import { authJwt, type AuthedRequest } from '../middleware/auth.js'
import {
  appendUsage,
  contextLimitError,
  contextLimitErrorBody,
  estimateInputTokens,
  resolveModelForProxy,
  settleBilling,
  upstreamAuthHeader,
  upstreamSessionHeaders,
} from '../services/proxy-common.js'
import { trackEndpoint } from '../services/rate-limits.js'
import { estimateTokens, extractStreamCompletionText, extractUsageFromSse } from '../services/sse-usage.js'

export const playgroundRouter = Router()

type ChatMsg = { role: string; content: unknown }

const ALLOWED_ROLES = ['system', 'user', 'assistant']

/** 只保留合法的 role，顺手滤掉前端可能塞进来的脏数据（tool_calls/images 暂不支持） */
function normalizeMessages(raw: unknown): ChatMsg[] {
  if (!Array.isArray(raw)) return []
  const out: ChatMsg[] = []
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue
    const role = String((m as { role?: unknown }).role || '')
    if (!ALLOWED_ROLES.includes(role)) continue
    out.push({ role, content: (m as { content?: unknown }).content ?? '' })
  }
  return out
}

playgroundRouter.post('/chat', authJwt, async (req: AuthedRequest, res: Response) => {
  const body = (req.body || {}) as Record<string, unknown>
  const modelSlug = String(body.model || '')
  const system = String(body.system || '').trim()
  const history = normalizeMessages(body.messages)
  const messages: ChatMsg[] = system ? [{ role: 'system', content: system }, ...history] : history

  if (!messages.length) {
    res.status(400).json({ error: { message: 'messages 不能为空', type: 'invalid_request_error' } })
    return
  }

  // 限流 / 启用 / 上游配置 / 类型 / dev_only / origin 白名单 / 余额，一次做完；
  // 失败时它自己写响应 —— 所以在此之前绝不能 flushHeaders()。
  const model = await resolveModelForProxy(req, res, modelSlug, 'chat')
  if (!model) return
  trackEndpoint('playground/chat', req, res, modelSlug)

  // 上下文长度预检：llama3.1-8b 只有 6144，长对话要给出可读的 400 而不是上游报错
  const inputTokens = estimateInputTokens(messages)
  const ctxErr = contextLimitError(model, inputTokens)
  if (ctxErr) {
    await appendUsage(req, modelSlug, 0, 0, 0, 0, 0, 'context_exceeded', ctxErr)
    res.status(400).json(contextLimitErrorBody(ctxErr, inputTokens - model.context_length))
    return
  }

  const payload: Record<string, unknown> = {
    model: model.upstream_model || model.slug,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }
  if (body.temperature !== undefined && body.temperature !== null && body.temperature !== '') {
    payload.temperature = body.temperature
  }
  if (body.max_tokens !== undefined && body.max_tokens !== null && body.max_tokens !== '') {
    payload.max_tokens = body.max_tokens
  }

  const url = `${String(model.upstream_base_url).replace(/\/$/, '')}/chat/completions`
  const ac = new AbortController()
  // 客户端断开（点停止 / 关页面）→ 连带掐掉上游，别让它继续烧 token
  res.on('close', () => {
    if (!res.writableEnded) ac.abort()
  })

  let upstreamRes: globalThis.Response
  try {
    upstreamRes = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Content-Type': 'application/json',
        ...upstreamAuthHeader(model),
        ...upstreamSessionHeaders(req),
      },
      body: JSON.stringify(payload),
    })
  } catch (e) {
    if (!ac.signal.aborted) {
      await appendUsage(req, modelSlug, 0, 0, 0, 0, 0, 'error', String(e).slice(0, 500))
      console.warn('[playground] upstream fetch failed', e)
    }
    if (!res.headersSent) {
      res.status(502).json({ error: { message: '上游连接失败', type: 'upstream_error' } })
    }
    return
  }

  // 上游非 2xx：原样透传 JSON，别糊成 SSE
  if (!upstreamRes.ok) {
    const text = await upstreamRes.text().catch(() => '')
    await appendUsage(req, modelSlug, 0, 0, 0, 0, 0, 'error', text.slice(0, 500))
    if (!res.headersSent) {
      res.status(upstreamRes.status)
      res.setHeader('Content-Type', upstreamRes.headers.get('content-type') || 'application/json')
      const ra = upstreamRes.headers.get('retry-after')
      if (ra) res.setHeader('Retry-After', ra)
      res.send(text || '{}')
    }
    return
  }

  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  // 经 frp/nginx 中继时禁止代理侧缓冲，否则整条流会被攒到最后一起吐
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()
  res.socket?.setNoDelay(true)

  // 心跳：模型「想」很久时，防止中继的 proxy_read_timeout（60s）掐断连接
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n')
  }, 15000)

  const reader = upstreamRes.body?.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let aborted = false
  try {
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        if (res.writableEnded || res.destroyed) {
          aborted = true
          ac.abort()
          break
        }
        res.write(value)
      }
    }
  } catch (e) {
    aborted = true
    if (!ac.signal.aborted) console.warn('[playground] stream error', e)
  } finally {
    clearInterval(heartbeat)
    try {
      if (!res.writableEnded) res.end()
    } catch {
      /* 对端已断开 */
    }
  }

  let usage = extractUsageFromSse(buf)
  if (!usage.found) {
    usage = { ...estimateTokens(messages, extractStreamCompletionText(buf)), found: false }
  }
  const note = [usage.found ? '' : 'usage_estimated', aborted ? 'client_aborted' : ''].filter(Boolean).join(';')
  try {
    await settleBilling(
      req,
      model,
      modelSlug,
      usage.prompt,
      usage.completion,
      usage.cached,
      usage.imageTokens,
      0,
      aborted ? 'error' : 'ok',
      note,
    )
  } catch (e) {
    console.warn('[playground] settleBilling failed', e)
  }
})
