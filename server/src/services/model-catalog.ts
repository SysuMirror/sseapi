import type { ModelRow } from '../db.js'
import { redactSensitiveFields } from './upstream-models.js'
import {
  EMBEDDING_API_FORMAT_LABELS,
  EMBEDDING_FORMAT_HINTS,
  embeddingApiFormatOf,
  embeddingUpstreamPath,
  normalizeEmbeddingApiFormat,
} from './embedding-adapter.js'
import {
  RERANK_API_FORMAT_LABELS,
  RERANK_FORMAT_HINTS,
  rerankApiFormatOf,
  rerankUpstreamPath,
  normalizeRerankApiFormat,
} from './rerank-adapter.js'

export type ModelType = 'chat' | 'embedding' | 'image_generation' | 'rerank'

/** 平台对外暴露的 chat 协议种类 */
export type ChatProtocol = 'openai' | 'anthropic' | 'responses'

export const CHAT_PROTOCOLS: ChatProtocol[] = ['openai', 'anthropic', 'responses']

export const CHAT_PROTOCOL_LABELS: Record<ChatProtocol, string> = {
  openai: 'OpenAI Chat Completions',
  anthropic: 'Anthropic Messages',
  responses: 'OpenAI Responses',
}

/** 各协议对应平台对外 /v1 路径 */
export const CHAT_PROTOCOL_PATHS: Record<ChatProtocol, string> = {
  openai: '/v1/chat/completions',
  anthropic: '/v1/messages',
  responses: '/v1/responses',
}

export const MODEL_TYPE_LABELS: Record<ModelType, string> = {
  chat: '对话 / Chat Completions',
  embedding: '向量 / Embeddings',
  image_generation: '生图 / Images Generations',
  rerank: '重排序 / Rerank',
}

export function normalizeModelType(v: unknown): ModelType {
  const s = String(v || 'chat')
    .trim()
    .toLowerCase()
  if (s === 'embedding' || s === 'embeddings' || s === 'embed') return 'embedding'
  if (
    s === 'image_generation' ||
    s === 'image' ||
    s === 'images' ||
    s === 'image_gen' ||
    s === 'text2img'
  ) {
    return 'image_generation'
  }
  if (s === 'rerank' || s === 'reranking' || s === 're-rank' || s === 'rank' || s === 'rerank_vl') {
    return 'rerank'
  }
  return 'chat'
}

/** 上游 OpenAI 兼容相对路径（不含 /v1 前缀） */
export function modelUpstreamPath(type: ModelType, row?: ModelRow): string {
  if (type === 'embedding' && row) return embeddingUpstreamPath(row)
  if (type === 'rerank' && row) return rerankUpstreamPath(row)
  switch (type) {
    case 'embedding':
      return '/embeddings'
    case 'image_generation':
      return '/images/generations'
    case 'rerank':
      return '/rerank'
    default:
      return '/chat/completions'
  }
}

/** 平台对外 /v1 路径 */
export function modelV1Path(type: ModelType): string {
  return `/v1${modelUpstreamPath(type)}`
}

export function modelTypeOf(row: ModelRow): ModelType {
  return normalizeModelType(row.model_type)
}

/**
 * 模型启用哪些 chat 协议出口。由显式开关决定：
 * - openai：恒启用（上游 base 有值时）
 * - anthropic：anthropic_enabled=1
 * - responses：responses_enabled=1
 */
export function enabledChatProtocols(m: ModelRow): ChatProtocol[] {
  const type = modelTypeOf(m)
  if (type !== 'chat') return []
  const out: ChatProtocol[] = []
  if (String(m.upstream_base_url || '').trim()) out.push('openai')
  if (m.anthropic_enabled) out.push('anthropic')
  if (m.responses_enabled) out.push('responses')
  return out
}

/** anthropic 协议是否有独立上游（有则透传，无则反代） */
export function anthropicHasOwnUpstream(m: ModelRow): boolean {
  return Boolean(String(m.anthropic_base_url || '').trim())
}

/** responses 协议是否有独立上游（有则透传，无则反代） */
export function responsesHasOwnUpstream(m: ModelRow): boolean {
  return Boolean(String(m.responses_base_url || '').trim())
}

/**
 * 该 chat 模型对外暴露的 /v1 端点列表（前端展示）。
 * viaOwnUpstream=true 表示有独立上游（透传）；false 表示走反代（chat 转换）。
 */
export function chatProtocolEndpoints(m: ModelRow): Array<{ protocol: ChatProtocol; path: string; label: string; viaOwnUpstream: boolean }> {
  return enabledChatProtocols(m).map((p) => ({
    protocol: p,
    path: CHAT_PROTOCOL_PATHS[p],
    label: CHAT_PROTOCOL_LABELS[p],
    viaOwnUpstream: p === 'openai' ? true : p === 'anthropic' ? anthropicHasOwnUpstream(m) : responsesHasOwnUpstream(m),
  }))
}

