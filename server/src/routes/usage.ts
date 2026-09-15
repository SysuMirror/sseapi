import { Router } from 'express'
import { db } from '../db.js'
import { authJwt, ok, requireAdmin, type AuthedRequest } from '../middleware/auth.js'
import { centsToYuan } from '../services/users.js'
import { modelTypeOf } from '../services/model-catalog.js'
import { checkDeveloper, userReqs, isDevPlatformConfigured } from '../services/dev-platform.js'

export const usageRouter = Router()
usageRouter.use(authJwt)

/** 默认聚合的模型上限（超出则截断，避免返回过大） */
const AGG_MAX_GROUPS = 200

function sinceDays(days: number) {
  return Date.now() - days * 24 * 60 * 60 * 1000
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

function accountTotals(a: AggregateTotals, l: any): void {
  a.request_count += 1
  a.prompt_tokens += l.prompt_tokens || 0
  a.cached_tokens += l.cached_tokens || 0
  a.completion_tokens += l.completion_tokens || 0
  a.total_tokens += l.total_tokens || 0
  a.cost_cents += l.cost_cents || 0
  if (l.status && l.status !== 'ok') a.error_count += 1
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
usageRouter.get('/aggregate', (req: AuthedRequest, res) => {
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

  let logs = db
    .getStore()
    .usage_logs.filter((l) => {
      if (l.user_id !== targetUserId) return false
      const t = new Date(l.created_at).getTime()
      if (t < from || t > to) return false
      if (modelFilter.length && !modelFilter.includes(l.model_slug)) return false
      if (typeFilter.length) {
        const mt = modelTypeBySlug.get(l.model_slug) || ''
        if (!typeFilter.includes(mt)) return false
      }
      if (statusFilter.length) {
        const isErr = l.status && l.status !== 'ok'
        const wantErr = statusFilter.includes('error')
        if (wantErr) {
          if (!isErr) return false
        } else if (!statusFilter.includes(l.status)) {
          return false
        }
      }
      if (apiKeyIdFilter != null && l.api_key_id !== apiKeyIdFilter) return false
      return true
    })

  const totals = logs.reduce(
    (a: AggregateTotals, l: any) => {
      accountTotals(a, l)
      return a
    },
    emptyTotals() as AggregateTotals,
  )
  totals.costYuan = centsToYuan(totals.cost_cents)

  // —— 按时间分桶（day / hour）——
  let byTime: Array<{ bucket: string; tokens: number; requests: number; cost_cents: number; costYuan: number }> = []
  if (granularity === 'day' || granularity === 'hour') {
    const bucket = granularity === 'day' ? localDay : localHour
    const timeMap = new Map<string, { tokens: number; requests: number; cost_cents: number }>()
    let cursor = from
    // 预先铺满空桶，保证趋势连续（day 用天，hour 用小时）
    const stepMs = granularity === 'day' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000
    const bucketOf = (ts: number) => bucket(new Date(ts).toISOString())
    for (let ts = from; ts <= to; ts += stepMs) {
      const b = bucketOf(ts)
      if (!timeMap.has(b)) timeMap.set(b, { tokens: 0, requests: 0, cost_cents: 0 })
    }
    for (const l of logs) {
      const b = bucket(l.created_at)
      const cur = timeMap.get(b) || { tokens: 0, requests: 0, cost_cents: 0 }
      cur.tokens += l.total_tokens || 0
      cur.requests += 1
      cur.cost_cents += l.cost_cents || 0
      timeMap.set(b, cur)
    }
    byTime = [...timeMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([bucket, v]) => ({ bucket, ...v, costYuan: centsToYuan(v.cost_cents) }))
  }

  // —— 固定按日桶（给趋势图，始终按 day，不受 granularity 影响）——
  let daily: Array<{ bucket: string; tokens: number; requests: number; cost_cents: number; costYuan: number }> = []
  {
    const timeMap = new Map<string, { tokens: number; requests: number; cost_cents: number }>()
    const stepMs = 24 * 60 * 60 * 1000
    const bucketOf = (ts: number) => localDay(new Date(ts).toISOString())
    for (let ts = from; ts <= to; ts += stepMs) {
      const b = bucketOf(ts)
      if (!timeMap.has(b)) timeMap.set(b, { tokens: 0, requests: 0, cost_cents: 0 })
    }
    for (const l of logs) {
      const b = localDay(l.created_at)
      const cur = timeMap.get(b) || { tokens: 0, requests: 0, cost_cents: 0 }
      cur.tokens += l.total_tokens || 0
      cur.requests += 1
      cur.cost_cents += l.cost_cents || 0
      timeMap.set(b, cur)
    }
    daily = [...timeMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([bucket, v]) => ({ bucket, ...v, costYuan: centsToYuan(v.cost_cents) }))
  }

  // —— 按模型分组 ——
  const modelMap = new Map<
    string,
    { model_slug: string; model_type: string; tokens: number; cost_cents: number; requests: number; errors: number }
  >()
  for (const l of logs) {
    const cur = modelMap.get(l.model_slug) || {
      model_slug: l.model_slug,
      model_type: modelTypeBySlug.get(l.model_slug) || 'unknown',
      tokens: 0,
      cost_cents: 0,
      requests: 0,
      errors: 0,
    }
    cur.tokens += l.total_tokens || 0
    cur.cost_cents += l.cost_cents || 0
    cur.requests += 1
    if (l.status && l.status !== 'ok') cur.errors += 1
    modelMap.set(l.model_slug, cur)
  }
  let byModel = [...modelMap.values()]
    .sort((a, b) => b.cost_cents - a.cost_cents)
    .map((r) => ({ ...r, costYuan: centsToYuan(r.cost_cents) }))
  if (byModel.length > AGG_MAX_GROUPS) byModel = byModel.slice(0, AGG_MAX_GROUPS)

  // —— 按状态分组 ——
  const statusMap = new Map<string, { status: string; request_count: number; tokens: number; cost_cents: number }>()
  for (const l of logs) {
    const st = l.status && l.status === 'ok' ? 'ok' : 'error'
    const cur = statusMap.get(st) || { status: st, request_count: 0, tokens: 0, cost_cents: 0 }
    cur.request_count += 1
    cur.tokens += l.total_tokens || 0
    cur.cost_cents += l.cost_cents || 0
    statusMap.set(st, cur)
  }
  const byStatus = [...statusMap.values()].map((r) => ({ ...r, costYuan: centsToYuan(r.cost_cents) }))

  // —— request 颗粒度：明细分页 ——
  let items: any[] = []
  let page = 0
  let pageSize = 0
  let total = 0
  if (granularity === 'request') {
    page = Math.max(1, Number(req.query.page) || 1)
    pageSize = Math.min(200, Math.max(1, Number(req.query.page_size) || 50))
    logs = [...logs].sort((a, b) => b.id - a.id)
    total = logs.length
    items = logs.slice((page - 1) * pageSize, page * pageSize).map((r) => ({
      ...r,
      costYuan: centsToYuan(r.cost_cents),
    }))
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

  let logs = s.usage_logs.filter((l) => {
    const t = new Date(l.created_at).getTime()
    if (t < from || t > to) return false
    if (modelFilter.length && !modelFilter.includes(l.model_slug)) return false
    if (statusFilter.length) {
      const isErr = l.status && l.status !== 'ok'
      if (statusFilter.includes('error')) {
        if (!isErr) return false
      } else if (!statusFilter.includes(l.status)) {
        return false
      }
    }
    if (typeFilter.length) {
      const mt = modelTypeBySlug.get(l.model_slug) || ''
      if (!typeFilter.includes(mt)) return false
    }
    return true
  })

  // 总览汇总
  const totals = logs.reduce(
    (a, l) => {
      accountTotals(a, l)
      return a
    },
    emptyTotals() as AggregateTotals,
  )
  totals.costYuan = centsToYuan(totals.cost_cents)

  const users = Array.from(new Set(logs.map((l) => l.user_id))).sort((a, b) => a - b)
  const userMap = new Map<
    number,
    { user_id: number; name: string; oauthId: string; requests: number; tokens: number; prompt_tokens: number; completion_tokens: number; cached_tokens: number; cost_cents: number; errors: number }
  >()
  for (const l of logs) {
    const cur = userMap.get(l.user_id) || {
      user_id: l.user_id,
      name: userName(l.user_id),
      oauthId: oauthIdOf(l.user_id),
      requests: 0,
      tokens: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      cached_tokens: 0,
      cost_cents: 0,
      errors: 0,
    }
    cur.requests += 1
    cur.tokens += l.total_tokens || 0
    cur.prompt_tokens += l.prompt_tokens || 0
    cur.completion_tokens += l.completion_tokens || 0
    cur.cached_tokens += l.cached_tokens || 0
    cur.cost_cents += l.cost_cents || 0
    if (l.status && l.status !== 'ok') cur.errors += 1
    userMap.set(l.user_id, cur)
  }
  let byUser = [...userMap.values()]
    .sort((a, b) => b.cost_cents - a.cost_cents)
    .map((r) => ({ ...r, costYuan: centsToYuan(r.cost_cents) }))

  let detail: { page: number; pageSize: number; total: number; items: any[] } | null = null
  if (targetUserId != null) {
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(200, Math.max(1, Number(req.query.page_size) || 50))
    const own = logs.filter((l) => l.user_id === targetUserId).sort((a, b) => b.id - a.id)
    const items = own.slice((page - 1) * pageSize, page * pageSize).map((r) => ({
      ...r,
      costYuan: centsToYuan(r.cost_cents),
    }))
    detail = { page, pageSize, total: own.length, items }
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
usageRouter.get('/logs', (req: AuthedRequest, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const pageSize = Math.min(200, Math.max(1, Number(req.query.page_size) || 20))
  const isAdmin = !!req.user!.is_admin
  // 管理员可看指定 userId 的日志；普通用户只能看自己
  const userId = isAdmin && req.query.userId ? Number(req.query.userId) : req.user!.id
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 0))
  const modelFilter = splitCsv(req.query.model)
  const statusFilter = splitCsv(req.query.status)
  const typeFilter = splitCsv(req.query.type || req.query.modelType)
  const from = days > 0 ? sinceDays(days) : 0

  const modelTypeBySlug = new Map<string, string>()
  for (const m of db.getStore().models) {
    modelTypeBySlug.set(m.slug, modelTypeOf(m))
  }

  let all = db
    .getStore()
    .usage_logs.filter((l) => {
      if (l.user_id !== userId) return false
      if (from && new Date(l.created_at).getTime() < from) return false
      if (modelFilter.length && !modelFilter.includes(l.model_slug)) return false
      if (typeFilter.length) {
        const mt = modelTypeBySlug.get(l.model_slug) || ''
        if (!typeFilter.includes(mt)) return false
      }
      if (statusFilter.length) {
        const isErr = l.status && l.status !== 'ok'
        if (statusFilter.includes('error')) {
          if (!isErr) return false
        } else if (!statusFilter.includes(l.status)) {
          return false
        }
      }
      return true
    })
    .sort((a, b) => b.id - a.id)

  const total = all.length
  const items = all.slice((page - 1) * pageSize, page * pageSize).map((r) => ({
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

usageRouter.get('/summary', (req: AuthedRequest, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30))
  const userId = req.user!.id
  const from = sinceDays(days)
  const logs = db
    .getStore()
    .usage_logs.filter((l) => l.user_id === userId && new Date(l.created_at).getTime() >= from)

  const totals = logs.reduce(
    (a, l) => {
      a.prompt_tokens += l.prompt_tokens
      a.cached_tokens += l.cached_tokens || 0
      a.completion_tokens += l.completion_tokens
      a.total_tokens += l.total_tokens
      a.cost_cents += l.cost_cents
      a.request_count += 1
      return a
    },
    {
      prompt_tokens: 0,
      cached_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cost_cents: 0,
      request_count: 0,
    },
  )

  const dayMap = new Map<string, { day: string; tokens: number; cost_cents: number; requests: number }>()
  for (const l of logs) {
    const day = localDay(l.created_at)
    const cur = dayMap.get(day) || { day, tokens: 0, cost_cents: 0, requests: 0 }
    cur.tokens += l.total_tokens
    cur.cost_cents += l.cost_cents
    cur.requests += 1
    dayMap.set(day, cur)
  }
  const byDay = [...dayMap.values()]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((r) => ({ ...r, costYuan: centsToYuan(r.cost_cents) }))

  const modelMap = new Map<
    string,
    { model_slug: string; tokens: number; cost_cents: number; requests: number }
  >()
  for (const l of logs) {
    const cur = modelMap.get(l.model_slug) || {
      model_slug: l.model_slug,
      tokens: 0,
      cost_cents: 0,
      requests: 0,
    }
    cur.tokens += l.total_tokens
    cur.cost_cents += l.cost_cents
    cur.requests += 1
    modelMap.set(l.model_slug, cur)
  }
  const byModel = [...modelMap.values()]
    .sort((a, b) => b.cost_cents - a.cost_cents)
    .map((r) => ({ ...r, costYuan: centsToYuan(r.cost_cents) }))

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
