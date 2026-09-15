import type { ModelRow } from '../db.js'

const LIST_CACHE_TTL_MS = Math.max(
  5_000,
  Number(process.env.SSEAPI_UPSTREAM_MODELS_CACHE_MS) || 60_000,
)

type UpstreamModel = Record<string, unknown>

type CacheEntry = {
  expiresAt: number
  list: UpstreamModel[]
  byId: Map<string, UpstreamModel>
}

const listCache = new Map<string, CacheEntry>()

function upstreamAuthHeader(model: ModelRow): Record<string, string> {
  const key = (model.upstream_api_key || process.env.SSEAPI_UPSTREAM_API_KEY || '').trim()
  if (!key) return {}
  if (/^bearer\s+/i.test(key)) return { Authorization: key }
  return { Authorization: `Bearer ${key}` }
}

/** 从上游对象中剔除可能泄露凭据或内网的字段 */
const SENSITIVE_KEY = /(?:api[_-]?key|secret|password|private[_-]?key|access[_-]?key|authorization|credential|token_hash)/i

export function redactSensitiveFields<T>(value: T): T {
  if (value == null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveFields(item)) as T
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(k)) continue
    out[k] = redactSensitiveFields(v)
  }
  return out as T
}

function cacheKey(model: ModelRow): string {
  const base = String(model.upstream_base_url || '')
    .trim()
    .replace(/\/$/, '')
  const key = (model.upstream_api_key || process.env.SSEAPI_UPSTREAM_API_KEY || '').trim()
  return `${base}::${key}`
}

function indexUpstreamList(list: UpstreamModel[]): Map<string, UpstreamModel> {
  const byId = new Map<string, UpstreamModel>()
  for (const item of list) {
    const id = String(item?.id ?? '').trim()
    if (id) byId.set(id, item)
  }
  return byId
}

async function fetchUpstreamModelList(model: ModelRow): Promise<UpstreamModel[]> {
  const base = String(model.upstream_base_url || '')
    .trim()
    .replace(/\/$/, '')
  if (!base) return []

  const ck = cacheKey(model)
  const hit = listCache.get(ck)
  if (hit && hit.expiresAt > Date.now()) return hit.list

  const url = `${base}/models`
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...upstreamAuthHeader(model),
      },
      signal: AbortSignal.timeout(Math.min(30_000, Number(process.env.SSEAPI_UPSTREAM_TIMEOUT_MS) || 15_000)),
    })
    if (!res.ok) return hit?.list ?? []
    const json = (await res.json()) as { data?: unknown; object?: string }
    const list = Array.isArray(json?.data)
      ? (json.data as UpstreamModel[])
      : json && typeof json === 'object' && json.object === 'model'
        ? [json as UpstreamModel]
        : []
    listCache.set(ck, {
      expiresAt: Date.now() + LIST_CACHE_TTL_MS,
      list,
      byId: indexUpstreamList(list),
    })
    return list
  } catch {
    return hit?.list ?? []
  }
}

function lookupInCache(model: ModelRow, upstreamName: string): UpstreamModel | null {
  const hit = listCache.get(cacheKey(model))
  if (!hit) return null
  if (hit.expiresAt <= Date.now()) return null
  return hit.byId.get(upstreamName) ?? null
}

async function fetchUpstreamModelDirect(
  model: ModelRow,
  upstreamName: string,
): Promise<UpstreamModel | null> {
  const base = String(model.upstream_base_url || '')
    .trim()
    .replace(/\/$/, '')
  if (!base || !upstreamName) return null
  const url = `${base}/models/${encodeURIComponent(upstreamName)}`
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...upstreamAuthHeader(model),
      },
      signal: AbortSignal.timeout(Math.min(30_000, Number(process.env.SSEAPI_UPSTREAM_TIMEOUT_MS) || 15_000)),
    })
    if (!res.ok) return null
    const json = (await res.json()) as unknown
    if (json && typeof json === 'object') return json as UpstreamModel
  } catch {
    /* ignore */
  }
  return null
}

/** 按 upstream_model 解析上游 OpenAI model 对象（列表缓存 + 单条 retrieve） */
export async function resolveUpstreamModelEntry(model: ModelRow): Promise<UpstreamModel | null> {
  const upstreamName = String(model.upstream_model || model.slug || '').trim()
  if (!upstreamName) return null

  const cached = lookupInCache(model, upstreamName)
  if (cached) return cached

  const list = await fetchUpstreamModelList(model)
  const fromList = list.find((m) => String(m?.id ?? '') === upstreamName)
  if (fromList) return fromList

  return fetchUpstreamModelDirect(model, upstreamName)
}

export async function prefetchUpstreamLists(models: ModelRow[]): Promise<void> {
  const seen = new Set<string>()
  await Promise.all(
    models.map(async (m) => {
      const ck = cacheKey(m)
      if (seen.has(ck)) return
      seen.add(ck)
      await fetchUpstreamModelList(m)
    }),
  )
}

export function pickUpstreamFromList(
  list: UpstreamModel[],
  upstreamName: string,
): UpstreamModel | null {
  return list.find((m) => String(m?.id ?? '') === upstreamName) ?? null
}

export { fetchUpstreamModelList }
