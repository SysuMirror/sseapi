import { Router } from 'express'
import { db, now } from '../db.js'
import { authJwt, requireAdmin, ok, fail } from '../middleware/auth.js'
import {
  creditUser,
  setUserBalance,
  centsToYuan,
  publicUser,
  getUserById,
} from '../services/users.js'
import {
  getRateLimitsConfig,
  mapRateLimitsPublic,
  normalizeLimit,
  getRuntimeStatus,
} from '../services/rate-limits.js'
import {
  MODEL_TYPE_LABELS,
  modelTypeOf,
  modelUpstreamPath,
  normalizeModelType,
  normalizeContextLength,
  parseThinkingLevels,
} from '../services/model-catalog.js'
import {
  buildEmbeddingUpstreamRequest,
  normalizeEmbeddingApiFormat,
  normalizeEmbeddingToOpenAi,
  probeTextsFromPrompt,
  summarizeEmbeddingProbe,
} from '../services/embedding-adapter.js'
import {
  buildRerankUpstreamRequest,
  normalizeRerankApiFormat,
  normalizeRerankToOpenAi,
  RERANK_API_FORMAT_LABELS,
  rerankUpstreamPath,
  summarizeRerankProbe,
} from '../services/rerank-adapter.js'
import { probeProtocolSupport } from '../services/protocol-support.js'
import { isDeepSeekOfficialUpstream } from '../services/claude-adapter.js'

export const adminRouter = Router()
adminRouter.use(authJwt, requireAdmin)

/** 根据模型类型归一化上游协议格式（embedding→embedding 格式，rerank→rerank 格式，其余 openai） */
function normalizeUpstreamApiFormat(modelType: string, fmt: unknown): string {
  const t = normalizeModelType(modelType)
  if (t === 'embedding') return normalizeEmbeddingApiFormat(fmt)
  if (t === 'rerank') return normalizeRerankApiFormat(fmt)
  return 'openai'
}

function mapModelAdmin(r: any) {
  const modelType = modelTypeOf(r)
  return {
    id: r.id,
    slug: r.slug,
    displayName: r.display_name,
    description: r.description,
    badge: r.badge,
    cardColor: r.card_color,
    modelType,
    modelTypeLabel: MODEL_TYPE_LABELS[modelType],
    upstreamApiFormat: r.upstream_api_format || 'openai',
    upstreamPathOverride: r.upstream_path_override || '',
    upstreamBaseUrl: r.upstream_base_url,
    upstreamModel: r.upstream_model,
    hasUpstreamApiKey: Boolean(r.upstream_api_key),
    upstreamApiKey: '',
    allowedOrigins: r.allowed_origins || '',
    rpmLimit: r.rpm_limit || 0,
    maxConcurrent: r.max_concurrent || 0,
    inputPricePer1m: r.input_price_per_1m,
    outputPricePer1m: r.output_price_per_1m,
    cachePricePer1m: r.cache_price_per_1m ?? 0,
    multimodalEnabled: !!r.multimodal_enabled,
    imageBillingMode: r.image_billing_mode === 'per_image' ? 'per_image' : 'token',
    imagePricePer1m: r.image_price_per_1m ?? 0,
    imagePricePerImage: r.image_price_per_image ?? 0,
    imageTokensPerImage: r.image_tokens_per_image ?? 512,
    thinkingEnabled: !!r.thinking_enabled,
    thinkingLevels: parseThinkingLevels(r.thinking_levels),
    defaultThinking: r.default_thinking || 'off',
    claudeCompat: modelType === 'chat' && !!r.claude_compat,
    anthropicBaseUrl: r.anthropic_base_url || '',
    anthropicEnabled: modelType === 'chat' && !!r.anthropic_enabled,
    responsesBaseUrl: r.responses_base_url || '',
    responsesEnabled: modelType === 'chat' && !!r.responses_enabled,
    contextLength: r.context_length || 0,
    devOnly: !!r.dev_only,
    enabled: !!r.enabled,
    sortOrder: r.sort_order,
    updatedAt: r.updated_at,
  }
}

adminRouter.get('/users', (req, res) => {
  const q = String(req.query.q || '')
    .trim()
    .toLowerCase()
  let rows = [...db.getStore().users].sort((a, b) => b.id - a.id)
  if (q) {
    rows = rows.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        u.oauth_id.includes(q) ||
        (u.admin_note || '').toLowerCase().includes(q),
    )
  }
  rows = rows.slice(0, 200)
  ok(res, rows.map((u) => publicUser(u, { admin: true })))
})