export function parseThinkingLevels(raw: string | undefined | null): string[] {
  if (!raw || !String(raw).trim()) return ['off', 'low', 'medium', 'high']
  const s = String(raw).trim()
  try {
    const parsed = JSON.parse(s) as unknown
    if (Array.isArray(parsed)) {
      const levels = parsed.map((x) => String(x).trim()).filter(Boolean)
      if (levels.length) return levels
    }
  } catch {
    /* fall through */
  }
  return s
    .split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
}

/** 归一化上下文长度：非负整数；0/空视为不限制 */
export function normalizeContextLength(v: unknown): number {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n) || n < 0) return 0
  return n
}

export function mapModelCapabilities(m: ModelRow) {
  const type = modelTypeOf(m)
  const thinking = type === 'chat' && !!m.thinking_enabled
  const vision = type === 'chat' && !!m.multimodal_enabled
  return {
    chat: type === 'chat',
    embedding: type === 'embedding',
    image_generation: type === 'image_generation',
    rerank: type === 'rerank',
    claude: type === 'chat' && !!m.claude_compat,
    anthropic: type === 'chat' && enabledChatProtocols(m).includes('anthropic'),
    responses: type === 'chat' && enabledChatProtocols(m).includes('responses'),
    vision,
    image_input: vision,
    image_output: type === 'image_generation',
    thinking,
    reasoning: thinking,
  }
}

export function mapModelThinking(m: ModelRow) {
  const type = modelTypeOf(m)
  if (type !== 'chat') {
    return {
      supported: false,
      levels: ['off'],
      default: 'off',
      request_key: 'chat_template_kwargs.enable_thinking',
      level_hint: '仅 chat 类型模型支持',
    }
  }
  const supported = !!m.thinking_enabled
  const levels = parseThinkingLevels(m.thinking_levels)
  const normalized = supported ? levels : ['off']
  const defRaw = (m.default_thinking || 'off').trim() || 'off'
  const def = normalized.includes(defRaw) ? defRaw : normalized[0] || 'off'
  return {
    supported,
    levels: normalized,
    default: def,
    request_key: 'chat_template_kwargs.enable_thinking',
    level_hint:
      'off 对应 enable_thinking:false；其余档位请按上游文档映射（常见为 true 或具体枚举）',
  }
}

export function mapModelMultimodal(m: ModelRow) {
  const type = modelTypeOf(m)
  const inputEnabled = type === 'chat' && !!m.multimodal_enabled
  const outputEnabled = type === 'image_generation'
  return {
    enabled: inputEnabled || outputEnabled,
    image_input: inputEnabled,
    image_output: outputEnabled,
    billing_mode: m.image_billing_mode === 'per_image' ? ('per_image' as const) : ('token' as const),
    image_price_per_1m: m.image_price_per_1m ?? 0,
    image_price_per_image: m.image_price_per_image ?? 0,
    image_tokens_per_image: m.image_tokens_per_image ?? 512,
  }
}

export function mapModelPricing(m: ModelRow) {
  const type = modelTypeOf(m)
  const base = {
    currency: 'CNY' as const,
    input_per_1m: m.input_price_per_1m,
    output_per_1m: m.output_price_per_1m,
    cache_per_1m: m.cache_price_per_1m ?? 0,
  }
  if (type === 'embedding') {
    return { ...base, billing_note: '按输入 token（usage.total_tokens）计费' }
  }
  if (type === 'rerank') {
    return { ...base, billing_note: '按 query + documents 输入 token 计费；上游未报 usage 时估算' }
  }
  if (type === 'image_generation') {
    return {
      ...base,
      image_per_unit: m.image_price_per_image ?? 0,
      billing_note: '默认按生成张数 × image_price_per_image；无单价时按 output token',
    }
  }
  return base
}

export function mapModelEndpoints(m: ModelRow, apiHost = '') {
  const type = modelTypeOf(m)
  const path = modelV1Path(type)
  const host = apiHost.replace(/\/$/, '')
  const embFmt = type === 'embedding' ? embeddingApiFormatOf(m) : null
  const rerankFmt = type === 'rerank' ? rerankApiFormatOf(m) : null
  // chat 模型多种协议端点
  const chatProtocols = type === 'chat' ? chatProtocolEndpoints(m) : []
  return {
    modelType: type,
    modelTypeLabel: MODEL_TYPE_LABELS[type],
    apiPath: path,
    apiUrl: host ? `${host}${path}` : path,
    upstreamPath: modelUpstreamPath(type, m),
    embeddingApiFormat: embFmt,
    embeddingApiFormatLabel: embFmt ? EMBEDDING_API_FORMAT_LABELS[embFmt] : undefined,
    embeddingFormatHint: embFmt ? EMBEDDING_FORMAT_HINTS[embFmt] : undefined,
    rerankApiFormat: rerankFmt,
    rerankApiFormatLabel: rerankFmt ? RERANK_API_FORMAT_LABELS[rerankFmt] : undefined,
    rerankFormatHint: rerankFmt ? RERANK_FORMAT_HINTS[rerankFmt] : undefined,
    chatProtocols,
  }
}

