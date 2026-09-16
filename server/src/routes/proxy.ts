import { Router } from 'express'
import { db } from '../db.js'
import { authApiKey, type AuthedRequest } from '../middleware/auth.js'
import { checkAllowedOrigins } from '../services/origins.js'
import { enforceRateLimits, trackEndpoint } from '../services/rate-limits.js'
import { countImagesInMessages, redactImagesForEstimate } from '../services/multimodal.js'
import { mergeModelV1WithUpstream, modelTypeOf, modelV1Path } from '../services/model-catalog.js'
import {
  prefetchUpstreamLists,
  resolveUpstreamModelEntry,
} from '../services/upstream-models.js'
import {
  appendUsage,
  countGeneratedImages,
  enforceAccess,
  forwardJsonProxy,
  readUsage,
  resolveModelForProxy,
  settleBilling,
  estimateInputTokens,
  contextLimitError,
  contextLimitErrorBody,
  anthropicAuthHeader,
  upstreamAuthHeader,
  upstreamBaseFor,
  upstreamSessionHeaders,
  anthropicMessagesUrl,
  responsesUrl,
} from '../services/proxy-common.js'
import {
  buildEmbeddingUpstreamRequest,
  normalizeEmbeddingToOpenAi,
  openAiInputToStrings,
} from '../services/embedding-adapter.js'
import {
  buildRerankUpstreamRequest,
  normalizeRerankToOpenAi,
  toDocumentStrings,
} from '../services/rerank-adapter.js'
import {
  claudeRequestToOpenAi,
  openAiResponseToClaude,
  openAiStreamChunkToClaude,
  countClaudeImages,
  estimateClaudeTokens,
  claudeStreamStartEvents,
  ClaudeContentStream,
  ClaudePassthroughSse,
  upstreamErrorToClaude,
  rememberReasoning,
  applyReasoningToChatMessages,
  rememberOpenAiResponseReasoning,
  extractOpenAiResponseReasoning,
  extractStreamReasoning,
} from '../services/claude-adapter.js'
import {
  responsesRequestToOpenAi,
  openAiResponseToResponses,
  openAiStreamChunkToResponses,
} from '../services/responses-adapter.js'
import { mayAccessDevOnly } from '../services/dev-platform.js'
import { anthropicHasOwnUpstream, responsesHasOwnUpstream } from '../services/model-catalog.js'

export const proxyRouter = Router()

function extractUsageFromSse(buf: string): {
  prompt: number
  completion: number
  cached: number
  imageTokens: number
  found: boolean
} {
  let last = { prompt: 0, completion: 0, cached: 0, imageTokens: 0, found: false }
  for (const line of buf.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    const data = t.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try {
      const j = JSON.parse(data)
      const u = readUsage(j?.usage)
      if (u.found) last = u
    } catch {
      /* 忽略半包 */
    }
  }
  return last
}

function estimateTokens(messages: unknown, completionText: string) {
  const msgLen = JSON.stringify(redactImagesForEstimate(messages) ?? '').length
  return {
    prompt: Math.max(1, Math.ceil(msgLen / 4)),
    completion: Math.max(0, Math.ceil((completionText || '').length / 4)),
    cached: 0,
    imageTokens: 0,
  }
}

function extractStreamCompletionText(buf: string): string {
  let out = ''
  for (const line of buf.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    const data = t.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try {
      const j = JSON.parse(data)
      const delta = j?.choices?.[0]?.delta?.content
      if (typeof delta === 'string') out += delta
      const msg = j?.choices?.[0]?.message?.content
      if (typeof msg === 'string' && !delta) out += msg
    } catch {
      /* ignore */
    }
  }
  return out
}

/** 解析 SSE 文本为 JSON chunk 数组（跳过空行/[DONE]/非法行） */
function parseSseDataChunks(buf: string): unknown[] {
  const chunks: unknown[] = []
  for (const line of buf.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    const data = t.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try {
      chunks.push(JSON.parse(data))
    } catch {
      /* ignore */
    }
  }
  return chunks
}

/** 从 Chat Completions JSON 响应取首条 message.content 文本（含数组合并） */
function chatCompletionTextOf(json: unknown): string {
  const j = json as { choices?: Array<{ message?: { content?: unknown } }> } | null
  const content = j?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((c) => String((c as { text?: unknown })?.text ?? '')).join('')
  }
  return ''
}

function estimateEmbeddingTokens(input: unknown): number {
  const s = JSON.stringify(input ?? '')
  return Math.max(1, Math.ceil(s.length / 4))
}

proxyRouter.get('/models', authApiKey, async (req: AuthedRequest, res) => {
  if (!enforceRateLimits(req, res)) return
  trackEndpoint('models', req, res)
  const canDev = await mayAccessDevOnly(req)
  const rows = db
    .getStore()
    .models.filter((m) => m.enabled && m.upstream_base_url && (!m.dev_only || canDev))
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)

  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
  const referer = typeof req.headers.referer === 'string' ? req.headers.referer : undefined
  const keyRow = db.getStore().api_keys.find((k) => k.id === req.apiKeyId)

  const filtered = rows.filter((m) => {
    if (checkAllowedOrigins(m.allowed_origins, origin, referer).ok === false) return false
    if (
      keyRow?.allowed_origins &&
      checkAllowedOrigins(keyRow.allowed_origins, origin, referer).ok === false
    ) {
      return false
    }
    return true
  })

  await prefetchUpstreamLists(filtered)
  const data = await Promise.all(
    filtered.map(async (m) => {
      const upstream = await resolveUpstreamModelEntry(m)
      return mergeModelV1WithUpstream(m, upstream)
    }),
  )
  res.json({ object: 'list', data })
})