adminRouter.get('/users/:id', async (req, res) => {
  const u = getUserById(Number(req.params.id))
  if (!u) {
    fail(res, 404, '用户不存在')
    return
  }
  const s = db.getStore()
  const usage = (await db.readUsageLogs()).filter((l) => l.user_id === u.id).slice(-50).reverse()
  const ledger = (await db.readLedger()).filter((l) => l.user_id === u.id).slice(-50).reverse()
  const keys = s.api_keys
    .filter((k) => k.user_id === u.id)
    .map((k) => ({
      id: k.id,
      name: k.name,
      keyPrefix: k.key_prefix,
      allowedOrigins: k.allowed_origins,
      revokedAt: k.revoked_at,
      lastUsedAt: k.last_used_at,
      createdAt: k.created_at,
    }))
  ok(res, {
    user: publicUser(u, { admin: true }),
    keys,
    recentUsage: usage.map((l) => ({
      id: l.id,
      model: l.model_slug,
      tokens: l.total_tokens,
      promptTokens: l.prompt_tokens,
      cachedTokens: l.cached_tokens || 0,
      completionTokens: l.completion_tokens,
      costCents: l.cost_cents,
      status: l.status,
      clientMeta: l.client_meta,
      createdAt: l.created_at,
    })),
    recentLedger: ledger.map((l) => ({
      id: l.id,
      kind: l.kind,
      amountCents: l.amount_cents,
      balanceAfter: l.balance_after,
      note: l.note,
      createdAt: l.created_at,
    })),
  })
})

/** 增减余额（元，可为负） */
adminRouter.post('/users/:id/credit', async (req: any, res) => {
  try {
    const userId = Number(req.params.id)
    const yuan = Number(req.body?.amountYuan)
    const note = String(req.body?.note || '管理员充值').slice(0, 200)
    if (!Number.isFinite(yuan) || yuan === 0) {
      fail(res, 400, 'amountYuan 无效')
      return
    }
    const amountCents = Math.round(yuan * 100)
    const u = await creditUser(
      userId,
      amountCents,
      amountCents > 0 ? 'credit' : 'adjust',
      note,
      req.user.id,
    )
    ok(res, publicUser(u, { admin: true }))
  } catch (e) {
    fail(res, 400, e instanceof Error ? e.message : '操作失败')
  }
})

/** 设定余额绝对值（元） */
adminRouter.post('/users/:id/set-balance', async (req: any, res) => {
  try {
    const userId = Number(req.params.id)
    const yuan = Number(req.body?.balanceYuan)
    const note = String(req.body?.note || '管理员设定余额').slice(0, 200)
    if (!Number.isFinite(yuan) || yuan < 0) {
      fail(res, 400, 'balanceYuan 无效')
      return
    }
    const u = await setUserBalance(userId, Math.round(yuan * 100), note, req.user.id)
    ok(res, publicUser(u, { admin: true }))
  } catch (e) {
    fail(res, 400, e instanceof Error ? e.message : '操作失败')
  }
})

adminRouter.patch('/users/:id', async (req: any, res) => {
  const userId = Number(req.params.id)
  const u = getUserById(userId)
  if (!u) {
    fail(res, 404, '用户不存在')
    return
  }
  if (typeof req.body?.isAdmin === 'boolean') {
    if (userId === req.user.id && req.body.isAdmin === false) {
      fail(res, 400, '不能取消自己的管理员')
      return
    }
    u.is_admin = req.body.isAdmin ? 1 : 0
  }
  if (req.body?.adminNote != null) {
    u.admin_note = String(req.body.adminNote).slice(0, 500)
  }
  if (req.body?.rpmLimit != null) u.rpm_limit = normalizeLimit(req.body.rpmLimit)
  if (req.body?.maxConcurrent != null) u.max_concurrent = normalizeLimit(req.body.maxConcurrent)
  u.updated_at = now()
  await db.persist()
  ok(res, publicUser(u, { admin: true }))
})

adminRouter.get('/models', (_req, res) => {
  const rows = [...db.getStore().models].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
  ok(res, rows.map((r) => mapModelAdmin(r)))
})

