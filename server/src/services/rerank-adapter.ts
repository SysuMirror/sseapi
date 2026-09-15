import type { ModelRow } from '../db.js'

/**
 * 重排序（Rerank）模型上游协议。平台对外始终暴露 OpenAI 风格 /v1/rerank：
 * 请求 { model, query, documents, top_n?, return_documents? }
 * 响应统一 { object:'list', data:[{ index, score, document? }], usage:{ prompt_tokens, completion_tokens, total_tokens, cached_tokens } }
 */
export type RerankApiFormat =
  | 'openai' // SiliconFlow / 中转：POST /v1/rerank，返回 meta.tokens / meta.billed_units
  | 'cohere' // Cohere：POST /v1/rerank，返回 meta.billed_units
  | 'jina' // Jina：POST /v1/rerank，返回 usage.total_tokens
  | 'tei' // 本地 TEI：POST /rerank {query, texts}，返回 [{index, score}]
  | 'siliconflow' // SiliconFlow 专有：返回 meta.tokens / meta.billed_units（含图片/视频重排）

export const RERANK_API_FORMAT_LABELS: Record<RerankApiFormat, string> = {
  openai: 'OpenAI 兼容 /v1/rerank（model+query+documents）',
  siliconflow: 'SiliconFlow /rerank（meta.tokens / billed_units）',
  cohere: 'Cohere /v1/rerank（meta.billed_units）',
  jina: 'Jina /v1/rerank（results + usage.total_tokens）',
  tei: '本地 TEI /rerank（query + texts → [{index,score}]）',
}

export const RERANK_FORMAT_HINTS: Record<RerankApiFormat, string> = {
  openai: '上游 Base URL 含 /v1，如 http://host:8000/v1',
  siliconflow: 'Base URL 含 /v1，如 https://api.siliconflow.cn/v1',
  cohere: 'Base URL 含 /v1，如 https://api.cohere.com/v1',
  jina: 'Base URL 含 /v1，如 https://api.jina.ai/v1',
  tei: 'Base URL 不含 /v1，如 http://host:8801；POST /rerank {"query":..,"texts":[..]}',
}

export function normalizeRerankApiFormat(v: unknown): RerankApiFormat {
  const s = String(v || 'openai')
    .trim()
    .toLowerCase()
  if (s === 'siliconflow' || s === 'silicon' || s === 'sf') return 'siliconflow'
  if (s === 'cohere') return 'cohere'
  if (s === 'jina') return 'jina'
  if (s === 'tei' || s === 'tei_rerank') return 'tei'
  return 'openai'
}

export function rerankApiFormatOf(model: ModelRow): RerankApiFormat {
  return normalizeRerankApiFormat(model.upstream_api_format)
}

/** 上游相对路径（含 /v1 前缀与否取决于格式；tei 无 /v1） */
export function rerankUpstreamPath(model: ModelRow): string {
  const override = String(model.upstream_path_override || '').trim()
  if (override) return override.startsWith('/') ? override : `/${override}`
  return rerankApiFormatOf(model) === 'tei' ? '/rerank' : '/v1/rerank'
}

/** 把平台对外请求体（{model, query, documents, top_n?, ...}）适配成上游格式 */
export function buildRerankUpstreamRequest(
  model: ModelRow,
  openAiBody: Record<string, unknown>,
): { urlPath: string; payload: Record<string, unknown> } {
  const fmt = rerankApiFormatOf(model)
  const urlPath = rerankUpstreamPath(model)
  const query = String(openAiBody.query ?? '')
  const documents = toDocumentStrings(openAiBody.documents)
  if (!query.trim()) throw new Error('query 必填（检索/重排的查询文本）')
  if (!documents.length) throw new Error('documents 必填（至少一个待重排文档）')
  const upstreamModel = model.upstream_model || String(openAiBody.model || '')
  const topN = normTopN(openAiBody.top_n)
  const returnDocs = Boolean(openAiBody.return_documents ?? false)

  if (fmt === 'tei') {
    return { urlPath, payload: { query, texts: documents, top_n: undefined } }
  }
  if (fmt === 'cohere') {
    return {
      urlPath,
      payload: {
        model: upstreamModel,
        query,
        documents,
        top_n: topN,
        return_documents: returnDocs,
      },
    }
  }
  if (fmt === 'jina') {
    return {
      urlPath,
      payload: { model: upstreamModel, query, documents, top_n: topN, return_documents: returnDocs },
    }
  }
  // openai / siliconflow：透传原字段，仅替换 model 名并去掉平台内部字段
  const payload: Record<string, unknown> = { ...openAiBody, model: upstreamModel }
  delete payload.api_key
  if (topN != null) payload.top_n = topN
  return { urlPath, payload }
}

/** 重排结果（归一化后的 data 项） */
export type RerankResultItem = {
  index: number
  score: number
  document?: string
}