proxyRouter.get('/models/:modelId', authApiKey, async (req: AuthedRequest, res) => {
  if (!enforceRateLimits(req, res)) return
  const modelSlug = String(req.params.modelId || '').trim()
  if (!modelSlug) {
    res.status(400).json({ error: { message: 'model id 必填', type: 'invalid_request_error' } })
    return
  }
  const model = db.getStore().models.find((m) => m.slug === modelSlug && m.enabled)
  if (!model || !model.upstream_base_url) {
    res.status(404).json({ error: { message: `模型 ${modelSlug} 不存在或未启用`, type: 'not_found' } })
    return
  }
  // 仅开发者模型：非开发者不可见/不可取详情
  if (model.dev_only && !(await mayAccessDevOnly(req))) {
    res.status(404).json({ error: { message: `模型 ${modelSlug} 不存在或未启用`, type: 'not_found' } })
    return
  }

  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
  const referer = typeof req.headers.referer === 'string' ? req.headers.referer : undefined
  const keyRow = db.getStore().api_keys.find((k) => k.id === req.apiKeyId)

  if (checkAllowedOrigins(model.allowed_origins, origin, referer).ok === false) {
    res.status(403).json({ error: { message: '域名不在允许列表', type: 'origin_forbidden' } })
    return
  }
  if (
    keyRow?.allowed_origins &&
    checkAllowedOrigins(keyRow.allowed_origins, origin, referer).ok === false
  ) {
    res.status(403).json({ error: { message: 'API Key 域名限制', type: 'origin_forbidden' } })
    return
  }

  trackEndpoint('models', req, res, modelSlug)
  const upstream = await resolveUpstreamModelEntry(model)
  res.json(mergeModelV1WithUpstream(model, upstream))
})

proxyRouter.post('/chat/completions', authApiKey, async (req: AuthedRequest, res) => {
  const body = req.body || {}
  const modelSlug = String(body.model || '')
  if (!modelSlug) {
    res.status(400).json({ error: { message: 'model 必填', type: 'invalid_request_error' } })
    return
  }

  if (!enforceRateLimits(req, res, modelSlug)) return

  const model = db.getStore().models.find((m) => m.slug === modelSlug && m.enabled)
  if (!model) {
    res.status(404).json({ error: { message: `模型 ${modelSlug} 不存在或未启用`, type: 'not_found' } })
    return
  }

  const type = modelTypeOf(model)
  if (type !== 'chat') {
    res.status(400).json({
      error: {
        message: `模型 ${modelSlug} 类型为 ${type}，请使用 ${modelV1Path(type)}`,
        type: 'wrong_endpoint',
        model_type: type,
        correct_endpoint: modelV1Path(type),
      },
    })
    return
  }

  // 仅开发者模型：非开发者一律拒绝调用
  if (model.dev_only && !(await mayAccessDevOnly(req))) {
    res.status(403).json({
      error: {
        message: `模型 ${modelSlug} 仅对集市开发者开放，你无权调用`,
        type: 'dev_only_forbidden',
      },
    })
    return
  }

  if (!model.upstream_base_url) {
    res.status(503).json({
      error: { message: '模型上游未配置，请联系管理员', type: 'upstream_not_configured' },
    })
    return
  }

  const imageCount = countImagesInMessages(body.messages)
  if (imageCount > 0 && !model.multimodal_enabled) {
    res.status(400).json({
      error: {
        message: '该模型未开启多模态，请去掉 image_url 或联系管理员启用',
        type: 'multimodal_not_enabled',
      },
    })
    return
  }

  // 上下文长度检测：模型配置了 context_length 且本次输入超限则拒绝
  if (model.context_length && model.context_length > 0) {
    const inputTokens = estimateInputTokens(body.messages)
    const ctxErr = contextLimitError(model, inputTokens)
    if (ctxErr) {
      await appendUsage(req, modelSlug, 0, 0, 0, 0, imageCount, 'context_exceeded', ctxErr)
      res.status(400).json(contextLimitErrorBody(ctxErr, inputTokens - model.context_length))
      return
    }
  }

  const denied = enforceAccess(req, model)
  if (denied) {
    await appendUsage(req, modelSlug, 0, 0, 0, 0, imageCount, 'forbidden', denied)
    res.status(403).json({ error: { message: denied, type: 'origin_forbidden' } })
    return
  }

  const fresh = db.getStore().users.find((u) => u.id === req.user!.id)
  if (!fresh || fresh.balance_cents <= 0) {
    res.status(402).json({
      error: { message: '余额不足，请联系管理员充值', type: 'insufficient_quota' },
    })
    return
  }
  req.user = fresh
  trackEndpoint('chat/completions', req, res, modelSlug)

  const upstreamModel = model.upstream_model || model.slug
  const base = String(model.upstream_base_url).replace(/\/$/, '')
  const url = `${base}/chat/completions`
  const payload: Record<string, unknown> = { ...body, model: upstreamModel }
  delete payload.api_key

  // 请求侧补挂：检测 assistant 消息是否已带 reasoning_content；缺则查缓存补挂（DeepSeek 思考模式强校验）
  applyReasoningToChatMessages(payload.messages, upstreamModel)

  const wantStream = Boolean(body.stream)
  if (wantStream) {
    const prev =
      payload.stream_options && typeof payload.stream_options === 'object'
        ? (payload.stream_options as Record<string, unknown>)
        : {}
    payload.stream_options = { ...prev, include_usage: true }
  }

  let upstreamRes: globalThis.Response
  try {
    upstreamRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...upstreamAuthHeader(model), ...upstreamSessionHeaders(req) },
      body: JSON.stringify(payload),
    })
  } catch (e) {
    await appendUsage(req, modelSlug, 0, 0, 0, 0, imageCount, 'error', String(e))
    res.status(502).json({
      error: { message: '上游连接失败（请检查 vLLM 地址）', type: 'upstream_error' },
    })
    return
  }

  const contentType = upstreamRes.headers.get('content-type') || ''
  const isStream = wantStream || contentType.includes('text/event-stream')

  if (isStream) {
    res.status(upstreamRes.status)
    res.setHeader('Content-Type', contentType || 'text/event-stream')
    const reader = upstreamRes.body?.getReader()
    if (!reader) {
      res.end()
      return
    }
    const decoder = new TextDecoder()
    let buf = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        res.write(value)
      }
    } finally {
      res.end()
    }
    let usage = extractUsageFromSse(buf)
    if (!usage.found) {
      const est = estimateTokens(body.messages, extractStreamCompletionText(buf))
      usage = { ...est, found: false }
    }
    // 响应侧记忆：流式累计中提取 assistant 的 reasoning_content + tool_calls，供下一轮补挂
    if (upstreamRes.ok) {
      const chunks = parseSseDataChunks(buf)
      const rs = extractStreamReasoning(chunks)
      rememberOpenAiResponseReasoning(upstreamModel, rs.content, rs.toolCallIds, rs.reasoning)
    }
    try {
      await settleBilling(
        req,
        model,
        modelSlug,
        usage.prompt,
        usage.completion,
        usage.cached,
        usage.imageTokens,
        imageCount,
        upstreamRes.ok ? 'ok' : 'error',
        usage.found ? '' : 'usage_estimated',
      )
    } catch {
      /* 流已结束 */
    }
    return
  }

  const text = await upstreamRes.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }

  let usage = readUsage((json as { usage?: unknown })?.usage)
  if (!usage.found && upstreamRes.ok) {
    const content = String((json as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content ?? '')
    const est = estimateTokens(body.messages, content)
    usage = { ...est, found: false }
  }

  // 响应侧记忆：非流式响应中提取 assistant 的 reasoning_content + tool_calls，供下一轮补挂
  if (upstreamRes.ok) {
    const rs = extractOpenAiResponseReasoning(json)
    rememberOpenAiResponseReasoning(upstreamModel, rs.content, rs.toolCallIds, rs.reasoning)
  }

  if (upstreamRes.ok) {
    try {
      await settleBilling(
        req,
        model,
        modelSlug,
        usage.prompt,
        usage.completion,
        usage.cached,
        usage.imageTokens,
        imageCount,
        'ok',
        usage.found ? '' : 'usage_estimated',
      )
    } catch (e) {
      res.status(402).json({
        error: { message: e instanceof Error ? e.message : '扣费失败', type: 'billing_error' },
      })
      return
    }
  } else {
    await appendUsage(
      req,
      modelSlug,
      usage.prompt,
      usage.completion,
      usage.cached,
      0,
      imageCount,
      'error',
      text.slice(0, 500),
    )
  }

  res.status(upstreamRes.status)
  res.setHeader('Content-Type', contentType || 'application/json')
  res.send(text)
})