/** GET /v1/models：上游 OpenAI 字段原样合并，再叠加平台目录；id 始终为 slug */
export function mergeModelV1WithUpstream(
  m: ModelRow,
  upstream: Record<string, unknown> | null | undefined,
  apiHost = '',
) {
  const platform = mapModelV1(m, apiHost)
  if (!upstream || typeof upstream !== 'object') return platform

  const clean = redactSensitiveFields(upstream) as Record<string, unknown>
  const upstreamModelId = clean.id

  return {
    ...clean,
    ...platform,
    id: m.slug,
    upstream_model_id: upstreamModelId ?? m.upstream_model ?? m.slug,
    object: typeof clean.object === 'string' ? clean.object : 'model',
    created:
      typeof clean.created === 'number' && Number.isFinite(clean.created)
        ? clean.created
        : platform.created,
    owned_by: typeof clean.owned_by === 'string' ? clean.owned_by : platform.owned_by,
  }
}

/** @deprecated 使用 mergeModelV1WithUpstream；无上游时等价 */
export function mapModelV1(m: ModelRow, apiHost = '') {
  const catalog = mapModelConsole(m, false, apiHost)
  return {
    ...catalog,
    id: m.slug,
    object: 'model' as const,
    created: Math.floor(new Date(m.created_at).getTime() / 1000),
    owned_by: 'sseapi',
  }
}

/** 控制台 GET /api/models */
export function mapModelConsole(m: ModelRow, full = false, apiHost = '') {
  const type = modelTypeOf(m)
  const endpoints = mapModelEndpoints(m, apiHost)
  const base = {
    id: m.id,
    slug: m.slug,
    displayName: m.display_name,
    description: m.description,
    badge: m.badge,
    cardColor: m.card_color,
    modelType: type,
    modelTypeLabel: endpoints.modelTypeLabel,
    apiPath: endpoints.apiPath,
    apiUrl: endpoints.apiUrl,
    embeddingApiFormat: endpoints.embeddingApiFormat,
    embeddingApiFormatLabel: endpoints.embeddingApiFormatLabel,
    embeddingFormatHint: endpoints.embeddingFormatHint,
    rerankApiFormat: endpoints.rerankApiFormat,
    rerankApiFormatLabel: endpoints.rerankApiFormatLabel,
    rerankFormatHint: endpoints.rerankFormatHint,
    upstreamPathOverride: m.upstream_path_override || '',
    inputPricePer1m: m.input_price_per_1m,
    outputPricePer1m: m.output_price_per_1m,
    cachePricePer1m: m.cache_price_per_1m ?? 0,
    multimodalEnabled: type === 'chat' && !!m.multimodal_enabled,
    imageBillingMode: m.image_billing_mode === 'per_image' ? 'per_image' : 'token',
    imagePricePer1m: m.image_price_per_1m ?? 0,
    imagePricePerImage: m.image_price_per_image ?? 0,
    imageTokensPerImage: m.image_tokens_per_image ?? 512,
    thinkingEnabled: type === 'chat' && !!m.thinking_enabled,
    thinkingLevels: parseThinkingLevels(m.thinking_levels),
    defaultThinking: m.default_thinking || 'off',
    claudeCompat: type === 'chat' && !!m.claude_compat,
    anthropicEnabled: type === 'chat' && !!m.anthropic_enabled,
    responsesEnabled: type === 'chat' && !!m.responses_enabled,
    contextLength: m.context_length || 0,
    contextLimitEnabled: type === 'chat' && !!m.context_length,
    devOnly: !!m.dev_only,
    enabled: !!m.enabled,
    sortOrder: m.sort_order,
    hasOriginRestriction: Boolean(m.allowed_origins && String(m.allowed_origins).trim()),
    rpmLimit: m.rpm_limit || 0,
    maxConcurrent: m.max_concurrent || 0,
    capabilities: mapModelCapabilities(m),
    thinking: mapModelThinking(m),
    multimodal: mapModelMultimodal(m),
    pricing: mapModelPricing(m),
    chatProtocols: endpoints.chatProtocols || [],
    endpoints,
  }
  if (!full) return base
  return {
    ...base,
    upstreamBaseUrl: m.upstream_base_url,
    upstreamModel: m.upstream_model,
    anthropicBaseUrl: m.anthropic_base_url,
    responsesBaseUrl: m.responses_base_url,
    hasUpstreamApiKey: Boolean(m.upstream_api_key),
    allowedOrigins: m.allowed_origins || '',
    updatedAt: m.updated_at,
  }
}