/** 抽取重排结果：兼容 results[{index, relevance_score, document: string|{text}}] 与 [{index,score}] 两种 */
function extractRerankResults(raw: unknown): RerankResultItem[] {
  if (Array.isArray(raw)) {
    return raw
      .map((x, i) => {
        const o = (x ?? {}) as Record<string, unknown>
        const index = Number(o.index ?? i)
        const score = Number(o.relevance_score ?? o.score ?? 0)
        const doc = documentText(o.document ?? o.text)
        return { index, score, document: doc }
      })
      .filter((x) => Number.isFinite(x.index) && Number.isFinite(x.score))
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    if (Array.isArray(o.results)) return extractRerankResults(o.results)
    if (Array.isArray(o.data)) return extractRerankResults(o.data)
  }
  return []
}

function documentText(d: unknown): string | undefined {
  if (d == null) return undefined
  if (typeof d === 'string') return d
  if (typeof d === 'object') {
    const o = d as Record<string, unknown>
    const t = o.text ?? o.content ?? o.document ?? o.value
    return t != null ? String(t) : undefined
  }
  return String(d)
}

/** 把 documents 规范化成字符串数组（string | array<string> | array<object>） */
export function toDocumentStrings(input: unknown): string[] {
  if (input == null) return []
  if (typeof input === 'string') return [input]
  if (Array.isArray(input)) {
    const out: string[] = []
    for (const item of input) {
      if (item == null) continue
      if (typeof item === 'string') out.push(item)
      else if (typeof item === 'number') out.push(String(item))
      else if (typeof item === 'object') {
        const o = item as Record<string, unknown>
        const t = o.text ?? o.document ?? o.content ?? String(item)
        out.push(String(t))
      }
    }
    return out
  }
  return [String(input)]
}

function normTopN(v: unknown): number | undefined {
  if (v == null) return undefined
  const n = Number(v)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined
}

/** 从上游 usage/meta 提取 token 计费（兼容多格式） */
function extractUsage(raw: unknown): {
  prompt: number
  completion: number
  cached: number
  found: boolean
} {
  if (!raw || typeof raw !== 'object') return { prompt: 0, completion: 0, cached: 0, found: false }
  const o = raw as Record<string, any>

  // 1) usage.{} —— OpenAI 兼容
  const u = o.usage && typeof o.usage === 'object' ? o.usage : null
  if (u) {
    const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? 0)
    const completion = Number(u.completion_tokens ?? u.output_tokens ?? 0)
    const total = Number(u.total_tokens ?? 0)
    const cached = Number(u.prompt_tokens_details?.cached_tokens ?? 0)
    const val = {
      prompt: Number.isFinite(prompt) ? Math.max(0, prompt) : 0,
      completion: Number.isFinite(completion) ? Math.max(0, completion) : 0,
      cached: Number.isFinite(cached) ? Math.max(0, cached) : 0,
      found: false,
    }
    val.found = val.prompt > 0 || val.completion > 0 || total > 0
    return val
  }

  // 2) meta.tokens / meta.billed_units —— SiliconFlow / Cohere
  const meta = o.meta && typeof o.meta === 'object' ? (o.meta as Record<string, any>) : null
  const tokensMeta = meta?.tokens && typeof meta.tokens === 'object' ? meta.tokens : null
  const billed = meta?.billed_units && typeof meta.billed_units === 'object' ? meta.billed_units : null
  const source = tokensMeta || billed
  if (source) {
    const prompt = Number(source.input_tokens ?? 0)
    const completion = Number(source.output_tokens ?? 0)
    const val = {
      prompt: Number.isFinite(prompt) ? Math.max(0, prompt) : 0,
      completion: Number.isFinite(completion) ? Math.max(0, completion) : 0,
      cached: 0,
      found: false,
    }
    val.found = val.prompt > 0 || val.completion > 0
    return val
  }
  return { prompt: 0, completion: 0, cached: 0, found: false }
}

/** 把上游响应归一化为平台统一 OpenAI 风格（含 usage 供计费） */
export function normalizeRerankToOpenAi(
  model: ModelRow,
  upstreamJson: unknown,
  modelSlug: string,
  fallbackPrompt: number,
  returnDocs: boolean,
): Record<string, unknown> {
  const results = extractRerankResults(upstreamJson)
  // 已带 document 时直接透传；否则按 return_documents 决定
  const data = results.map((r) => {
    const item: Record<string, unknown> = { index: r.index, score: r.score }
    if (returnDocs || r.document != null) item.document = r.document ?? ''
    return item
  })

  const usage = extractUsage(upstreamJson)
  const promptTokens = usage.prompt > 0 ? usage.prompt : Math.max(fallbackPrompt, 1)
  const completionTokens = usage.completion
  return {
    object: 'list',
    model: modelSlug,
    data,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      cached_tokens: usage.cached,
    },
  }
}

/** 管理台探测：解析命中条数 / 是否有分数 */
export function summarizeRerankProbe(upstreamJson: unknown): { ok: boolean; count: number } {
  const results = extractRerankResults(upstreamJson)
  return { ok: results.length > 0, count: results.length }
}
