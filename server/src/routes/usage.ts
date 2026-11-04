import { Router } from 'express'
import { db } from '../db.js'
import { authJwt, ok, requireAdmin, type AuthedRequest } from '../middleware/auth.js'
import { centsToYuan } from '../services/users.js'
import { modelTypeOf } from '../services/model-catalog.js'
import { checkDeveloper, userReqs, isDevPlatformConfigured } from '../services/dev-platform.js'

export const usageRouter = Router()
usageRouter.use(authJwt)

function sinceDays(days: number) {
  return Date.now() - days * 24 * 60 * 60 * 1000
}

/**
 * 把「模型类型」筛选翻译成 slug 列表（模型表很小，在 JS 里映射即可）。
 * 返回 undefined = 不按模型过滤；返回空数组 = 该类型下没有任何模型，
 * 查询应当恒为空（由 db.usageWhere 里的 1=0 保证）。
 */
function typeSlugsOf(filter: string[], modelTypeBySlug: Map<string, string>): string[] | undefined {
  if (!filter.length) return undefined
  const out: string[] = []
  for (const [slug, type] of modelTypeBySlug) if (filter.includes(type)) out.push(slug)
  return out
}

/** 用时区本地日期（YYYY-MM-DD）：优先本地时区，避免北京时间凌晨记录归到前一天 */
function localDay(iso: string): string {
  const d = new Date(iso)
  const offsetMin = -d.getTimezoneOffset()
  const shifted = new Date(d.getTime() + offsetMin * 60 * 1000)
  return shifted.toISOString().slice(0, 10)
}

/** 小时桶：YYYY-MM-DD HH:00（本地时区），用于按小时聚合 */
function localHour(iso: string): string {
  const d = new Date(iso)
  const offsetMin = -d.getTimezoneOffset()
  const shifted = new Date(d.getTime() + offsetMin * 60 * 1000)
  return shifted.toISOString().slice(0, 13) + ':00'
}

type AggregateTotals = {
  request_count: number
  prompt_tokens: number
  cached_tokens: number
  completion_tokens: number
  total_tokens: number
  cost_cents: number
  costYuan: number
  error_count: number
}

function emptyTotals(): AggregateTotals {
  return {
    request_count: 0,
    prompt_tokens: 0,
    cached_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cost_cents: 0,
    costYuan: 0,
    error_count: 0,
  }
}

/** 归一化时间范围（毫秒时间戳） */
function parseRange(days: number, fromIso?: string, toIso?: string): { from: number; to: number } {
  const to = toIso ? new Date(toIso).getTime() : Date.now()
  const fallbackFrom = sinceDays(days)
  const from = fromIso ? new Date(fromIso).getTime() : fallbackFrom
  return { from: Number.isFinite(from) ? from : fallbackFrom, to: Number.isFinite(to) ? to : Date.now() }
}

const VALID_GRANULARITIES = new Set(['day', 'hour', 'request'])

/**
 * 通用用量聚合查询。
 * query:
 *  - days      : 时间范围（天），默认 30
 *  - granularity: day | hour | request，默认 day
 *  - model     : model_slug 精确筛选（可逗号多个）
 *  - type      : chat | embedding | image_generation（可逗号多个）
 *  - status    : ok | error | 其他（可逗号多个，error 匹配所有非 ok）
 *  - modelType : 与 type 同义（兼容）
 *  - apiKeyId  : 按 API Key 筛选（仅管理员可看他人，普通用户只能看自己的 key）
 *  - from / to : ISO 时间，精确时间范围
 *  - page / page_size: request 颗粒度下分页
 */