adminRouter.post('/models', async (req, res) => {
  const b = req.body || {}
  const slug = String(b.slug || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
  if (!slug) {
    fail(res, 400, 'slug 必填')
    return
  }
  if (db.getStore().models.some((m) => m.slug === slug)) {
    fail(res, 400, 'slug 已存在')
    return
  }
  const t = now()
  const id = db.nextId('models')
  db.getStore().models.push({
    id,
    slug,
    display_name: String(b.displayName || slug),
    description: String(b.description || ''),
    badge: String(b.badge || ''),
    card_color: String(b.cardColor || '#0f172a'),
    model_type: normalizeModelType(b.modelType),
    upstream_api_format: normalizeUpstreamApiFormat(b.modelType, b.upstreamApiFormat),
    upstream_path_override: String(b.upstreamPathOverride || '').trim(),
    upstream_base_url: String(b.upstreamBaseUrl || '').replace(/\/$/, ''),
    upstream_model: String(b.upstreamModel || slug),
    upstream_api_key: String(b.upstreamApiKey || ''),
    anthropic_base_url: String(b.anthropicBaseUrl || '').replace(/\/$/, ''),
    anthropic_enabled: b.anthropicEnabled === true || b.anthropicEnabled === 1 ? 1 : 0,
    responses_base_url: String(b.responsesBaseUrl || '').replace(/\/$/, ''),
    responses_enabled: b.responsesEnabled === true || b.responsesEnabled === 1 ? 1 : 0,
    allowed_origins: String(b.allowedOrigins || ''),
    rpm_limit: normalizeLimit(b.rpmLimit),
    max_concurrent: normalizeLimit(b.maxConcurrent),
    input_price_per_1m: Number(b.inputPricePer1m) || 0,
    output_price_per_1m: Number(b.outputPricePer1m) || 0,
    cache_price_per_1m: Number(b.cachePricePer1m) || 0,
    multimodal_enabled: b.multimodalEnabled === true || b.multimodalEnabled === 1 ? 1 : 0,
    image_billing_mode:
      String(b.imageBillingMode || '').toLowerCase() === 'per_image' ? 'per_image' : 'token',
    image_price_per_1m: Number(b.imagePricePer1m) || 0,
    image_price_per_image: Number(b.imagePricePerImage) || 0,
    image_tokens_per_image: Math.max(0, Math.floor(Number(b.imageTokensPerImage) || 512)),
    thinking_enabled: b.thinkingEnabled === true || b.thinkingEnabled === 1 ? 1 : 0,
    thinking_levels:
      b.thinkingLevels != null
        ? JSON.stringify(parseThinkingLevels(String(b.thinkingLevels)))
        : '["off","low","medium","high"]',
    default_thinking: String(b.defaultThinking || 'off').trim() || 'off',
    claude_compat: b.claudeCompat === true || b.claudeCompat === 1 ? 1 : 0,
    context_length: normalizeContextLength(b.contextLength),
    dev_only: b.devOnly === true || b.devOnly === 1 ? 1 : 0,
    enabled: b.enabled === false ? 0 : 1,
    sort_order: Number(b.sortOrder) || 0,
    created_at: t,
    updated_at: t,
  })
  await db.persist()
  ok(res, { id, slug })
})

adminRouter.put('/models/:id', async (req, res) => {
  const id = Number(req.params.id)
  const row = db.getStore().models.find((m) => m.id === id)
  if (!row) {
    fail(res, 404, '模型不存在')
    return
  }
  const b = req.body || {}
  if (b.displayName != null) row.display_name = String(b.displayName)
  if (b.description != null) row.description = String(b.description)
  if (b.badge != null) row.badge = String(b.badge)
  if (b.cardColor != null) row.card_color = String(b.cardColor)
  if (b.modelType != null) row.model_type = normalizeModelType(b.modelType)
  if (b.upstreamApiFormat != null)
    row.upstream_api_format = normalizeUpstreamApiFormat(row.model_type, b.upstreamApiFormat)
  if (b.upstreamPathOverride != null) row.upstream_path_override = String(b.upstreamPathOverride).trim()
  if (b.upstreamBaseUrl != null) row.upstream_base_url = String(b.upstreamBaseUrl).replace(/\/$/, '')
  if (b.upstreamModel != null) row.upstream_model = String(b.upstreamModel)
  if (b.anthropicBaseUrl != null) row.anthropic_base_url = String(b.anthropicBaseUrl).replace(/\/$/, '')
  if (typeof b.anthropicEnabled === 'boolean') row.anthropic_enabled = b.anthropicEnabled ? 1 : 0
  if (b.responsesBaseUrl != null) row.responses_base_url = String(b.responsesBaseUrl).replace(/\/$/, '')
  if (typeof b.responsesEnabled === 'boolean') row.responses_enabled = b.responsesEnabled ? 1 : 0
  // 空字符串表示不修改已有密钥；显式 clearUpstreamApiKey 清空
  if (b.clearUpstreamApiKey === true) row.upstream_api_key = ''
  else if (b.upstreamApiKey != null && String(b.upstreamApiKey).length > 0) {
    row.upstream_api_key = String(b.upstreamApiKey)
  }
  if (b.allowedOrigins != null) row.allowed_origins = String(b.allowedOrigins)
  if (b.rpmLimit != null) row.rpm_limit = normalizeLimit(b.rpmLimit)
  if (b.maxConcurrent != null) row.max_concurrent = normalizeLimit(b.maxConcurrent)
  if (b.inputPricePer1m != null) row.input_price_per_1m = Number(b.inputPricePer1m)
  if (b.outputPricePer1m != null) row.output_price_per_1m = Number(b.outputPricePer1m)
  if (b.cachePricePer1m != null) row.cache_price_per_1m = Number(b.cachePricePer1m)
  if (typeof b.multimodalEnabled === 'boolean')
    row.multimodal_enabled = b.multimodalEnabled ? 1 : 0
  if (b.imageBillingMode != null) {
    row.image_billing_mode =
      String(b.imageBillingMode).toLowerCase() === 'per_image' ? 'per_image' : 'token'
  }
  if (b.imagePricePer1m != null) row.image_price_per_1m = Number(b.imagePricePer1m)
  if (b.imagePricePerImage != null) row.image_price_per_image = Number(b.imagePricePerImage)
  if (b.imageTokensPerImage != null) {
    row.image_tokens_per_image = Math.max(0, Math.floor(Number(b.imageTokensPerImage) || 0))
  }
  if (typeof b.thinkingEnabled === 'boolean') row.thinking_enabled = b.thinkingEnabled ? 1 : 0
  if (b.thinkingLevels != null) {
    row.thinking_levels = JSON.stringify(parseThinkingLevels(String(b.thinkingLevels)))
  }
  if (b.defaultThinking != null) {
    row.default_thinking = String(b.defaultThinking).trim() || 'off'
  }
  if (typeof b.claudeCompat === 'boolean') row.claude_compat = b.claudeCompat ? 1 : 0
  if (b.contextLength != null) row.context_length = normalizeContextLength(b.contextLength)
  if (typeof b.devOnly === 'boolean') row.dev_only = b.devOnly ? 1 : 0
  if (typeof b.enabled === 'boolean') row.enabled = b.enabled ? 1 : 0
  if (b.sortOrder != null) row.sort_order = Number(b.sortOrder)
  row.updated_at = now()
  await db.persist()
  ok(res, { id })
})

adminRouter.delete('/models/:id', async (req, res) => {
  const id = Number(req.params.id)
  const s = db.getStore()
  s.models = s.models.filter((m) => m.id !== id)
  await db.persist()
  ok(res, { id })
})

function upstreamAuthHeader(apiKey: string): Record<string, string> {
  const key = apiKey.trim()
  if (!key) return {}
  if (/^bearer\s+/i.test(key)) return { Authorization: key }
  return { Authorization: `Bearer ${key}` }
}

function probeModelRow(input: any) {
  return {
    id: 0,
    slug: input.upstreamModel,
    display_name: input.upstreamModel,
    description: '',
    badge: '',
    card_color: '',
    model_type: normalizeModelType(input.modelType || 'embedding'),
    upstream_api_format: input.upstreamApiFormat,
    upstream_path_override: input.upstreamPathOverride,
    upstream_base_url: input.base,
    upstream_model: input.upstreamModel,
    upstream_api_key: input.apiKey,
    anthropic_base_url: input.anthropicBaseUrl || '',
    anthropic_enabled: 0,
    responses_base_url: input.responsesBaseUrl || '',
    responses_enabled: 0,
    allowed_origins: '',
    rpm_limit: 0,
    max_concurrent: 0,
    input_price_per_1m: 0,
    output_price_per_1m: 0,
    cache_price_per_1m: 0,
    multimodal_enabled: 0,
    image_billing_mode: 'token' as const,
    image_price_per_1m: 0,
    image_price_per_image: 0,
    image_tokens_per_image: 512,
    thinking_enabled: 0,
    thinking_levels: '[]',
    default_thinking: 'off',
    claude_compat: 0,
    context_length: 0,
    dev_only: 0,
    enabled: 1,
    sort_order: 0,
    created_at: '',
    updated_at: '',
  }
}

/** 归一化打印 usage 字段（供探测前端展示），兼容 OpenAI/Anthropic/Responses 三种形状 */
function usageForDisplay(usage: unknown): Record<string, unknown> | null {
  if (!usage || typeof usage !== 'object') return null
  const u = usage as Record<string, any>
  const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? 0)
  const completion = Number(u.completion_tokens ?? u.output_tokens ?? 0)
  const total = Number(u.total_tokens ?? 0)
  const promptDetails = u.prompt_tokens_details ?? u.input_tokens_details ?? null
  const cached = Number(promptDetails?.cached_tokens ?? 0)
  const reasoning = Number(u.completion_tokens_details?.reasoning_tokens ?? 0)
  return {
    prompt,
    completion,
    total,
    cached,
    reasoning,
    found: prompt > 0 || completion > 0 || total > 0,
    source: 'upstream',
    raw: u,
  }
}

