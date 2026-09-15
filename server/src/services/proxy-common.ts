import type { Response } from 'express'
import { db, now, type ModelRow } from '../db.js'
import type { AuthedRequest } from '../middleware/auth.js'
import { calcCostCents, creditUser } from '../services/users.js'
import { checkAllowedOrigins } from '../services/origins.js'
import { enforceRateLimits } from '../services/rate-limits.js'
import {
  modelTypeOf,
  modelUpstreamPath,
  modelV1Path,
  type ModelType,
} from '../services/model-catalog.js'
import { mayAccessDevOnly } from '../services/dev-platform.js'

export function upstreamAuthHeader(model: ModelRow): Record<string, string> {
  const key = (model.upstream_api_key || process.env.SSEAPI_UPSTREAM_API_KEY || '').trim()
  if (!key) return {}
  if (/^bearer\s+/i.test(key)) return { Authorization: key }
  return { Authorization: `Bearer ${key}` }
}

/** Anthropic 上游鉴权头：优先 x-api-key，其次 Bearer */
export function anthropicAuthHeader(model: ModelRow): Record<string, string> {
  const key = (model.upstream_api_key || process.env.SSEAPI_UPSTREAM_API_KEY || '').trim()
  const h: Record<string, string> = {}
  if (!key) return h
  if (/^bearer\s+/i.test(key)) {
    h.Authorization = key
    return h
  }
  h['x-api-key'] = key
  return h
}

/** 透传给上游的 session/来源 header，让下游 LB（如 gpt-proxy）能按用户区分 session */
export function upstreamSessionHeaders(req: AuthedRequest): Record<string, string> {
  const h: Record<string, string> = {}
  if (req.user?.id) h['X-Session-Id'] = `u${req.user.id}`
  const xff = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || ''
  if (xff) h['X-Forwarded-For'] = String(xff).split(',')[0].trim()
  return h
}

/** 统一取上游地址：优先该协议独立 base，否则回退 OpenAI 上游 */
export function upstreamBaseFor(protocol: 'openai' | 'anthropic' | 'responses', model: ModelRow): string {
  if (protocol === 'anthropic') return String(model.anthropic_base_url || model.upstream_base_url || '').replace(/\/$/, '')
  if (protocol === 'responses') return String(model.responses_base_url || model.upstream_base_url || '').replace(/\/$/, '')
  return String(model.upstream_base_url || '').replace(/\/$/, '')
}

/** 构造 Anthropic Messages 上游完整 URL（兼容 base 含/不含 /v1） */
export function anthropicMessagesUrl(base: string): string {
  const b = base.replace(/\/$/, '')
  return /\/v1$/.test(b) ? `${b}/messages` : `${b}/v1/messages`
}

/** 构造 OpenAI Responses 上游完整 URL（兼容 base 含/不含 /v1） */
export function responsesUrl(base: string): string {
  const b = base.replace(/\/$/, '')
  return /\/v1$/.test(b) ? `${b}/responses` : `${b}/v1/responses`
}

export function clientMeta(req: AuthedRequest): string {
  const origin = req.headers.origin || ''
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || ''
  return String(origin || ip).slice(0, 200)
}

export const PROMPT_PREVIEW_MAX = 2000

/**
 * 从请求体提取「提示词」预览用于日志存证。
 * 兼容多种协议：
 *   - chat/messages: body.messages（取最后若干条 user 文本 + 文本块）
 *   - embedding: body.input（字符串/数组）
 *   - rerank: body.query + documents
 *   - 其他：取 body 关键字段
 * 统一截断到 PROMPT_PREVIEW_MAX 字符，且仅存文本（不含图片 URL 大段 base64）。
 */