proxyRouter.post('/embeddings', authApiKey, async (req: AuthedRequest, res) => {
  const body = (req.body || {}) as Record<string, unknown>
  const modelSlug = String(body.model || '')
  const model = await resolveModelForProxy(req, res, modelSlug, 'embedding')
  if (!model) return
  trackEndpoint('embeddings', req, res, modelSlug)

  let urlPath: string
  let payload: Record<string, unknown>
  try {
    const built = buildEmbeddingUpstreamRequest(model, body)
    urlPath = built.urlPath
    payload = built.payload
  } catch (e) {
    res.status(400).json({
      error: { message: e instanceof Error ? e.message : '请求无效', type: 'invalid_request_error' },
    })
    return
  }

  const base = String(model.upstream_base_url).replace(/\/$/, '')
  const url = `${base}${urlPath}`
  const inputCount = openAiInputToStrings(body.input).length

  let upstreamRes: globalThis.Response
  try {
    upstreamRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...upstreamAuthHeader(model), ...upstreamSessionHeaders(req) },
      body: JSON.stringify(payload),
    })
  } catch (e) {
    await appendUsage(req, modelSlug, 0, 0, 0, 0, 0, 'error', String(e))
    res.status(502).json({
      error: { message: '上游连接失败（请检查上游地址与协议）', type: 'upstream_error' },
    })
    return
  }

  const rawText = await upstreamRes.text()
  let upstreamJson: unknown = null
  try {
    upstreamJson = JSON.parse(rawText)
  } catch {
    upstreamJson = null
  }

  if (!upstreamRes.ok) {
    await appendUsage(req, modelSlug, 0, 0, 0, 0, 0, 'error', rawText.slice(0, 500))
    res.status(upstreamRes.status)
    res.setHeader('Content-Type', upstreamRes.headers.get('content-type') || 'application/json')
    res.send(rawText)
    return
  }

  const openAiJson = normalizeEmbeddingToOpenAi(model, upstreamJson, modelSlug, inputCount)
  try {
    const usage = readUsage((openAiJson as { usage?: unknown })?.usage)
    let prompt = usage.prompt
    if (!usage.found) {
      prompt = estimateEmbeddingTokens(body.input)
    }
    await settleBilling(
      req,
      model,
      modelSlug,
      prompt,
      0,
      usage.cached,
      0,
      0,
      'ok',
      usage.found ? '' : 'usage_estimated',
    )
  } catch (e) {
    res.status(402).json({
      error: { message: e instanceof Error ? e.message : '扣费失败', type: 'billing_error' },
    })
    return
  }

  res.status(200)
  res.setHeader('Content-Type', 'application/json')
  res.send(JSON.stringify(openAiJson))
})

