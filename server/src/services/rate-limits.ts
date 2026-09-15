import type { Response } from 'express'
import { db, type ApiKeyRow, type ModelRow, type RateLimitsConfig, type UserRow } from '../db.js'
import type { AuthedRequest } from '../middleware/auth.js'

export type { RateLimitsConfig }

function fallbackRateLimitsConfig(): RateLimitsConfig {
  const envInt = (key: string, fb: number) => {
    const v = Number(process.env[key])
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : fb
  }
  return {
    enabled: envInt('SSEAPI_RATE_LIMIT_ENABLED', 1) ? 1 : 0,
    default_rpm: envInt('SSEAPI_DEFAULT_RPM', 60),
    default_max_concurrent: envInt('SSEAPI_DEFAULT_MAX_CONCURRENT', 2),
    updated_at: new Date().toISOString(),
  }
}

type LimitCheck = {
  label: string
  rpmKey: string
  concKey: string
  rpm: number
  maxConcurrent: number
}

const WINDOW_MS = 60_000
const rpmBuckets = new Map<string, number[]>()
const concurrentCounts = new Map<string, number>()

// ---- 实时并发观察（面板展示） ----
// 与「限流闸门」分离：这里只记录当前在做的事，不做拦截。
// 维度：全局 / 端点 / 模型 / 用户 / 密钥，均记录「当前数」。
const endpointActive = new Map<string, number>()
const globalActive = new Map<string, number>() // key 固定为 'all'

function ensureEndpointActive(name: string) {
  if (!endpointActive.has(name)) endpointActive.set(name, 0)
}