/** 从 rerank 上游 json 里抽取可以用于展示计费的 usage/meta 对象 */
function rerankProbeUsage(json: unknown): unknown {
  if (!json || typeof json !== 'object') return null
  const o = json as Record<string, any>
  if (o.usage) return o.usage
  if (o.meta && typeof o.meta === 'object') {
    const meta = o.meta as Record<string, any>
    if (meta.tokens && typeof meta.tokens === 'object') return meta.tokens
    if (meta.billed_units && typeof meta.billed_units === 'object') return meta.billed_units
  }
  return null
}

async function runUpstreamProbe(input: any) {
  const base = input.base.trim().replace(/\/$/, '')
  let path = modelUpstreamPath(input.modelType)
  let url = `${base}${path}`
  let payload: Record<string, unknown>

  if (input.modelType === 'embedding') {
    const probeRow = probeModelRow(input)
    path = modelUpstreamPath('embedding', probeRow)
    url = `${base}${path}`
    const texts = probeTextsFromPrompt(input.prompt)
    try {
      const built = buildEmbeddingUpstreamRequest(probeRow, {
        model: input.upstreamModel,
        input: texts.length === 1 ? texts[0] : texts,
      })
      payload = built.payload
      if (built.urlPath !== path) url = `${base}${built.urlPath}`
    } catch (e) {
      return {
        errorHttp: 400,
        message: e instanceof Error ? e.message : 'embedding 探测参数无效',
      }
    }
  } else if (input.modelType === 'image_generation') {
    payload = {
      model: input.upstreamModel,
      prompt: input.prompt,
      n: 1,
      size: '512x512',
    }
  } else if (input.modelType === 'rerank') {
    const probeRow = probeModelRow(input)
    path = rerankUpstreamPath(probeRow)
    url = `${base}${path}`
    const docs = probeTextsFromPrompt(input.prompt).slice(0, 3)
    try {
      const built = buildRerankUpstreamRequest(probeRow, {
        model: input.upstreamModel,
        query: input.prompt,
        documents: docs.length ? docs : ['示例文档一', '示例文档二'],
        top_n: 3,
        return_documents: true,
      })
      payload = built.payload
      if (built.urlPath !== path) url = `${base}${built.urlPath}`
    } catch (e) {
      return {
        errorHttp: 400,
        message: e instanceof Error ? e.message : 'rerank 探测参数无效',
      }
    }
  } else {
    payload = {
      model: input.upstreamModel,
      messages: [{ role: 'user', content: input.prompt }],
      max_tokens: input.maxTokens,
      stream: input.wantStream,
    }
    // DeepSeek 官方 API 不认 chat_template_kwargs（vLLM 私有扩展），塞了会 400 误报
    if (!isDeepSeekOfficialUpstream(base)) {
      payload.chat_template_kwargs = { enable_thinking: false }
    }
    if (input.wantStream) {
      payload.stream_options = { include_usage: true }
    }
  }

  const started = Date.now()
  let upstreamRes: globalThis.Response
  try {
    upstreamRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...upstreamAuthHeader(input.apiKey),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000),
    })
  } catch (e) {
    return {
      errorHttp: 502,
      message: `上游连接失败：${e instanceof Error ? e.message : String(e)}`,
    }
  }

  const elapsedMs = Date.now() - started
  const contentType = upstreamRes.headers.get('content-type') || ''

  if (input.modelType === 'embedding') {
    const text = await upstreamRes.text()
    let json: any = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    const probeRow = probeModelRow(input)
    const texts = probeTextsFromPrompt(input.prompt)
    const normalized = upstreamRes.ok
      ? normalizeEmbeddingToOpenAi(probeRow, json, input.upstreamModel, texts.length)
      : null
    const summary = summarizeEmbeddingProbe(normalized ?? json)
    return {
      data: {
        ok: upstreamRes.ok && summary.ok,
        mode: 'embedding',
        httpStatus: upstreamRes.status,
        elapsedMs,
        contentType,
        upstreamUrl: url,
        upstreamModel: input.upstreamModel,
        content:
          summary.dim != null
            ? `[${summary.count} vectors, dim=${summary.dim}]`
            : summary.count > 0
              ? `[${summary.count} vectors]`
              : '',
        usage: normalized?.usage ?? json?.usage ?? null,
        usageParsed: usageForDisplay(normalized?.usage ?? json?.usage),
        rawPreview: text.slice(0, 1500),
        rawTail: text.slice(-1200),
        error: upstreamRes.ok
          ? summary.ok
            ? null
            : '响应无有效 embedding 向量'
          : String(
              (json as any)?.error?.message || text.slice(0, 200) || `HTTP ${upstreamRes.status}`,
            ),
      },
    }
  }

  if (input.modelType === 'image_generation') {
    const text = await upstreamRes.text()
    let json: unknown = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    const imageCount = Array.isArray((json as any)?.data) ? (json as any).data.length : 0
    return {
      data: {
        ok: upstreamRes.ok && imageCount > 0,
        mode: 'image_generation',
        httpStatus: upstreamRes.status,
        elapsedMs,
        contentType,
        upstreamUrl: url,
        upstreamModel: input.upstreamModel,
        content: imageCount > 0 ? `[generated ${imageCount} image(s)]` : '',
        usage: (json as any)?.usage ?? null,
        usageParsed: usageForDisplay((json as any)?.usage),
        rawPreview: text.slice(0, 1500),
        rawTail: text.slice(-1200),
        error: upstreamRes.ok
          ? imageCount > 0
            ? null
            : '响应无 data 图片'
          : String(
              (json as any)?.error?.message || text.slice(0, 200) || `HTTP ${upstreamRes.status}`,
            ),
      },
    }
  }

  if (input.modelType === 'rerank') {
    const text = await upstreamRes.text()
    let json: unknown = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    const probeRow = probeModelRow(input)
    const normalized = upstreamRes.ok
      ? normalizeRerankToOpenAi(probeRow, json, input.upstreamModel, 1, Boolean(input.returnDocuments))
      : null
    const summary = summarizeRerankProbe(normalized ?? json)
    return {
      data: {
        ok: upstreamRes.ok && summary.ok,
        mode: 'rerank',
        httpStatus: upstreamRes.status,
        elapsedMs,
        contentType,
        upstreamUrl: url,
        upstreamModel: input.upstreamModel,
        content: summary.count > 0 ? `[${summary.count} 条重排结果]` : '',
        usage: normalized?.usage ?? null,
        usageParsed: usageForDisplay(
          normalized?.usage ?? rerankProbeUsage(json),
        ),
        rawPreview: text.slice(0, 1500),
        rawTail: text.slice(-1200),
        error: upstreamRes.ok
          ? summary.ok
            ? null
            : '响应无有效 results'
          : String(
              (json as any)?.error?.message || text.slice(0, 200) || `HTTP ${upstreamRes.status}`,
            ),
      },
    }
  }

  if (input.wantStream) {
    const text = await upstreamRes.text()
    let content = ''
    let reasoning = ''
    let usage: unknown = null
    let usageRaw = ''
    let chunkCount = 0
    let finishReason = ''
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const data = t.slice(5).trim()
      if (!data || data === '[DONE]') continue
      chunkCount += 1
      try {
        const j = JSON.parse(data)
        if (j.usage) {
          usage = j.usage
          usageRaw = data
        }
        const delta = j.choices?.[0]?.delta
        if (typeof delta?.content === 'string') content += delta.content
        if (typeof delta?.reasoning_content === 'string') reasoning += delta.reasoning_content
        const fr = j.choices?.[0]?.finish_reason
        if (fr) finishReason = String(fr)
      } catch {
        /* ignore partial */
      }
    }
    let errMsg: string | null = null
    if (!upstreamRes.ok) {
      try {
        errMsg = String(
          JSON.parse(text)?.error?.message || text.slice(0, 200) || `HTTP ${upstreamRes.status}`,
        )
      } catch {
        errMsg = text.slice(0, 200) || `HTTP ${upstreamRes.status}`
      }
    }
    // 解析检测到的 token 明细（供前端明确展示「从哪里读到的」「是否估算」）
    const usageParsed = usageForDisplay(usage)
    return {
      data: {
        ok: upstreamRes.ok && (chunkCount > 0 || content.length > 0 || Boolean(usage)),
        mode: 'stream',
        httpStatus: upstreamRes.status,
        elapsedMs,
        contentType,
        upstreamUrl: url,
        upstreamModel: input.upstreamModel,
        chunkCount,
        finishReason: finishReason || null,
        content: content.slice(0, 4000),
        reasoningContent: reasoning.slice(0, 2000) || null,
        usage,
        usageParsed,
        usageRaw: usageRaw || null,
        // 完整流原文（首尾各保留一段，方便看到尾部 usage chunk 在哪）
        rawPreview: text.slice(0, 1500),
        rawTail: text.slice(-1200),
        error: errMsg,
      },
    }
  }

  const text = await upstreamRes.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  const content = String((json as any)?.choices?.[0]?.message?.content ?? '')
  return {
    data: {
      ok: upstreamRes.ok && Boolean((json as any)?.choices),
      mode: 'json',
      httpStatus: upstreamRes.status,
      elapsedMs,
      contentType,
      upstreamUrl: url,
      upstreamModel: input.upstreamModel,
      finishReason: (json as any)?.choices?.[0]?.finish_reason ?? null,
      content: content.slice(0, 4000),
      reasoningContent: String((json as any)?.choices?.[0]?.message?.reasoning_content ?? '').slice(0, 4000) || null,
      usage: (json as any)?.usage ?? null,
      usageParsed: usageForDisplay((json as any)?.usage),
      usageRaw: text.trim() || null,
      rawPreview: text.slice(0, 1500),
      rawTail: text.slice(-1200),
      error: upstreamRes.ok
        ? null
        : String(
            (json as any)?.error?.message || text.slice(0, 200) || `HTTP ${upstreamRes.status}`,
          ),
    },
  }
}