usageRouter.get('/aggregate', async (req: AuthedRequest, res) => {
  const userId = req.user!.id
  const isAdmin = !!req.user!.is_admin
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30))
  const granularity = VALID_GRANULARITIES.has(String(req.query.granularity))
    ? String(req.query.granularity)
    : 'day'
  const { from, to } = parseRange(days, asStr(req.query.from), asStr(req.query.to))

  const modelFilter = splitCsv(req.query.model)
  const typeFilter = splitCsv(req.query.type || req.query.modelType)
  const statusFilter = splitCsv(req.query.status)
  // 请求方 key：普通用户只能看自己的 key；管理员可看指定用户（q）或他人
  const apiKeyIdFilter = req.query.apiKeyId ? Number(req.query.apiKeyId) : null
  const targetUserId = isAdmin && req.query.userId ? Number(req.query.userId) : userId

  const modelTypeBySlug = new Map<string, string>()
  for (const m of db.getStore().models) {
    modelTypeBySlug.set(m.slug, modelTypeOf(m))
  }

  // 过滤与聚合全部下推到 SQLite：明细行不再进内存，
  // 接口耗时与历史总量解耦（这是从 JSON 换成 SQLite 的核心目的）
  const q = {
    userId: targetUserId,
    from,
    to,
    modelSlugs: modelFilter.length ? modelFilter : typeSlugsOf(typeFilter, modelTypeBySlug),
    statuses: statusFilter,
    apiKeyId: apiKeyIdFilter ?? undefined,
  }

  const t = db.usageTotals(q)
  const totals: AggregateTotals = {
    request_count: t.request_count,
    prompt_tokens: t.prompt_tokens,
    cached_tokens: t.cached_tokens,
    completion_tokens: t.completion_tokens,
    total_tokens: t.total_tokens,
    cost_cents: t.cost_cents,
    costYuan: centsToYuan(t.cost_cents),
    error_count: t.error_count,
  }

  const tzOffsetMin = -new Date().getTimezoneOffset()

  /** 先把空桶铺满，保证趋势线连续，再用 SQL 的结果填进去 */
  const fillBuckets = (
    rows: Array<{ bucket: string; tokens: number; requests: number; cost_cents: number }>,
    unit: 'day' | 'hour',
  ) => {
    const bucketOf = unit === 'day' ? localDay : localHour
    const timeMap = new Map<string, { tokens: number; requests: number; cost_cents: number }>()
    const stepMs = unit === 'day' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000
    for (let ts = from; ts <= to; ts += stepMs) {
      const b = bucketOf(new Date(ts).toISOString())
      if (!timeMap.has(b)) timeMap.set(b, { tokens: 0, requests: 0, cost_cents: 0 })
    }
    for (const r of rows) {
      timeMap.set(r.bucket, { tokens: r.tokens, requests: r.requests, cost_cents: r.cost_cents })
    }
    return [...timeMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([bucket, v]) => ({ bucket, ...v, costYuan: centsToYuan(v.cost_cents) }))
  }

  const byTime =
    granularity === 'day' || granularity === 'hour'
      ? fillBuckets(db.usageByBucket(q, granularity, tzOffsetMin), granularity)
      : []

  // 固定按日桶（给趋势图，始终按 day，不受 granularity 影响）
  const daily = fillBuckets(db.usageByBucket(q, 'day', tzOffsetMin), 'day')

  const byModel = db.usageByModel(q).map((r) => ({
    model_slug: r.model_slug,
    model_type: modelTypeBySlug.get(r.model_slug) || 'unknown',
    tokens: r.tokens,
    cost_cents: r.cost_cents,
    requests: r.requests,
    errors: r.errors,
    costYuan: centsToYuan(r.cost_cents),
  }))

  const byStatus = db.usageByStatus(q).map((r) => ({ ...r, costYuan: centsToYuan(r.cost_cents) }))

  // —— request 颗粒度：明细分页 ——
  let items: any[] = []
  let page = 0
  let pageSize = 0
  let total = 0
  if (granularity === 'request') {
    page = Math.max(1, Number(req.query.page) || 1)
    pageSize = Math.min(200, Math.max(1, Number(req.query.page_size) || 50))
    total = db.countUsage(q)
    items = db
      .queryUsage({ ...q, orderDesc: true, limit: pageSize, offset: (page - 1) * pageSize })
      .map((r) => ({ ...r, costYuan: centsToYuan(r.cost_cents) }))
  }

  ok(res, {
    granularity,
    days,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    totals,
    daily,
    byTime,
    byModel,
    byStatus,
    request: { page, pageSize, total, items },
  })
})

/**
 * 管理台「个人 token 面板」：按用户聚合用量，并可下钻到单个用户。
 * query:
 *   - days      : 时间范围（天），默认 30
 *   - model     : 模型筛选
 *   - status    : ok | error
 *   - type      : 模型类型
 *   - userId    : 指定单个用户（返回 detail 明细）；无则按用户分组
 *   - page/page_size: userId 下的明细分页
 * 仅管理员可访问。
 */