export function promptPreview(req: AuthedRequest): string {
  const body = (req.body || {}) as Record<string, unknown>
  const parts: string[] = []

  const push = (v: unknown, maxLen = 1200) => {
    if (v == null) return
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    if (!s) return
    const clean = s
      .replace(/data:image\/[a-z+]+;base64,[^\s"]+/gi, '[image]')
      .replace(/[\u0000-\u0008\u000b-\u001f]/g, '')
      .trim()
    if (clean) parts.push(clean.slice(0, maxLen))
  }

  // chat / messages
  const messages = body.messages
  if (Array.isArray(messages)) {
    // 取最后 4 条 user 文本做预览，避免整段
    const userTexts: string[] = []
    for (const m of messages.slice(-8)) {
      if (!m || typeof m !== 'object') continue
      const msg = m as Record<string, unknown>
      if (msg.role !== 'user') continue
      if (typeof msg.content === 'string') userTexts.push(msg.content)
      else if (Array.isArray(msg.content)) {
        const texts = (msg.content as unknown[])
          .map((b) => (b && typeof b === 'object' ? String((b as { text?: unknown }).text ?? '') : ''))
          .filter(Boolean)
        if (texts.length) userTexts.push(texts.join(' '))
      }
    }
    if (userTexts.length) push(userTexts.slice(-2).join('\n'), 2000)
  }

  // embedding
  if (body.input != null) push(body.input, 2000)

  // rerank
  if (body.query != null) push(`query: ${String(body.query)}`, 1000)
  if (body.documents != null) push(`documents: ${JSON.stringify(body.documents)}`, 1000)

  // 兜底：无 messages/input 时记录 body 摘要
  if (!parts.length) {
    const keys = ['prompt', 'question', 'instruction', 'text', 'content']
    for (const k of keys) if (body[k] != null) push(body[k], 2000)
  }

  const joined = parts.join('\n').trim()
  return joined.slice(0, PROMPT_PREVIEW_MAX)
}

export function enforceAccess(req: AuthedRequest, model: ModelRow): string | null {
  const keyRow = db.getStore().api_keys.find((k) => k.id === req.apiKeyId)
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
  const referer = typeof req.headers.referer === 'string' ? req.headers.referer : undefined

  const modelCheck = checkAllowedOrigins(model.allowed_origins, origin, referer)
  if (!modelCheck.ok) return modelCheck.reason

  if (keyRow?.allowed_origins) {
    const keyCheck = checkAllowedOrigins(keyRow.allowed_origins, origin, referer)
    if (!keyCheck.ok) return keyCheck.reason
  }
  return null
}

/** 从上游 JSON usage 取 prompt/completion/cached/image；缺省为 0 */
export function readUsage(usage: unknown): {
  prompt: number
  completion: number
  cached: number
  imageTokens: number
  found: boolean
} {
  if (!usage || typeof usage !== 'object') {
    return { prompt: 0, completion: 0, cached: 0, imageTokens: 0, found: false }
  }
  const u = usage as Record<string, unknown>
  // 兼容三种 usage 形状：
  //  - OpenAI chat: prompt_tokens / completion_tokens / total_tokens
  //  - Anthropic Messages: input_tokens / output_tokens
  //  - OpenAI Responses: input_tokens / output_tokens
  const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? 0)
  const completion = Number(u.completion_tokens ?? u.output_tokens ?? 0)
  const total = Number(u.total_tokens ?? 0)
  const details =
    u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object'
      ? (u.prompt_tokens_details as Record<string, unknown>)
      : null
  const cachedRaw = Number(details?.cached_tokens ?? 0)
  const imageTokRaw = Number(
    details?.image_tokens ?? details?.vision_tokens ?? u.image_tokens ?? 0,
  )
  if (!Number.isFinite(prompt) && !Number.isFinite(completion) && !Number.isFinite(total)) {
    return { prompt: 0, completion: 0, cached: 0, imageTokens: 0, found: false }
  }
  let p = Number.isFinite(prompt) ? Math.max(0, Math.floor(prompt)) : 0
  let c = Number.isFinite(completion) ? Math.max(0, Math.floor(completion)) : 0
  if (!p && !c && Number.isFinite(total) && total > 0) {
    p = Math.max(0, Math.floor(total))
  }
  const cached = Math.min(p, Number.isFinite(cachedRaw) ? Math.max(0, Math.floor(cachedRaw)) : 0)
  const imageTokens = Number.isFinite(imageTokRaw) ? Math.max(0, Math.floor(imageTokRaw)) : 0
  return { prompt: p, completion: c, cached, imageTokens, found: p > 0 || c > 0 || total > 0 }
}

export async function appendUsage(
  req: AuthedRequest,
  modelSlug: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number,
  cost: number,
  imageCount: number,
  status: string,
  errorMessage = '',
  prompt = '',
) {
  const cached = Math.min(
    Math.max(0, Math.floor(promptTokens || 0)),
    Math.max(0, Math.floor(cachedTokens || 0)),
  )
  db.getStore().usage_logs.push({
    id: db.nextId('usage_logs'),
    user_id: req.user!.id,
    api_key_id: req.apiKeyId ?? null,
    model_slug: modelSlug,
    prompt_tokens: promptTokens,
    cached_tokens: cached,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    image_count: Math.max(0, Math.floor(imageCount || 0)),
    cost_cents: cost,
    status,
    error_message: errorMessage,
    client_meta: clientMeta(req),
    prompt: prompt || promptPreview(req),
    created_at: now(),
  })
  await db.persist()
}

export async function settleBilling(
  req: AuthedRequest,
  model: ModelRow,
  modelSlug: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number,
  imageTokens: number,
  imageCount: number,
  status: string,
  note = '',
  billingModeOverride?: 'per_image' | 'token',
  prompt = '',
) {
  const mode =
    billingModeOverride ||
    (model.image_billing_mode === 'per_image' ? 'per_image' : 'token')
  const cost = calcCostCents(
    promptTokens,
    completionTokens,
    model.input_price_per_1m,
    model.output_price_per_1m,
    cachedTokens,
    model.cache_price_per_1m,
    {
      imageBillingMode: mode,
      imageCount,
      imagePricePerImage: model.image_price_per_image,
      imageTokensPerImage: model.image_tokens_per_image,
      imageTokens,
      imagePer1m: model.image_price_per_1m,
    },
  )
  if (cost > 0) {
    const cached = Math.min(promptTokens, Math.max(0, cachedTokens))
    const fresh = Math.max(0, promptTokens - cached)
    const imgNote =
      imageCount > 0
        ? mode === 'per_image'
          ? `+图${imageCount}张`
          : `+图${imageCount}张(token)`
        : ''
    const noteDetail =
      cached > 0 || imageCount > 0
        ? `调用 ${modelSlug}（输入${fresh}+缓存${cached}+输出${completionTokens}${imgNote}）`
        : `调用 ${modelSlug}`
    await creditUser(req.user!.id, -cost, 'usage', noteDetail, undefined)
  }
  await appendUsage(
    req,
    modelSlug,
    promptTokens,
    completionTokens,
    cachedTokens,
    cost,
    imageCount,
    status,
    note,
    prompt,
  )
}

export function countGeneratedImages(json: unknown, body: Record<string, unknown>): number {
  if (json && typeof json === 'object') {
    const data = (json as { data?: unknown }).data
    if (Array.isArray(data) && data.length > 0) return data.length
  }
  const n = Number(body?.n)
  if (Number.isFinite(n) && n > 0) return Math.floor(n)
  return 1
}

/** 解析 model、校验类型与余额，失败时已写 res */
export async function resolveModelForProxy(
  req: AuthedRequest,
  res: Response,
  modelSlug: string,
  expectedType: ModelType,
  imageCountForForbidden = 0,
): Promise<ModelRow | null> {
  if (!modelSlug) {
    res.status(400).json({ error: { message: 'model 必填', type: 'invalid_request_error' } })
    return null
  }

  if (!enforceRateLimits(req, res, modelSlug)) return null

  const model = db.getStore().models.find((m) => m.slug === modelSlug && m.enabled)
  if (!model) {
    res.status(404).json({
      error: { message: `模型 ${modelSlug} 不存在或未启用`, type: 'not_found' },
    })
    return null
  }

  if (!model.upstream_base_url) {
    res.status(503).json({
      error: { message: '模型上游未配置，请联系管理员', type: 'upstream_not_configured' },
    })
    return null
  }

  const type = modelTypeOf(model)
  if (type !== expectedType) {
    res.status(400).json({
      error: {
        message: `模型 ${modelSlug} 类型为 ${type}，请使用 ${modelV1Path(type)}`,
        type: 'wrong_endpoint',
        model_type: type,
        correct_endpoint: modelV1Path(type),
      },
    })
    return null
  }

  // 仅开发者模型：非开发者一律拒绝调用
  if (model.dev_only && !(await mayAccessDevOnly(req))) {
    await appendUsage(req, modelSlug, 0, 0, 0, 0, imageCountForForbidden, 'forbidden', 'dev_only')
    res.status(403).json({
      error: {
        message: `模型 ${modelSlug} 仅对集市开发者开放，你无权调用`,
        type: 'dev_only_forbidden',
      },
    })
    return null
  }

  const denied = enforceAccess(req, model)
  if (denied) {
    await appendUsage(req, modelSlug, 0, 0, 0, 0, imageCountForForbidden, 'forbidden', denied)
    res.status(403).json({ error: { message: denied, type: 'origin_forbidden' } })
    return null
  }

  const fresh = db.getStore().users.find((u) => u.id === req.user!.id)
  if (!fresh || fresh.balance_cents <= 0) {
    res.status(402).json({
      error: { message: '余额不足，请联系管理员充值', type: 'insufficient_quota' },
    })
    return null
  }
  req.user = fresh
  return model
}

export function buildUpstreamUrl(model: ModelRow, expectedType: ModelType): string {
  const base = String(model.upstream_base_url).replace(/\/$/, '')
  return `${base}${modelUpstreamPath(expectedType)}`
}

export async function forwardJsonProxy(
  req: AuthedRequest,
  res: Response,
  model: ModelRow,
  modelSlug: string,
  expectedType: ModelType,
  body: Record<string, unknown>,
  billing: (json: unknown, upstreamOk: boolean, rawText: string) => Promise<void>,
) {
  const upstreamModel = model.upstream_model || model.slug
  const url = buildUpstreamUrl(model, expectedType)
  const payload: Record<string, unknown> = { ...body, model: upstreamModel }
  delete payload.api_key

  let upstreamRes: globalThis.Response
  try {
    upstreamRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...upstreamAuthHeader(model),
        ...upstreamSessionHeaders(req),
      },
      body: JSON.stringify(payload),
    })
  } catch (e) {
    await appendUsage(req, modelSlug, 0, 0, 0, 0, 0, 'error', String(e))
    res.status(502).json({
      error: { message: '上游连接失败（请检查上游地址）', type: 'upstream_error' },
    })
    return
  }

  const text = await upstreamRes.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }

  if (upstreamRes.ok) {
    try {
      await billing(json, true, text)
    } catch (e) {
      res.status(402).json({
        error: { message: e instanceof Error ? e.message : '扣费失败', type: 'billing_error' },
      })
      return
    }
  } else {
    await billing(json, false, text)
  }

  const contentType = upstreamRes.headers.get('content-type') || ''
  res.status(upstreamRes.status)
  res.setHeader('Content-Type', contentType || 'application/json')
  res.send(text)
}