proxyRouter.post('/rerank', authApiKey, async (req: AuthedRequest, res) => {
  const body = (req.body || {}) as Record<string, unknown>
  const modelSlug = String(body.model || '')
  const model = await resolveModelForProxy(req, res, modelSlug, 'rerank')
  if (!model) return
  trackEndpoint('rerank', req, res, modelSlug)

  let urlPath: string
  let payload: Record<string, unknown>
  try {
    const built = buildRerankUpstreamRequest(model, body)
    urlPath = built.urlPath
    payload = built.payload
  } catch (e) {
    res.status(400).json({
      error: { message: e instanceof Error ? e.message : '请求无效', type: 'invalid_request_error' },
    })
    return
  }

  const base = String(model.upstream_base_url).replace(/\/$/, '')
  const url = `${base}${urlPath}`
  const query = String(body.query ?? '')
  const docCount = toDocumentStrings(body.documents).length

  let upstreamRes: globalThis.Response
  try {
    upstreamRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...upstreamAuthHeader(model), ...upstreamSessionHeaders(req) },
      body: JSON.stringify(payload),
    })
  } catch (e) {
    await appendUsage(req, modelSlug, 0, 0, 0, 0, 0, 'error', String(e))
    res.status(502).json({
      error: { message: '上游连接失败（请检查上游地址与协议）', type: 'upstream_error' },
    })
    return
  }

  const rawText = await upstreamRes.text()
  let upstreamJson: unknown = null
  try {
    upstreamJson = JSON.parse(rawText)
  } catch {
    upstreamJson = null
  }

  if (!upstreamRes.ok) {
    await appendUsage(req, modelSlug, 0, 0, 0, 0, 0, 'error', rawText.slice(0, 500))
    res.status(upstreamRes.status)
    res.setHeader('Content-Type', upstreamRes.headers.get('content-type') || 'application/json')
    res.send(rawText)
    return
  }

  // 估算 fallback prompt token：query + documents 文本长度的 1/4，最小 1
  const fallbackPrompt = Math.max(1, Math.ceil((query.length + 8) / 4))
  const returnDocs = Boolean(body.return_documents ?? false)
  const openAiJson = normalizeRerankToOpenAi(model, upstreamJson, modelSlug, fallbackPrompt, returnDocs)
  try {
    const usage = readUsage((openAiJson as { usage?: unknown })?.usage)
    await settleBilling(
      req,
      model,
      modelSlug,
      usage.prompt,
      usage.completion,
      usage.cached,
      usage.imageTokens,
      0,
      'ok',
      usage.found ? '' : 'usage_estimated',
    )
  } catch (e) {
    res.status(402).json({
      error: { message: e instanceof Error ? e.message : '扣费失败', type: 'billing_error' },
    })
    return
  }

  res.status(200)
  res.setHeader('Content-Type', 'application/json')
  res.send(JSON.stringify(openAiJson))
})

proxyRouter.post('/images/generations', authApiKey, async (req: AuthedRequest, res) => {
  const body = (req.body || {}) as Record<string, unknown>
  const modelSlug = String(body.model || '')
  const model = await resolveModelForProxy(req, res, modelSlug, 'image_generation')
  if (!model) return
  trackEndpoint('images/generations', req, res, modelSlug)

  await forwardJsonProxy(
    req,
    res,
    model,
    modelSlug,
    'image_generation',
    body,
    async (json, ok, rawText) => {
      if (!ok) {
        await appendUsage(req, modelSlug, 0, 0, 0, 0, 0, 'error', rawText.slice(0, 500))
        return
      }
      const imageCount = countGeneratedImages(json, body)
      const perImage = Number(model.image_price_per_image) || 0
      if (perImage > 0) {
        await settleBilling(req, model, modelSlug, 0, 0, 0, 0, imageCount, 'ok', '', 'per_image')
        return
      }
      const usage = readUsage((json as { usage?: unknown })?.usage)
      let completion = usage.completion
      if (!usage.found) {
        completion = Math.max(1, imageCount) * (model.image_tokens_per_image || 512)
      }
      await settleBilling(
        req,
        model,
        modelSlug,
        usage.prompt,
        completion,
        usage.cached,
        0,
        0,
        'ok',
        usage.found ? '' : 'usage_estimated',
      )
    },
  )
})

