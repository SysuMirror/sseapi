import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { config } from '../config.js'

const require = createRequire(import.meta.url)
// sm-crypto 无类型定义、且为 CJS 包，用 require 加载；签名算法为 SM2withSM3
// （与开发者平台 server/src/services/permissions.ts 保持一致）
const smCrypto = require('sm-crypto') as {
  sm2: {
    doSignature: (
      msg: string,
      privateKey: string,
      opts?: { hash?: boolean; der?: boolean },
    ) => string
  }
}

const sm2 = smCrypto.sm2

export type DevCheckResult = {
  found: boolean
  isDeveloper: boolean
  isAdmin: boolean
  userId: number | null
  oauthId: string | null
  name: string
  nickname: string
  displayName: string
}

export type DevReqItem = {
  id: number
  title: string
  description: string
  bizId: number
  bizName: string
  stage: string
  stageLabel: string
  priority: number
  dueDate: string
  archived: boolean
  ownerUserId: number
  createdAt: string
  updatedAt: string
}

/**
 * 生成模块签名令牌：
 * token = base64url(slug).base64url(ts).base64url(nonce).base64url(sm2sign)
 * sign = SM2 私钥对 `slug\nts\nnonce\nqueryTime` 的签名（hash=true, der=false，hex）
 * queryTime 需与请求头 x-model-query-time 一致（毫秒时间戳，±60s 偏差）。
 */
function buildModuleAuthToken(queryTime: number): string {
  const slug = config.developerModuleSlug
  const privateKey = config.developerModulePrivateKey
  const ts = String(Date.now())
  const nonce = crypto.randomBytes(16).toString('hex')
  const payload = `${slug}\n${ts}\n${nonce}\n${queryTime}`
  const sign = sm2.doSignature(payload, privateKey, { hash: true, der: false })

  const b64u = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
  return [b64u(slug), b64u(ts), b64u(nonce), b64u(sign)].join('.')
}

/** 开发者平台是否配置了开放 API 对接所需的模块私钥 */
export function isDevPlatformConfigured(): boolean {
  return Boolean(config.developerModulePrivateKey && config.developerApiBase)
}

// —— 开发者身份缓存（列表/调用需要频繁判定，接口调用有成本）——
const devCache = new Map<string, { at: number; isDev: boolean }>()
const devInflight = new Map<string, Promise<boolean>>()
const DEV_CACHE_TTL = 120_000 // 2 分钟

/** 刷新单个用户的开发者身份（同一用户并发时只发一次请求） */
function refreshDeveloper(oauthId: string): Promise<boolean> {
  const running = devInflight.get(oauthId)
  if (running) return running
  const task = (async () => {
    try {
      const r = await checkDeveloper(oauthId)
      const isDev = !!(r.found && r.isDeveloper)
      devCache.set(oauthId, { at: Date.now(), isDev })
      return isDev
    } catch {
      // 外部平台抖动时沿用上一次结论，避免把开发者误判成普通用户
      return devCache.get(oauthId)?.isDev ?? false
    } finally {
      devInflight.delete(oauthId)
    }
  })()
  devInflight.set(oauthId, task)
  return task
}

/**
 * 判断某 oauthId 是否为集市开发者（平台未配置或未知 → false，fail-closed）。
 *
 * 过期策略是 stale-while-revalidate：缓存过期后先返回上一次结论、后台刷新。
 * 之前是同步刷新，TTL 一过，模型列表接口就要等一次外部 HTTP（最长 8s），
 * 表现为「进模型卡界面偶尔要转很久」。
 */
export async function userIsDeveloper(oauthId?: string | null): Promise<boolean> {
  if (!isDevPlatformConfigured()) return false
  if (!oauthId) return false
  const hit = devCache.get(oauthId)
  if (hit) {
    if (Date.now() - hit.at >= DEV_CACHE_TTL) void refreshDeveloper(oauthId)
    return hit.isDev
  }
  return refreshDeveloper(oauthId) // 首次未知，只能等这一次
}

/** 集市 userID：UniSSO 迁移后存 sse_user_id；旧数据/无绑定时退回 oauth_id */
export function marketUserId(u: { sse_user_id?: string | null; oauth_id?: string | null }): string {
  return String(u.sse_user_id || u.oauth_id || '').trim()
}

/**
 * 判断某用户是否可访问「仅开发者」模型：
 * 管理员恒可；否则需为集市开发者。平台未配置时普通用户一律不可（fail-closed）。
 */
export async function mayAccessDevOnly(req: { user?: { sse_user_id?: string | null; oauth_id?: string | null; is_admin?: number | null } }): Promise<boolean> {
  const u = req.user
  if (!u) return false
  if (u.is_admin) return true
  return userIsDeveloper(marketUserId(u))
}

/**
 * 对开发者平台开放 API 发起带 SM2 签名的 GET 请求。
 * 统一设置 x-model-Authorization / x-model-query-time 头。
 */
async function devGet<T>(path: string): Promise<T> {
  const base = config.developerApiBase.replace(/\/$/, '')
  const queryTime = Date.now()
  const url = `${base}${path}`
  const res = await fetch(url, {
    headers: {
      'x-model-authorization': buildModuleAuthToken(queryTime),
      'x-model-query-time': String(queryTime),
    },
    signal: AbortSignal.timeout(8000),
  })
  const body = (await res.json().catch(() => ({}))) as any
  if (!res.ok) {
    const msg = body?.message || body?.error || `${res.status} ${res.statusText}`
    throw new Error(`开发者平台请求失败：${msg}`)
  }
  // 平台统一包裹为 { code, message, data }
  return (body?.data ?? body) as T
}

/** 判断某集市 oauthId 是否开发者，并返回平台内部 userId */
export async function checkDeveloper(oauthId: string): Promise<DevCheckResult> {
  const data = await devGet<DevCheckResult>(`/api/open/developers/check?oauthId=${encodeURIComponent(oauthId)}`)
  return (data ?? {}) as DevCheckResult
}

/** 查询某平台用户（内部 userId）负责的需求单，默认进行中 */
export async function userReqs(
  userId: number,
  opts?: { page?: number; pageSize?: number },
): Promise<{ page: number; pageSize: number; total: number; items: DevReqItem[] }> {
  const page = opts?.page || 1
  const pageSize = opts?.pageSize || 50
  const path = `/api/open/users/${userId}/reqs?page=${page}&page_size=${pageSize}`
  const data = await devGet<any>(path)
  return {
    page: data?.page ?? page,
    pageSize: data?.pageSize ?? pageSize,
    total: data?.total ?? 0,
    items: (data?.items ?? []) as DevReqItem[],
  }
}