/** 标记某端点有一个请求进入；返回释放函数。endpointName 如 chat/completions */
export function trackEndpoint(endpointName: string) {
  const key = endpointName || 'unknown'
  ensureEndpointActive(key)
  endpointActive.set(key, (endpointActive.get(key) || 0) + 1)
  globalActive.set('all', (globalActive.get('all') || 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const curE = endpointActive.get(key) || 0
    if (curE <= 1) endpointActive.delete(key)
    else endpointActive.set(key, curE - 1)
    const curG = globalActive.get('all') || 0
    if (curG <= 1) globalActive.delete('all')
    else globalActive.set('all', curG - 1)
  }
}

/** 面板：当前各维度并发 */
export function getRuntimeStatus() {
  const s = db.getStore()
  const cfg = getRateLimitsConfig()
  const activeByEndpoint: Record<string, number> = {}
  for (const [k, v] of endpointActive) activeByEndpoint[k] = v

  const modelMap: Record<string, { current: number; limit: number }> = {}
  const userMap: Record<string, { current: number; limit: number }> = {}
  const keyMap: Record<string, { current: number; limit: number }> = {}
  for (const [k, v] of concurrentCounts) {
    if (k.startsWith('conc:model:')) {
      modelMap[k.slice('conc:model:'.length)] = { current: v, limit: 0 }
    } else if (k.startsWith('conc:user:')) {
      userMap[k.slice('conc:user:'.length)] = { current: v, limit: 0 }
    } else if (k.startsWith('conc:key:')) {
      keyMap[k.slice('conc:key:'.length)] = { current: v, limit: 0 }
    }
  }
  // 上限来自各自行配置；已删除/未配置的补 0
  for (const m of s.models) {
    const id = String(m.slug)
    if (!modelMap[id]) modelMap[id] = { current: 0, limit: normalizeLimit(m.max_concurrent) }
    else modelMap[id].limit = normalizeLimit(m.max_concurrent)
  }
  for (const u of s.users) {
    const id = String(u.id)
    if (!userMap[id]) userMap[id] = { current: 0, limit: normalizeLimit(u.max_concurrent) }
    else userMap[id].limit = normalizeLimit(u.max_concurrent)
  }
  for (const k of s.api_keys) {
    const id = String(k.id)
    if (!keyMap[id]) keyMap[id] = { current: 0, limit: normalizeLimit(k.max_concurrent) }
    else keyMap[id].limit = normalizeLimit(k.max_concurrent)
  }

  const userNameOf = (id: string) => {
    const u = s.users.find((x) => String(x.id) === id)
    return u ? u.name || `用户${id}` : `用户${id}`
  }
  const activeUsers = Object.entries(userMap)
    .map(([id, v]) => ({ id, name: userNameOf(id), current: v.current, limit: v.limit }))
    .filter((u) => u.current > 0)
    .sort((a, b) => b.current - a.current)

  return {
    global: {
      current: globalActive.get('all') || 0,
      limit: cfg.enabled === 1 ? 0 : 0,
      enabled: cfg.enabled === 1,
    },
    endpoints: Object.entries(activeByEndpoint)
      .map(([name, cur]) => ({ name, current: cur }))
      .sort((a, b) => b.current - a.current),
    models: Object.entries(modelMap)
      .map(([slug, v]) => ({ slug, current: v.current, limit: v.limit }))
      .sort((a, b) => b.current - a.current),
    users: Object.entries(userMap)
      .map(([id, v]) => ({ id, name: userNameOf(id), current: v.current, limit: v.limit }))
      .sort((a, b) => b.current - a.current),
    activeUsers,
    keys: Object.entries(keyMap)
      .map(([id, v]) => ({ id, current: v.current, limit: v.limit }))
      .sort((a, b) => b.current - a.current),
    defaults: { rpm: normalizeLimit(cfg.default_rpm), maxConcurrent: normalizeLimit(cfg.default_max_concurrent) },
  }
}

export function getRateLimitsConfig(): RateLimitsConfig {
  const s = db.getStore() as { rate_limits?: RateLimitsConfig }
  const cfg = s.rate_limits
  if (!cfg) return fallbackRateLimitsConfig()
  return {
    enabled: cfg.enabled ? 1 : 0,
    default_rpm: normalizeLimit(cfg.default_rpm),
    default_max_concurrent: normalizeLimit(cfg.default_max_concurrent),
    updated_at: cfg.updated_at || new Date().toISOString(),
  }
}

export function normalizeLimit(v: unknown): number {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(n, 100_000)
}

export function isRateLimitEnabled(): boolean {
  return getRateLimitsConfig().enabled === 1
}

function resolveRpm(entityLimit: number | undefined | null): number {
  // 0 = 该层不设单独上限（不参与 min），由默认值兜底
  return normalizeLimit(entityLimit)
}

function resolveConcurrent(entityLimit: number | undefined | null): number {
  return normalizeLimit(entityLimit)
}

function buildChecks(
  user: UserRow,
  keyRow: ApiKeyRow | undefined,
  model: ModelRow | undefined,
): LimitCheck[] {
  const cfg = getRateLimitsConfig()
  const checks: LimitCheck[] = [
    {
      label: '用户',
      rpmKey: `rpm:user:${user.id}`,
      concKey: `conc:user:${user.id}`,
      rpm: resolveRpm(user.rpm_limit),
      maxConcurrent: resolveConcurrent(user.max_concurrent),
    },
  ]
  if (keyRow) {
    checks.push({
      label: '密钥',
      rpmKey: `rpm:key:${keyRow.id}`,
      concKey: `conc:key:${keyRow.id}`,
      rpm: resolveRpm(keyRow.rpm_limit),
      maxConcurrent: resolveConcurrent(keyRow.max_concurrent),
    })
  }
  if (model) {
    checks.push({
      label: '模型',
      rpmKey: `rpm:model:${model.slug}`,
      concKey: `conc:model:${model.slug}`,
      rpm: resolveRpm(model.rpm_limit),
      maxConcurrent: resolveConcurrent(model.max_concurrent),
    })
  }

  // 默认值仅在「没有任何一层显式设置」时兜底。
  // 若某层显式设置了更高值（如模型=100），默认值（=2）不会再压低它。
  const anyRpm = checks.some((c) => c.rpm > 0)
  const anyConc = checks.some((c) => c.maxConcurrent > 0)
  const result = checks.filter((c) => c.rpm > 0 || c.maxConcurrent > 0)
  if (result.length === 0) return result
  if (!anyRpm && cfg.default_rpm > 0) {
    result.push({
      label: '全局限流',
      rpmKey: 'rpm:default',
      concKey: 'conc:default',
      rpm: cfg.default_rpm,
      maxConcurrent: 0,
    })
  }
  if (!anyConc && cfg.default_max_concurrent > 0) {
    result.push({
      label: '全局限流',
      rpmKey: 'rpm:default',
      concKey: 'conc:default',
      rpm: 0,
      maxConcurrent: cfg.default_max_concurrent,
    })
  }
  return result
}

function pruneRpm(key: string, now: number): number[] {
  const prev = rpmBuckets.get(key) || []
  const next = prev.filter((t) => now - t < WINDOW_MS)
  rpmBuckets.set(key, next)
  return next
}

function tryConsumeRpm(key: string, limit: number): { ok: true } | { ok: false; retryAfter: number } {
  if (limit <= 0) return { ok: true }
  const now = Date.now()
  const times = pruneRpm(key, now)
  if (times.length >= limit) {
    const oldest = times[0] ?? now
    const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000))
    return { ok: false, retryAfter }
  }
  times.push(now)
  rpmBuckets.set(key, times)
  return { ok: true }
}