proxyRouter.post('/messages', authApiKey, async (req: AuthedRequest, res) => {
  const body = (req.body || {}) as Record<string, unknown>
  const modelSlug = String(body.model || '').trim()
  if (!modelSlug) {
    res.status(400).json({ error: { message: 'model 必填', type: 'invalid_request_error' } })
    return
  }

  if (!enforceRateLimits(req, res, modelSlug)) return

  const model = db.getStore().models.find((m) => m.slug === modelSlug && m.enabled)
  if (!model) {
    res.status(404).json({ error: { message: `模型 ${modelSlug} 不存在或未启用`, type: 'not_found' } })
    return
  }

  const type = modelTypeOf(model)
  // 仅 chat 类型且开启 anthropic 开关的模型暴露 Messages 协议
  if (type !== 'chat') {
    res.status(400).json({
      error: {
        message: `模型 ${modelSlug} 类型为 ${type}，不支持 Messages 协议`,
        type: 'wrong_endpoint',
      },
    })
    return
  }
  if (!model.anthropic_enabled) {
    res.status(400).json({
      error: {
        message: `模型 ${modelSlug} 未开启 Anthropic(Claude) 协议，请在管理台开启 Anthropic 协议开关`,
        type: 'claude_not_enabled',
      },
    })
    return
  }

  // 仅开发者模型：非开发者一律拒绝调用
  if (model.dev_only && !(await mayAccessDevOnly(req))) {
    res.status(403).json({
      type: 'error',
      error: {
        type: 'permission_error',
        message: `模型 ${modelSlug} 仅对集市开发者开放，你无权调用`,
      },
    })
    return
  }

  // 透传需要独立上游；否则走反代（转 chat 打到 openai 上游）
  const useOwnUpstream = anthropicHasOwnUpstream(model)
  if (!useOwnUpstream && !model.upstream_base_url) {
    res.status(503).json({
      error: { message: '模型上游未配置，请联系管理员', type: 'upstream_not_configured' },
    })
    return
  }

  const imageCount = countClaudeImages(body.messages)
  if (imageCount > 0 && !model.multimodal_enabled) {
    res.status(400).json({
      error: {
        message: '该模型未开启多模态，请去掉 image 或联系管理员启用',
        type: 'multimodal_not_enabled',
      },
    })
    return
  }

  // 上下文长度检测：模型配置了 context_length 且本次输入超限则拒绝
  if (model.context_length && model.context_length > 0) {
    const inputTokens = estimateInputTokens({ messages: body.messages, system: body.system })
    const ctxErr = contextLimitError(model, inputTokens)
    if (ctxErr) {
      await appendUsage(req, modelSlug, 0, 0, 0, 0, imageCount, 'context_exceeded', ctxErr)
      res.status(400).json({
        type: 'error',
        error: { type: 'invalid_request_error', message: ctxErr },
      })
      return
    }
  }

  const denied = enforceAccess(req, model)
  if (denied) {
    await appendUsage(req, modelSlug, 0, 0, 0, 0, imageCount, 'forbidden', denied)
    res.status(403).json({ error: { message: denied, type: 'origin_forbidden' } })
    return
  }

  const fresh = db.getStore().users.find((u) => u.id === req.user!.id)
  if (!fresh || fresh.balance_cents <= 0) {
    res.status(402).json({
      error: { message: '余额不足，请联系管理员充值', type: 'insufficient_quota' },
    })
    return
  }
  req.user = fresh
  trackEndpoint('messages', req, res, modelSlug)

  const upstreamModel = model.upstream_model || model.slug

  // —— 独立上游：直接透传 Claude Messages 协议 ——
  if (anthropicHasOwnUpstream(model)) {
    const base = String(model.anthropic_base_url).replace(/\/$/, '')
    const url = anthropicMessagesUrl(base)
    const payloadProxy: Record<string, unknown> = { ...body, model: upstreamModel }
    delete payloadProxy.api_key
    const wantStream = Boolean(body.stream)

    let upstreamRes: globalThis.Response
    try {
      upstreamRes = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...anthropicAuthHeader(model),
          ...upstreamSessionHeaders(req),
        },
        body: JSON.stringify(payloadProxy),
      })
    } catch (e) {
      await appendUsage(req, modelSlug, 0, 0, 0, 0, imageCount, 'error', String(e))
      res.status(502).json({
        error: { message: '上游连接失败（请检查 Anthropic 地址）', type: 'upstream_error' },
      })
      return
    }

    const contentType = upstreamRes.headers.get('content-type') || ''
    const isStream = wantStream || contentType.includes('text/event-stream')

    // —— 上游非 200：不包装 SSE，规范化为 Anthropic 错误返回 ——
    if (upstreamRes.status !== 200) {
      const errText = await upstreamRes.text().catch(() => '')
      const claudeErr = upstreamErrorToClaude(upstreamRes.status, errText)
      if (wantStream) {
        res.status(200)
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.write(`event: error\ndata: ${JSON.stringify(claudeErr)}\n\n`)
        res.end()
      } else {
        res.status(upstreamRes.status)
        res.setHeader('Content-Type', 'application/json')
        res.send(JSON.stringify(claudeErr))
      }
      await appendUsage(req, modelSlug, 0, 0, 0, 0, imageCount, 'error', claudeErr.error.message.slice(0, 500))
      return
    }

    if (isStream) {
      res.status(upstreamRes.status)
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      const reader = upstreamRes.body?.getReader()
      if (!reader) {
        res.end()
        return
      }
      const decoder = new TextDecoder()
      let buf = ''
      // 把透传的 Claude SSE 里的 DSML/antArtifact 文本标签重建为结构化 content_block，
      // 保证 Claude Code 能正确执行工具/渲染工件，而不是打印原始标签。
      const passthrough = new ClaudePassthroughSse()
      const writeEvents = (events: Array<{ event: string; data: Record<string, unknown> }>) => {
        for (const ev of events) {
          res.write(`event: ${ev.event}\n`)
          res.write(`data: ${JSON.stringify(ev.data)}\n\n`)
        }
      }
      // 解析 SSE：按 event:/data: 成对切分交给转换器重建
      const flushSse = () => {
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        let curEvent = ''
        let curData = ''
        for (const line of lines) {
          if (line.startsWith('event:')) curEvent = line.slice(6).trim()
          else if (line.startsWith('data:')) curData = line.slice(5).trim()
          if (curData && (line === '' || line === '\r')) {
            let dataObj: unknown = null
            try {
              dataObj = JSON.parse(curData)
            } catch {
              dataObj = curData
            }
            writeEvents(passthrough.pushEvent(curEvent, dataObj as Record<string, unknown>))
            curEvent = ''
            curData = ''
          }
        }
      }
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          flushSse()
        }
        writeEvents(passthrough.finish())
        buf += decoder.decode()
        flushSse()
      } finally {
        res.end()
      }
      const usage = readUsage(extractUsageFromSse(buf))
      try {
        await settleBilling(
          req,
          model,
          modelSlug,
          usage.prompt,
          usage.completion,
          usage.cached,
          usage.imageTokens,
          imageCount,
          upstreamRes.ok ? 'ok' : 'error',
          usage.found ? '' : 'usage_estimated',
        )
      } catch {
        /* 流已结束 */
      }
      return
    }

    const text = await upstreamRes.text()
    let json: unknown = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    const usage = readUsage((json as { usage?: unknown })?.usage)
    if (upstreamRes.ok) {
      try {
        await settleBilling(
          req,
          model,
          modelSlug,
          usage.prompt,
          usage.completion,
          usage.cached,
          usage.imageTokens,
          imageCount,
          'ok',
          usage.found ? '' : 'usage_estimated',
        )
      } catch (e) {
        res.status(402).json({
          error: { message: e instanceof Error ? e.message : '扣费失败', type: 'billing_error' },
        })
        return
      }
    } else {
      await appendUsage(
        req,
        modelSlug,
        usage.prompt,
        usage.completion,
        usage.cached,
        0,
        imageCount,
        'error',
        text.slice(0, 500),
      )
    }
    res.status(upstreamRes.status)
    res.setHeader('Content-Type', contentType || 'application/json')
    res.send(text)
    return
  }

  // —— 回退模式：转换为 OpenAI Chat Completions 打到 OpenAI 上游 ——
  const base = String(model.upstream_base_url).replace(/\/$/, '')
  const url = `${base}/chat/completions`

  let payload: Record<string, unknown>
  try {
    payload = claudeRequestToOpenAi(model, body as never)
  } catch (e) {
    res.status(400).json({
      error: { message: e instanceof Error ? e.message : '请求无效', type: 'invalid_request_error' },
    })
    return
  }
  delete payload.api_key

  const wantStream = Boolean(body.stream)
  if (wantStream) {
    const prev =
      payload.stream_options && typeof payload.stream_options === 'object'
        ? (payload.stream_options as Record<string, unknown>)
        : {}
    payload.stream_options = { ...prev, include_usage: true }
  }

  let upstreamRes: globalThis.Response
  try {
    upstreamRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...upstreamAuthHeader(model), ...upstreamSessionHeaders(req) },
      body: JSON.stringify(payload),
    })
  } catch (e) {
    await appendUsage(req, modelSlug, 0, 0, 0, 0, imageCount, 'error', String(e))
    res.status(502).json({
      error: { message: '上游连接失败（请检查 vLLM 地址）', type: 'upstream_error' },
    })
    return
  }

  const contentType = upstreamRes.headers.get('content-type') || ''
  const isStream = wantStream || contentType.includes('text/event-stream')

  // —— 上游非 200：不包装 SSE，规范化为 Anthropic 错误返回 ——
  if (upstreamRes.status !== 200) {
    const errText = await upstreamRes.text().catch(() => '')
    const claudeErr = upstreamErrorToClaude(upstreamRes.status, errText)
    if (wantStream) {
      // 客户端要流：HTTP 200 + SSE error 事件（Anthropic 流式错误的标准承载方式）
      res.status(200)
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.write(`event: error\ndata: ${JSON.stringify(claudeErr)}\n\n`)
      res.end()
    } else {
      res.status(upstreamRes.status)
      res.setHeader('Content-Type', 'application/json')
      res.send(JSON.stringify(claudeErr))
    }
    await appendUsage(req, modelSlug, 0, 0, 0, 0, imageCount, 'error', claudeErr.error.message.slice(0, 500))
    return
  }

  // —— 流式：把每块规范为 Claude 事件 ——
  if (isStream) {
    res.status(upstreamRes.status)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    const reader = upstreamRes.body?.getReader()
    if (!reader) {
      res.end()
      return
    }

    const decoder = new TextDecoder()
    let buf = ''
    let usageFound = false
    let inputTokens = 0
    let completionTokens = 0
    let cachedTokens = 0
    let collectedText = ''
    // 内容流状态机：识别 DSML/antartifact 并归属 content_block 生命周期
    const contentStream = new ClaudeContentStream()
    // 先发 message_start（content_block 由 contentStream 统一发出）
    const est0 = estimateClaudeTokens(body.messages, body.system)
    inputTokens = est0.promptTokens
    for (const ev of claudeStreamStartEvents(upstreamModel, inputTokens, true)) {
      res.write(`event: ${ev.event}\n`)
      res.write(`data: ${JSON.stringify(ev.data)}\n\n`)
    }

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        // 按行拆 SSE data，取完整 JSON 块
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          const t = line.trim()
          if (!t.startsWith('data:')) continue
          const data = t.slice(5).trim()
          if (!data || data === '[DONE]') continue
          let j: unknown = null
          try {
            j = JSON.parse(data)
          } catch {
            continue
          }
          const usageU = readUsage((j as { usage?: unknown })?.usage)
          if (usageU.found) {
            usageFound = true
            inputTokens = usageU.prompt
            // 捕获真实 completion/cached，避免最终结算时被硬编码为 0
            completionTokens = usageU.completion
            cachedTokens = usageU.cached
          }
          // 累计输出文本，用于无 usage 时估算 output_tokens
          const txt = String((j as { choices?: Array<{ delta?: { content?: unknown } }> })?.choices?.[0]?.delta?.content ?? '')
          if (txt) collectedText += txt
          // output_tokens：优先上游真实值，其次按文本长度估算
          const outTokens = usageU.found && usageU.completion > 0 ? usageU.completion : Math.ceil(collectedText.length / 4)
          const { events, done: chunkDone } = openAiStreamChunkToClaude(
            j as Record<string, unknown>,
            {
              input_tokens: inputTokens,
              output_tokens: outTokens,
            },
            contentStream,
          )
          for (const ev of events) {
            res.write(`event: ${ev.event}\n`)
            res.write(`data: ${JSON.stringify(ev.data)}\n\n`)
          }
          if (chunkDone) break
        }
      }
    } finally {
      // 流式响应收尾：把本次 reasoning_content 记入缓存，供下一轮回传补挂。
      // 该字段对 DeepSeek 强校验、对其他 OpenAI 兼容上游静默忽略，故通用补挂是安全的；
      // 仅在 reasoning 非空时写缓存（避免空值污染非 DeepSeek 上游）。
      const snap = contentStream.snapshot()
      if (snap.toolCallIds.length && snap.reasoning) {
        rememberReasoning(upstreamModel, snap.text, snap.toolCallIds, snap.reasoning)
      }
      res.end()
    }

    let usage = { prompt: 0, completion: 0, cached: 0, imageTokens: 0, found: false }
    if (usageFound) {
      // 输出 tokens：优先上游真实值；若 usage_found 但 completion 为 0，说明上游未细报，按文本估算兜底
      const out = completionTokens > 0 ? completionTokens : Math.ceil(collectedText.length / 4)
      usage = { prompt: inputTokens, completion: out, cached: cachedTokens, imageTokens: 0, found: true }
    } else {
      const est = estimateClaudeTokens(body.messages, body.system)
      usage = { prompt: est.promptTokens, completion: Math.ceil(collectedText.length / 4), cached: 0, imageTokens: 0, found: false }
    }

    try {
      await settleBilling(
        req,
        model,
        modelSlug,
        usage.prompt,
        usage.completion,
        usage.cached,
        usage.imageTokens,
        imageCount,
        upstreamRes.ok ? 'ok' : 'error',
        usage.found ? '' : 'usage_estimated',
      )
    } catch {
      /* 流已结束 */
    }
    return
  }

  // —— 非流式 ——
  const text = await upstreamRes.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }

  let usage = readUsage((json as { usage?: unknown })?.usage)
  if (!usage.found && upstreamRes.ok) {
    const est = estimateClaudeTokens(body.messages, body.system)
    usage = { ...usage, prompt: est.promptTokens, found: false }
  }

  if (upstreamRes.ok) {
    try {
      await settleBilling(
        req,
        model,
        modelSlug,
        usage.prompt,
        usage.completion,
        usage.cached,
        usage.imageTokens,
        imageCount,
        'ok',
        usage.found ? '' : 'usage_estimated',
      )
    } catch (e) {
      res.status(402).json({
        error: { message: e instanceof Error ? e.message : '扣费失败', type: 'billing_error' },
      })
      return
    }
  } else {
    await appendUsage(
      req,
      modelSlug,
      usage.prompt,
      usage.completion,
      usage.cached,
      0,
      imageCount,
      'error',
      text.slice(0, 500),
    )
  }

  // 规范为 Claude Messages 形状返回；上游错误统一收敛为 Anthropic 错误形状
  const claudeResp = upstreamRes.ok
    ? openAiResponseToClaude((json as Record<string, unknown>) || {})
    : upstreamErrorToClaude(upstreamRes.status, text)

  res.status(upstreamRes.status)
  res.setHeader('Content-Type', 'application/json')
  res.send(JSON.stringify(claudeResp))
})