function resolveProbeFromBody(
  b: any,
  row: any,
): { ok: true; input: any } | { ok: false; message: string } {
  const base = String(b.upstreamBaseUrl || row?.upstream_base_url || '')
    .trim()
    .replace(/\/$/, '')
  if (!base) return { ok: false, message: '未配置上游 Base URL' }
  const upstreamModel = String(b.upstreamModel || row?.upstream_model || row?.slug || '').trim()
  if (!upstreamModel) return { ok: false, message: '未配置上游模型名' }
  const modelType = normalizeModelType(b.modelType ?? row?.model_type)
  const wantStream = modelType === 'chat' ? Boolean(b.stream) : false
  const prompt = String(
    b.prompt ||
      (modelType === 'embedding'
        ? '你好世界\nhello world'
        : modelType === 'image_generation'
          ? 'a cute cat'
          : modelType === 'rerank'
            ? '苹果\n香蕉\n猕猴桃\n西瓜'
            : '你好，请用一句话介绍你自己。'),
  ).slice(0, 2000)
  const maxTokens = Math.min(256, Math.max(1, Number(b.maxTokens) || 64))
  const upstreamApiFormat = normalizeUpstreamApiFormat(
    modelType,
    b.upstreamApiFormat ?? row?.upstream_api_format,
  )
  const upstreamPathOverride = String(
    b.upstreamPathOverride ?? row?.upstream_path_override ?? '',
  ).trim()
  let apiKey = ''
  if (b.upstreamApiKey != null && String(b.upstreamApiKey).length > 0) {
    apiKey = String(b.upstreamApiKey)
  } else if (row) {
    apiKey = row.upstream_api_key || process.env.SSEAPI_UPSTREAM_API_KEY || ''
  } else {
    apiKey = process.env.SSEAPI_UPSTREAM_API_KEY || ''
  }
  return {
    ok: true,
    input: {
      base,
      upstreamModel,
      apiKey,
      wantStream,
      prompt,
      maxTokens,
      modelType,
      upstreamApiFormat,
      upstreamPathOverride,
    },
  }
}