usageRouter.get('/by-user', async (req: AuthedRequest, res) => {
  if (!req.user!.is_admin) {
    res.status(403).json({ code: 403, message: '需要管理员权限' })
    return
  }
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30))
  const { from, to } = parseRange(days, asStr(req.query.from), asStr(req.query.to))
  const modelFilter = splitCsv(req.query.model)
  const statusFilter = splitCsv(req.query.status)
  const typeFilter = splitCsv(req.query.type)
  const targetUserId = req.query.userId ? Number(req.query.userId) : null

  const modelTypeBySlug = new Map<string, string>()
  for (const m of db.getStore().models) {
    modelTypeBySlug.set(m.slug, modelTypeOf(m))
  }

  const s = db.getStore()
  const userById = new Map(s.users.map((u) => [u.id, u]))
  const userName = (id: number) => {
    const u = userById.get(id)
    return u ? u.name || `用户${id}` : `用户${id}`
  }
  const oauthIdOf = (id: number) => {
    const u = userById.get(id)
    return u ? u.oauth_id || '' : ''
  }

  const q = {
    from,
    to,
    modelSlugs: modelFilter.length ? modelFilter : typeSlugsOf(typeFilter, modelTypeBySlug),
    statuses: statusFilter,
  }

  // 总览汇总 + 按用户分组：都在 SQLite 里完成（全站 30 天可能上百万行，
  // 绝不能搬到 JS 里遍历）
  const t = db.usageTotals(q)
  const totals: AggregateTotals = {
    request_count: t.request_count,
    prompt_tokens: t.prompt_tokens,
    cached_tokens: t.cached_tokens,
    completion_tokens: t.completion_tokens,
    total_tokens: t.total_tokens,
    cost_cents: t.cost_cents,
    costYuan: centsToYuan(t.cost_cents),
    error_count: t.error_count,
  }

  let byUser = db.usageByUser(q).map((r) => ({
    user_id: r.user_id,
    name: userName(r.user_id),
    oauthId: oauthIdOf(r.user_id),
    requests: r.requests,
    tokens: r.tokens,
    prompt_tokens: r.prompt_tokens,
    completion_tokens: r.completion_tokens,
    cached_tokens: r.cached_tokens,
    cost_cents: r.cost_cents,
    errors: r.errors,
    costYuan: centsToYuan(r.cost_cents),
  }))

  let detail: { page: number; pageSize: number; total: number; items: any[] } | null = null
  if (targetUserId != null) {
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(200, Math.max(1, Number(req.query.page_size) || 50))
    const own = { ...q, userId: targetUserId }
    detail = {
      page,
      pageSize,
      total: db.countUsage(own),
      items: db
        .queryUsage({ ...own, orderDesc: true, limit: pageSize, offset: (page - 1) * pageSize })
        .map((r) => ({ ...r, costYuan: centsToYuan(r.cost_cents) })),
    }
  }

  // —— 开发者平台信息（可选，默认开启）：判定每个用户是否集市开发者 + 角色标签 ——
  // 仅当配置了开发者平台对接私钥时处理；失败不影响用量数据本体。
  const includeDev = req.query.withDev !== '0'
  let devByUser: Record<number, { isDeveloper: boolean; isAdminDev: boolean; roleLabel: string; developerUserId: number | null }> = {}
  let devChecked = false
  if (includeDev && isDevPlatformConfigured()) {
    devChecked = true
    await Promise.all(
      byUser.map(async (u) => {
        if (!u.oauthId) return
        try {
          const c = await checkDeveloper(u.oauthId)
          devByUser[u.user_id] = {
            isDeveloper: !!c.isDeveloper,
            isAdminDev: !!c.isAdmin,
            roleLabel: c.isAdmin ? '管理员' : c.isDeveloper ? '开发者' : '普通用户',
            developerUserId: c.userId ?? null,
          }
        } catch {
          devByUser[u.user_id] = {
            isDeveloper: false,
            isAdminDev: false,
            roleLabel: '普通用户',
            developerUserId: null,
          }
        }
      }),
    )
    byUser = byUser.map((u) => ({ ...u, dev: devByUser[u.user_id] || null }))
  } else {
    byUser = byUser.map((u) => ({ ...u, dev: null }))
  }

  ok(res, {
    days,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    totals,
    byUser,
    detail,
    devChecked,
  })
})

