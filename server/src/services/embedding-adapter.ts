import type { ModelRow } from '../db.js'

/** 向量模型上游协议（平台对外始终 OpenAI /v1/embeddings） */
export type EmbeddingApiFormat = 'openai' | 'tei_inputs' | 'tei_texts'

export const EMBEDDING_API_FORMAT_LABELS: Record<EmbeddingApiFormat, string> = {
  openai: 'OpenAI /v1/embeddings（input + model）',
  tei_inputs: 'TEI 原生 /embed（inputs）',
  tei_texts: 'TEI 变体 /embed（texts）',
}

export const EMBEDDING_FORMAT_HINTS: Record<EmbeddingApiFormat, string> = {
  openai: '上游 Base URL 含 /v1，如 http://host:8080/v1',
  tei_inputs: '上游 Base URL 不含 /v1，如 http://host:23011；POST /embed {"inputs":"..."}',
  tei_texts: '上游 Base URL 不含 /v1，如 http://host:23011；POST /embed {"texts":[...]}',
}

export function normalizeEmbeddingApiFormat(v: unknown): EmbeddingApiFormat {
  const s = String(v || 'openai')
    .trim()
    .toLowerCase()
  if (s === 'tei_inputs' || s === 'tei' || s === 'inputs' || s === 'embed') return 'tei_inputs'
  if (s === 'tei_texts' || s === 'texts') return 'tei_texts'
  return 'openai'
}

export function embeddingApiFormatOf(model: ModelRow): EmbeddingApiFormat {
  return normalizeEmbeddingApiFormat(model.upstream_api_format)
}

/** 上游相对路径（不含 base） */
export function embeddingUpstreamPath(model: ModelRow): string {
  const override = String(model.upstream_path_override || '').trim()
  if (override) return override.startsWith('/') ? override : `/${override}`
  return embeddingApiFormatOf(model) === 'openai' ? '/embeddings' : '/embed'
}

export function openAiInputToStrings(input: unknown): string[] {
  if (input == null) return []
  if (typeof input === 'string') {
    const t = input.trim()
    return t ? [t] : []
  }
  if (Array.isArray(input)) {
    const out: string[] = []
    for (const item of input) {
      if (typeof item === 'string') {
        const t = item.trim()
        if (t) out.push(t)
      } else if (item != null) {
        out.push(String(item))
      }
    }
    return out
  }
  if (typeof input === 'number') return [String(input)]
  return []
}

export function buildEmbeddingUpstreamRequest(
  model: ModelRow,
  openAiBody: Record<string, unknown>,
): { urlPath: string; payload: Record<string, unknown> } {
  const fmt = embeddingApiFormatOf(model)
  const urlPath = embeddingUpstreamPath(model)
  const texts = openAiInputToStrings(openAiBody.input)
  if (!texts.length) {
    throw new Error('input 必填（字符串或字符串数组）')
  }

  if (fmt === 'openai') {
    const upstreamModel = model.upstream_model || model.slug
    const payload: Record<string, unknown> = { ...openAiBody, model: upstreamModel }
    delete payload.api_key
    return { urlPath, payload }
  }

  if (fmt === 'tei_texts') {
    return { urlPath, payload: { texts } }
  }

  return {
    urlPath,
    payload: { inputs: texts.length === 1 ? texts[0] : texts },
  }
}

function extractEmbeddingVectors(raw: unknown): number[][] {
  if (raw == null) return []

  if (Array.isArray(raw)) {
    if (!raw.length) return []
    const first = raw[0]
    if (typeof first === 'number') return [raw as number[]]
    if (Array.isArray(first)) return raw as number[][]
    if (first && typeof first === 'object' && Array.isArray((first as { embedding?: unknown }).embedding)) {
      return (raw as Array<{ embedding: number[] }>).map((x) => x.embedding)
    }
  }

  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    if (o.object === 'list' && Array.isArray(o.data)) {
      return extractEmbeddingVectors(o.data)
    }
    if (Array.isArray(o.embeddings)) return extractEmbeddingVectors(o.embeddings)
    if (Array.isArray(o.vectors)) return extractEmbeddingVectors(o.vectors)
    if (Array.isArray(o.data)) {
      const data = o.data as unknown[]
      if (
        data.every(
          (x) => x && typeof x === 'object' && Array.isArray((x as { embedding?: unknown }).embedding),
        )
      ) {
        return (data as Array<{ embedding: number[] }>).map((x) => x.embedding)
      }
      return extractEmbeddingVectors(data)
    }
  }

  return []
}

/** 将上游响应规范为 OpenAI Embeddings 形状（下游统一消费） */
export function normalizeEmbeddingToOpenAi(
  model: ModelRow,
  upstreamJson: unknown,
  modelSlug: string,
  inputCount: number,
): Record<string, unknown> {
  const fmt = embeddingApiFormatOf(model)

  if (
    fmt === 'openai' &&
    upstreamJson &&
    typeof upstreamJson === 'object' &&
    (upstreamJson as { object?: string }).object === 'list' &&
    Array.isArray((upstreamJson as { data?: unknown }).data)
  ) {
    return upstreamJson as Record<string, unknown>
  }

  const vectors = extractEmbeddingVectors(upstreamJson)
  const data = vectors.map((embedding, index) => ({
    object: 'embedding' as const,
    index,
    embedding,
  }))

  const usageRaw =
    upstreamJson && typeof upstreamJson === 'object'
      ? (upstreamJson as { usage?: { prompt_tokens?: number; total_tokens?: number } }).usage
      : null
  const promptTokens = Number(usageRaw?.prompt_tokens ?? usageRaw?.total_tokens ?? 0)
  const totalTokens = Number(usageRaw?.total_tokens ?? promptTokens)

  return {
    object: 'list',
    data,
    model: modelSlug,
    usage: {
      prompt_tokens: promptTokens > 0 ? promptTokens : Math.max(inputCount, 1),
      total_tokens: totalTokens > 0 ? totalTokens : Math.max(inputCount, 1),
    },
  }
}

/** 管理台探测：解析 dim / 条数 */
export function summarizeEmbeddingProbe(upstreamJson: unknown): {
  ok: boolean
  count: number
  dim: number | null
} {
  const vectors = extractEmbeddingVectors(upstreamJson)
  if (!vectors.length) {
    if (
      upstreamJson &&
      typeof upstreamJson === 'object' &&
      Array.isArray((upstreamJson as { data?: unknown }).data)
    ) {
      const data = (upstreamJson as { data: Array<{ embedding?: number[] }> }).data
      const dim = Array.isArray(data[0]?.embedding) ? data[0]!.embedding!.length : null
      return { ok: data.length > 0, count: data.length, dim }
    }
    return { ok: false, count: 0, dim: null }
  }
  return { ok: true, count: vectors.length, dim: vectors[0]?.length ?? null }
}

export function probeTextsFromPrompt(prompt: string): string[] {
  const lines = prompt
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
  if (lines.length > 1) return lines
  const parts = prompt
    .split(/[,，]/)
    .map((x) => x.trim())
    .filter(Boolean)
  if (parts.length > 1) return parts
  return [prompt.trim() || 'hello world']
}