proxyRouter.post('/responses', authApiKey, async (req: AuthedRequest, res) => {
  const body = (req.body || {}) as Record<string, unknown>
  const modelSlug = String(body.model || '').trim()
  if (!modelSlug) {
    res.status(400).json({ error: { message: 'model 必填', type: 'invalid_request_error' } })
    return
  }
  if (!enforceRateLimits(req, res, modelSlug)) return

  const model = db.getStore().models.find((m) => m.slug === modelSlug && m.enabled)
  if (!model) {
    res.status(404).json({ error: { message: `模型 ${modelSlug} 不存在或未启用`, type: 'not_found' } })
    return
  }
  const type = modelTypeOf(model)
  if (type !== 'chat') {
    res.status(400).json({
      error: {
        message: `模型 ${modelSlug} 类型为 ${type}，不支持 Responses 协议`,
        type: 'wrong_endpoint',
      },
    })
    return
  }
  if (!model.responses_enabled) {
    res.status(400).json({
      error: {
        message: `模型 ${modelSlug} 未开启 OpenAI Responses 协议，请在管理台开启 Responses 协议开关`,
        type: 'responses_not_enabled',
      },
    })
    return
  }

  // 仅开发者模型：非开发者一律拒绝调用
  if (model.dev_only && !(await mayAccessDevOnly(req))) {
    res.status(403).json({
      error: {
        message: `模型 ${modelSlug} 仅对集市开发者开放，你无权调用`,
        type: 'dev_only_forbidden',
      },
    })
    return
  }

  const useOwnUpstream = responsesHasOwnUpstream(model)
  if (!useOwnUpstream && !String(model.upstream_base_url).trim()) {
    res.status(503).json({
      error: { message: '模型上游未配置，请联系管理员', type: 'upstream_not_configured' },
    })
    return
  }

  const inputForImage = Array.isArray(body.input) ? (body.input as unknown[]) : (body.messages as unknown[]) ?? []
  const imageCount = countImagesInMessages(inputForImage)
  if (imageCount > 0 && !model.multimodal_enabled) {
    res.status(400).json({
      error: {
        message: '该模型未开启多模态，请去掉图片或联系管理员启用',
        type: 'multimodal_not_enabled',
      },
    })
    return
  }

  // 上下文长度检测：模型配置了 context_length 且本次输入超限则拒绝
  if (model.context_length && model.context_length > 0) {
    const inputTokens = estimateInputTokens(body.input ?? body.messages)
    const ctxErr = contextLimitError(model, inputTokens)
    if (ctxErr) {
      await appendUsage(req, modelSlug, 0, 0, 0, 0, imageCount, 'context_exceeded', ctxErr)
      res.status(400).json(contextLimitErrorBody(ctxErr, inputTokens - model.context_length))
      return
    }
  }

  const denied = enforceAccess(req, model)
  if (denied) {
    await appendUsage(req, modelSlug, 0, 0, 0, 0, imageCount, 'forbidden', denied)
    res.status(403).json({ error: { message: denied, type: 'origin_forbidden' } })
    return
  }
  const fresh = db.getStore().users.find((u) => u.id === req.user!.id)
  if (!fresh || fresh.balance_cents <= 0) {
    res.status(402).json({
      error: { message: '余额不足，请联系管理员充值', type: 'insufficient_quota' },
    })
    return
  }
  req.user = fresh
  trackEndpoint('responses', req, res, modelSlug)

  const upstreamModel = model.upstream_model || model.slug

  // —— 独立上游：原生透传 OpenAI Responses 协议 ——
  if (responsesHasOwnUpstream(model)) {
    const base = String(model.responses_base_url).replace(/\/$/, '')
    const url = responsesUrl(base)
    const payloadProxy: Record<string, unknown> = { ...body, model: upstreamModel }
    delete payloadProxy.api_key
    const wantStream = Boolean(body.stream)

    let upstreamRes: globalThis.Response
    try {
      upstreamRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...upstreamAuthHeader(model), ...upstreamSessionHeaders(req) },
        body: JSON.stringify(payloadProxy),
      })
    } catch (e) {
      await appendUsage(req, modelSlug, 0, 0, 0, 0, imageCount, 'error', String(e))
      res.status(502).json({
        error: { message: '上游连接失败（请检查 Responses 地址）', type: 'upstream_error' },
      })
      return
    }

    const contentType = upstreamRes.headers.get('content-type') || ''
    const isStream = wantStream || contentType.includes('text/event-stream')
    // —— 上游非 200：不包装 SSE，规范化为 Anthropic 错误返回 ——
    if (upstreamRes.status !== 200) {
      const errText = await upstreamRes.text().catch(() => '')
      const claudeErr = upstreamErrorToClaude(upstreamRes.status, errText)
      if (wantStream) {
        res.status(200)
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.write(`event: error\ndata: ${JSON.stringify(claudeErr)}\n\n`)
        res.end()
      } else {
        res.status(upstreamRes.status)
        res.setHeader('Content-Type', 'application/json')
        res.send(JSON.stringify(claudeErr))
      }
      await appendUsage(req, modelSlug, 0, 0, 0, 0, imageCount, 'error', claudeErr.error.message.slice(0, 500))
      return
    }
    if (isStream) {
      res.status(upstreamRes.status)
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      const reader = upstreamRes.body?.getReader()
      if (!reader) {
        res.end()
        return
      }
      const decoder = new TextDecoder()
      let buf = ''
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          res.write(value)
        }
      } finally {
        res.end()
      }
      const usage = readUsage(extractUsageFromSse(buf))
      try {
        await settleBilling(
          req,
          model,
          modelSlug,
          usage.prompt,
          usage.completion,
          usage.cached,
          usage.imageTokens,
          imageCount,
          upstreamRes.ok ? 'ok' : 'error',
          usage.found ? '' : 'usage_estimated',
        )
      } catch {
        /* 流已结束 */
      }
      return
    }

    const text = await upstreamRes.text()
    let json: unknown = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    const usage = readUsage((json as { usage?: unknown })?.usage)
    if (upstreamRes.ok) {
      try {
        await settleBilling(
          req,
          model,
          modelSlug,
          usage.prompt,
          usage.completion,
          usage.cached,
          usage.imageTokens,
          imageCount,
          'ok',
          usage.found ? '' : 'usage_estimated',
        )
      } catch (e) {
        res.status(402).json({
          error: { message: e instanceof Error ? e.message : '扣费失败', type: 'billing_error' },
        })
        return
      }
    } else {
      await appendUsage(
        req,
        modelSlug,
        usage.prompt,
        usage.completion,
        usage.cached,
        0,
        imageCount,
        'error',
        text.slice(0, 500),
      )
    }
    res.status(upstreamRes.status)
    res.setHeader('Content-Type', contentType || 'application/json')
    res.send(text)
    return
  }

  // —— 回退模式：转换为 OpenAI Chat Completions 打到 OpenAI 上游 ——
  const base = String(model.upstream_base_url).replace(/\/$/, '')
  const url = `${base}/chat/completions`

  let payload: Record<string, unknown>
  try {
    payload = responsesRequestToOpenAi(model, body)
  } catch (e) {
    res.status(400).json({
      error: { message: e instanceof Error ? e.message : '请求无效', type: 'invalid_request_error' },
    })
    return
  }
  delete payload.api_key

  const wantStream = Boolean(body.stream)
  if (wantStream) {
    const prev =
      payload.stream_options && typeof payload.stream_options === 'object'
        ? (payload.stream_options as Record<string, unknown>)
        : {}
    payload.stream_options = { ...prev, include_usage: true }
  }

  let upstreamRes: globalThis.Response
  try {
    upstreamRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...upstreamAuthHeader(model), ...upstreamSessionHeaders(req) },
      body: JSON.stringify(payload),
    })
  } catch (e) {
    await appendUsage(req, modelSlug, 0, 0, 0, 0, imageCount, 'error', String(e))
    res.status(502).json({
      error: { message: '上游连接失败（请检查 vLLM 地址）', type: 'upstream_error' },
    })
    return
  }

  const contentType = upstreamRes.headers.get('content-type') || ''
  const isStream = wantStream || contentType.includes('text/event-stream')
  const runId = `resp_${Date.now().toString(36)}`

  if (isStream) {
    res.status(upstreamRes.status)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    const reader = upstreamRes.body?.getReader()
    if (!reader) {
      res.end()
      return
    }
    const decoder = new TextDecoder()
    let buf = ''
    let usageFound = false
    let inputTokens = 0
    let completionTokens = 0
    let cachedTokens = 0
    let collectedOutput = ''

    // 起始事件
    res.write(`event: response.created\n`)
    res.write(
      `data: ${JSON.stringify({
        type: 'response.created',
        response: { id: runId, object: 'response', status: 'in_progress', output: [] },
      })}\n\n`,
    )

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          const t = line.trim()
          if (!t.startsWith('data:')) continue
          const data = t.slice(5).trim()
          if (!data || data === '[DONE]') continue
          let j: unknown = null
          try {
            j = JSON.parse(data)
          } catch {
            continue
          }
          const usageU = readUsage((j as { usage?: unknown })?.usage)
          if (usageU.found) {
            usageFound = true
            inputTokens = usageU.prompt
            completionTokens = usageU.completion
            cachedTokens = usageU.cached
          }
          // 累计输出文本，用于无 usage 时估算 completion tokens
          const dTxt = String((j as { choices?: Array<{ delta?: { content?: unknown } }> })?.choices?.[0]?.delta?.content ?? '')
          if (dTxt) collectedOutput += dTxt
          const { events, done: chunkDone } = openAiStreamChunkToResponses(j as Record<string, unknown>, runId)
          for (const ev of events) {
            res.write(`event: ${ev.event}\n`)
            res.write(`data: ${JSON.stringify(ev.data)}\n\n`)
          }
          if (chunkDone) break
        }
      }
    } finally {
      res.end()
    }

    let usage = { prompt: 0, completion: 0, cached: 0, imageTokens: 0, found: false }
    if (usageFound) {
      const out = completionTokens > 0 ? completionTokens : Math.ceil(collectedOutput.length / 4)
      usage = { prompt: inputTokens, completion: out, cached: cachedTokens, imageTokens: 0, found: true }
    } else {
      const est = estimateTokens(inputForImage, collectedOutput)
      usage = { ...est, found: false }
    }
    try {
      await settleBilling(
        req,
        model,
        modelSlug,
        usage.prompt,
        usage.completion,
        usage.cached,
        usage.imageTokens,
        imageCount,
        upstreamRes.ok ? 'ok' : 'error',
        usage.found ? '' : 'usage_estimated',
      )
    } catch {
      /* 流已结束 */
    }
    return
  }

  // —— 非流式 ——
  const text = await upstreamRes.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  let usage = readUsage((json as { usage?: unknown })?.usage)
  if (!usage.found && upstreamRes.ok) {
    const est = estimateTokens(inputForImage, chatCompletionTextOf(json))
    usage = { ...usage, prompt: est.prompt, completion: est.completion, found: false }
  }

  if (upstreamRes.ok) {
    try {
      await settleBilling(
        req,
        model,
        modelSlug,
        usage.prompt,
        usage.completion,
        usage.cached,
        usage.imageTokens,
        imageCount,
        'ok',
        usage.found ? '' : 'usage_estimated',
      )
    } catch (e) {
      res.status(402).json({
        error: { message: e instanceof Error ? e.message : '扣费失败', type: 'billing_error' },
      })
      return
    }
  } else {
    await appendUsage(
      req,
      modelSlug,
      usage.prompt,
      usage.completion,
      usage.cached,
      0,
      imageCount,
      'error',
      text.slice(0, 500),
    )
  }

  const responsesResp = upstreamRes.ok
    ? openAiResponseToResponses((json as Record<string, unknown>) || {})
    : json

  res.status(upstreamRes.status)
  res.setHeader('Content-Type', 'application/json')
  res.send(JSON.stringify(responsesResp))
})