/** 透出 /logs 增加筛选：按状态/model/时间过滤，并透出完整字段（含 error 明细/prompt） */
usageRouter.get('/logs', async (req: AuthedRequest, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const pageSize = Math.min(200, Math.max(1, Number(req.query.page_size) || 20))
  const isAdmin = !!req.user!.is_admin
  // 管理员可看指定 userId 的日志；普通用户只能看自己
  const userId = isAdmin && req.query.userId ? Number(req.query.userId) : req.user!.id
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30))
  const modelFilter = splitCsv(req.query.model)
  const statusFilter = splitCsv(req.query.status)
  const typeFilter = splitCsv(req.query.type || req.query.modelType)
  const from = days > 0 ? sinceDays(days) : 0

  const modelTypeBySlug = new Map<string, string>()
  for (const m of db.getStore().models) {
    modelTypeBySlug.set(m.slug, modelTypeOf(m))
  }

  const q = {
    userId,
    from: from || undefined,
    modelSlugs: modelFilter.length ? modelFilter : typeSlugsOf(typeFilter, modelTypeBySlug),
    statuses: statusFilter,
  }
  const total = db.countUsage(q)
  const items = db
    .queryUsage({ ...q, orderDesc: true, limit: pageSize, offset: (page - 1) * pageSize })
    .map((r) => ({
      ...r,
      model_type: modelTypeBySlug.get(r.model_slug) || '',
      costYuan: centsToYuan(r.cost_cents),
    }))
  ok(res, { page, pageSize, total, items })
})

/**
 * 某平台用户的需求单（集市开发者职责）：按 api-platform 用户 id 查 oauth_id →
 * developers/check 拿开发者平台 userId → reqs.userReqs 拿需求列表。仅管理员。
 * GET /api/usage/by-user/:userId/reqs
 */
usageRouter.get('/by-user/:userId/reqs', requireAdmin, async (req: AuthedRequest, res) => {
  const userId = Number(req.params.userId)
  if (!Number.isFinite(userId) || userId <= 0) {
    res.status(400).json({ code: 400, message: 'userId 无效' })
    return
  }
  const u = db.getStore().users.find((x) => x.id === userId)
  if (!u) {
    res.status(404).json({ code: 404, message: '用户不存在' })
    return
  }
  if (!isDevPlatformConfigured()) {
    ok(res, { configured: false, isDeveloper: false, reqs: null, reqsError: '开发者平台未配置' })
    return
  }
  try {
    const c = await checkDeveloper(u.oauth_id)
    if (!c.found || (!c.isDeveloper && !c.isAdmin) || !c.userId) {
      ok(res, { configured: true, isDeveloper: false, reqs: { page: 1, pageSize: 0, total: 0, items: [] }, reqsError: null })
      return
    }
    const reqs = await userReqs(c.userId, { pageSize: 50 })
    ok(res, {
      configured: true,
      isDeveloper: true,
      isAdmin: !!c.isAdmin,
      roleLabel: c.isAdmin ? '管理员' : '开发者',
      userId: c.userId,
      reqs,
      reqsError: null,
    })
  } catch (e) {
    ok(res, { configured: true, isDeveloper: false, reqs: null, reqsError: String(e) })
  }
})

usageRouter.get('/summary', async (req: AuthedRequest, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30))
  const userId = req.user!.id
  const from = sinceDays(days)
  const q = { userId, from }

  const t = db.usageTotals(q)
  const totals = {
    prompt_tokens: t.prompt_tokens,
    cached_tokens: t.cached_tokens,
    completion_tokens: t.completion_tokens,
    total_tokens: t.total_tokens,
    cost_cents: t.cost_cents,
    request_count: t.request_count,
  }

  // 按本地日分桶（同样在 SQL 里 GROUP BY）
  const byDay = db
    .usageByBucket(q, 'day', -new Date().getTimezoneOffset())
    .map((r) => ({
      day: r.bucket,
      tokens: r.tokens,
      cost_cents: r.cost_cents,
      requests: r.requests,
      costYuan: centsToYuan(r.cost_cents),
    }))

  const byModel = db.usageByModel(q).map((r) => ({
    model_slug: r.model_slug,
    tokens: r.tokens,
    cost_cents: r.cost_cents,
    requests: r.requests,
    costYuan: centsToYuan(r.cost_cents),
  }))

  ok(res, {
    days,
    balanceCents: req.user!.balance_cents,
    balanceYuan: centsToYuan(req.user!.balance_cents),
    totals: { ...totals, costYuan: centsToYuan(totals.cost_cents) },
    byDay,
    byModel,
  })
})

function asStr(v: unknown): string | undefined {
  if (v == null) return undefined
  const s = String(v).trim()
  return s || undefined
}

function splitCsv(v: unknown): string[] {
  const s = asStr(v)
  if (!s) return []
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}