/** 草稿探测（注册未保存也可测） */
adminRouter.post('/models/test', async (req, res) => {
  const resolved = resolveProbeFromBody(req.body || {}, null)
  if (!resolved.ok) {
    fail(res, 400, resolved.message)
    return
  }
  const result = await runUpstreamProbe(resolved.input)
  if (!('data' in result)) {
    fail(res, 502, result.message)
    return
  }
  ok(res, result.data)
})

/** 已保存模型探测；body 可覆盖上游字段 */
adminRouter.post('/models/:id/test', async (req, res) => {
  const id = Number(req.params.id)
  const row = db.getStore().models.find((m) => m.id === id)
  if (!row) {
    fail(res, 404, '模型不存在')
    return
  }
  const resolved = resolveProbeFromBody(req.body || {}, row)
  if (!resolved.ok) {
    fail(res, 400, resolved.message)
    return
  }
  const result = await runUpstreamProbe(resolved.input)
  if (!('data' in result)) {
    fail(res, 502, result.message)
    return
  }
  ok(res, result.data)
})

/**
 * 协议支持探测：判断目标上游是否原生支持 anthropic / responses。
 * body: { protocol:'anthropic'|'responses', baseUrl?, upstreamModel?, apiKey? }
 * baseUrl 缺省时用模型已保存的 anthropic_base_url / responses_base_url。
 */