/**
 * 估算某次输入的 token 数（不含图片本体，仅按文本长度粗算；用于上下文长度检测）。
 * 规则：中文/符号按 ~1.7 字符/token，英文按 ~4 字符/token 的折中，取 JSON.stringify 长度/2.5 近似。
 * 不追求精确计费（计费用上游/Claude 估算），只用于「是否超限」的判断。
 */
export function estimateInputTokens(value: unknown): number {
  const s = JSON.stringify(value ?? '')
  if (!s) return 0
  return Math.max(0, Math.ceil(s.length / 2.5))
}

/** 若模型配置了上下文长度且输入 token 超限，返回错误信息；否则返回 null */
export function contextLimitError(model: ModelRow, inputTokens: number): string | null {
  const limit = Math.floor(Number(model.context_length) || 0)
  if (limit <= 0) return null
  if (inputTokens > limit) {
    return `输入超限：本次约 ${inputTokens.toLocaleString()} tokens，超过模型上下文长度 ${limit.toLocaleString()} tokens`
  }
  return null
}

/** 统一的「输入超限」响应体（OpenAI/Anthropic 兼容错误形状） */
export function contextLimitErrorBody(message: string, exceedTokens: number) {
  return {
    error: {
      message,
      type: 'context_length_exceeded',
      context_length_exceeded: true,
      exceed_tokens: exceedTokens,
      code: 'context_length_exceeded',
    },
  }
}