function rollbackRpm(key: string) {
  const times = rpmBuckets.get(key)
  if (!times?.length) return
  times.pop()
  if (!times.length) rpmBuckets.delete(key)
  else rpmBuckets.set(key, times)
}

function tryAcquireConcurrent(key: string, limit: number): boolean {
  if (limit <= 0) return true
  const cur = concurrentCounts.get(key) || 0
  if (cur >= limit) return false
  concurrentCounts.set(key, cur + 1)
  return true
}

export function releaseConcurrent(key: string) {
  const cur = concurrentCounts.get(key) || 0
  if (cur <= 1) concurrentCounts.delete(key)
  else concurrentCounts.set(key, cur - 1)
}

function send429(res: Response, message: string, retryAfter: number) {
  res.setHeader('Retry-After', String(retryAfter))
  res.status(429).json({
    error: {
      message,
      type: 'rate_limit_exceeded',
      code: 'rate_limit_exceeded',
    },
  })
}

/**
 * 在 /v1 代理入口强校验 RPM 与并发；失败时已写 429 响应。
 * @returns true=放行；false=已拒绝
 */
export function enforceRateLimits(req: AuthedRequest, res: Response, modelSlug?: string): boolean {
  if (!isRateLimitEnabled()) return true

  const user = req.user
  if (!user) return true

  const store = db.getStore()
  const keyRow = store.api_keys.find((k) => k.id === req.apiKeyId)
  const model = modelSlug ? store.models.find((m) => m.slug === modelSlug) : undefined
  const checks = buildChecks(user, keyRow, model)
  if (!checks.length) return true

  const consumedRpm: string[] = []
  for (const c of checks) {
    if (c.rpm <= 0) continue
    const r = tryConsumeRpm(c.rpmKey, c.rpm)
    if (!r.ok) {
      for (const k of consumedRpm) rollbackRpm(k)
      send429(res, `${c.label}请求过于频繁（RPM ${c.rpm}）`, r.retryAfter)
      return false
    }
    consumedRpm.push(c.rpmKey)
  }

  const acquiredConc: string[] = []
  for (const c of checks) {
    if (c.maxConcurrent <= 0) continue
    if (!tryAcquireConcurrent(c.concKey, c.maxConcurrent)) {
      for (const k of consumedRpm) rollbackRpm(k)
      for (const k of acquiredConc) releaseConcurrent(k)
      send429(res, `${c.label}并发已满（上限 ${c.maxConcurrent}）`, 1)
      return false
    }
    acquiredConc.push(c.concKey)
  }

  if (acquiredConc.length) {
    let released = false
    const releaseAll = () => {
      if (released) return
      released = true
      for (const k of acquiredConc) releaseConcurrent(k)
    }
    res.once('close', releaseAll)
    res.once('finish', releaseAll)
  }

  return true
}

export function mapRateLimitsPublic(cfg: RateLimitsConfig) {
  return {
    enabled: cfg.enabled === 1,
    defaultRpm: cfg.default_rpm,
    defaultMaxConcurrent: cfg.default_max_concurrent,
    updatedAt: cfg.updated_at,
  }
}