adminRouter.post('/models/:id/test-protocol', async (req, res) => {
  const id = Number(req.params.id)
  const row = db.getStore().models.find((m) => m.id === id)
  if (!row) {
    fail(res, 404, '模型不存在')
    return
  }
  const b = req.body || {}
  const protocol = String(b.protocol || '').toLowerCase()
  if (protocol !== 'anthropic' && protocol !== 'responses') {
    fail(res, 400, 'protocol 必须为 anthropic 或 responses')
    return
  }
  const baseUrl = String(b.baseUrl ?? (protocol === 'anthropic' ? row.anthropic_base_url : row.responses_base_url) ?? '').trim()
  const openAiBaseUrl = String(row.upstream_base_url || '').trim()
  const upstreamModel = String(b.upstreamModel || row.upstream_model || row.slug || '').trim()
  const apiKey = b.apiKey != null && String(b.apiKey).length > 0 ? String(b.apiKey) : row.upstream_api_key || ''
  const result = await probeProtocolSupport({ baseUrl, openAiBaseUrl, protocol, upstreamModel, apiKey })
  ok(res, result)
})

adminRouter.get('/docs', (_req, res) => {
  const doc = db.getStore().docs
  ok(res, {
    title: doc.title,
    externalUrl: doc.external_url,
    updatedAt: doc.updated_at,
  })
})

adminRouter.put('/docs', async (req, res) => {
  const title = String(req.body?.title || 'API 文档').trim() || 'API 文档'
  const externalUrl = String(req.body?.externalUrl ?? req.body?.external_url ?? '').trim()
  if (!externalUrl) {
    fail(res, 400, '文档跳转链接必填')
    return
  }
  if (!/^https?:\/\//i.test(externalUrl)) {
    fail(res, 400, '文档链接须以 http:// 或 https:// 开头')
    return
  }
  const doc = db.getStore().docs
  doc.title = title
  doc.external_url = externalUrl
  doc.updated_at = now()
  await db.persist()
  ok(res, { title, externalUrl })
})

adminRouter.get('/stats', async (_req, res) => {
  const s = db.getStore()
  const from = Date.now() - 30 * 24 * 60 * 60 * 1000
  const recent = (await db.readUsageLogs()).filter((l) => new Date(l.created_at).getTime() >= from)
  const cost_cents = recent.reduce((a, l) => a + l.cost_cents, 0)
  const tokens = recent.reduce((a, l) => a + l.total_tokens, 0)
  const byModel: Record<string, { requests: number; tokens: number; costCents: number }> = {}
  for (const l of recent) {
    const k = l.model_slug || 'unknown'
    if (!byModel[k]) byModel[k] = { requests: 0, tokens: 0, costCents: 0 }
    byModel[k].requests += 1
    byModel[k].tokens += l.total_tokens
    byModel[k].costCents += l.cost_cents
  }
  ok(res, {
    users: s.users.length,
    activeKeys: s.api_keys.filter((k) => !k.revoked_at).length,
    enabledModels: s.models.filter((m) => m.enabled && m.upstream_base_url).length,
    last30d: { requests: recent.length, tokens, cost_cents, costYuan: centsToYuan(cost_cents) },
    byModel,
  })
})

adminRouter.get('/rate-limits', (_req, res) => {
  ok(res, mapRateLimitsPublic(getRateLimitsConfig()))
})

adminRouter.get('/rate-limits/status', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  ok(res, getRuntimeStatus())
})

adminRouter.put('/rate-limits', async (req, res) => {
  const b = req.body || {}
  const cfg = getRateLimitsConfig()
  if (typeof b.enabled === 'boolean') cfg.enabled = b.enabled ? 1 : 0
  if (b.defaultRpm != null) cfg.default_rpm = normalizeLimit(b.defaultRpm)
  if (b.defaultMaxConcurrent != null) cfg.default_max_concurrent = normalizeLimit(b.defaultMaxConcurrent)
  cfg.updated_at = now()
  db.getStore().rate_limits = cfg
  await db.persist()
  ok(res, mapRateLimitsPublic(cfg))
})
