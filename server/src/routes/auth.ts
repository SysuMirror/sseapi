import { Router } from 'express'
import { config, isOAuthConfigured } from '../config.js'
import {
  SsoError,
  revokeSsoSession,
  verifyPassword,
  verifySsoSession,
  type SsoTicket,
  type UniSSOProfile,
} from '../services/oauth.js'
import { publicUser, upsertUserFromOAuth, type UserRow } from '../services/users.js'
import { authJwt, ok, fail, signUserToken, type AuthedRequest } from '../middleware/auth.js'

export const authRouter = Router()

const SSO_COOKIES = ['unisso_sid', 'sse_sso'] // Cookie 改名期：新名在前
const SSO_COOKIE_DOMAIN = '.ssemarket.cn'
const SSO_MAX_AGE = 604800
/** 静默登录限流：10 次/分钟/IP（客户端 IP 取自 nginx 传入的 X-Forwarded-For） */
const SSO_RATE_LIMIT = 10
const SSO_RATE_WINDOW_MS = 60_000
const ssoHits = new Map<string, { count: number; resetAt: number }>()

function clientIp(req: { headers: Record<string, unknown>; socket?: { remoteAddress?: string } }): string {
  const xff = String(req.headers['x-forwarded-for'] || '')
  const first = xff.split(',')[0]?.trim()
  return first || req.socket?.remoteAddress || 'unknown'
}

function hitSsoRateLimit(ip: string): boolean {
  const nowMs = Date.now()
  const rec = ssoHits.get(ip)
  if (!rec || rec.resetAt <= nowMs) {
    if (ssoHits.size > 5000) ssoHits.clear()
    ssoHits.set(ip, { count: 1, resetAt: nowMs + SSO_RATE_WINDOW_MS })
    return false
  }
  rec.count += 1
  return rec.count > SSO_RATE_LIMIT
}

function readSsoCookie(req: { headers: Record<string, unknown> }): string {
  const raw = String(req.headers.cookie || '')
  // Cookie 改名期双读：先 unisso_sid，为空再读 sse_sso
  for (const name of SSO_COOKIES) {
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=')
      if (idx < 0) continue
      if (part.slice(0, idx).trim() === name) {
        const value = decodeURIComponent(part.slice(idx + 1).trim())
        if (value) return value
      }
    }
  }
  return ''
}

function setSsoCookie(res: { append: (k: string, v: string) => void }, ticket: SsoTicket) {
  res.append(
    'Set-Cookie',
    `${ticket.cookieName}=${encodeURIComponent(ticket.session)}; Domain=${ticket.cookieDomain}; Path=/; Max-Age=${ticket.maxAge}; HttpOnly; Secure; SameSite=Lax`,
  )
}

function clearSsoCookie(res: { append: (k: string, v: string) => void }) {
  // 改名期双清：新旧两个名字都按父域清除
  for (const name of SSO_COOKIES) {
    res.append(
      'Set-Cookie',
      `${name}=; Domain=${SSO_COOKIE_DOMAIN}; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    )
  }
}

function loginPayload(user: UserRow, profile: UniSSOProfile) {
  return {
    token: signUserToken(user),
    user: publicUser(user),
    profile: {
      sub: profile.sub,
      sseUserId: profile.sseSub,
      name: profile.name,
      email: profile.email,
      avatarUrl: profile.avatar_url,
    },
  }
}

// 邮箱+密码登录：后端持 client 凭据调 UniSSO password/verify 代验（无 OAuth 跳转），
// internal !== true 直接拒绝。成功后把 unisso 下发的共享会话 Cookie 种给浏览器，
// 其它 .ssemarket.cn 子站据此静默登录。
authRouter.post('/login', async (req, res) => {
  if (!isOAuthConfigured()) {
    fail(res, 503, '登录服务未配置，请设置 UNISSO_CLIENT_ID / SECRET')
    return
  }
  const { email, password } = (req.body || {}) as { email?: string; password?: string }
  if (!email || !password) {
    fail(res, 400, '请填写邮箱和密码')
    return
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    fail(res, 400, '邮箱格式不正确')
    return
  }
  try {
    const { profile, sso } = await verifyPassword(email, password)
    const user = await upsertUserFromOAuth(profile)
    if (sso) setSsoCookie(res, sso)
    ok(res, loginPayload(user, profile))
  } catch (e) {
    fail(res, 401, e instanceof Error ? e.message : '登录失败')
  }
})

// 静默 SSO：读共享父域 Cookie → unisso 校验 → 本地 upsert → 签本地 JWT。
// 401/503 都让前端静默回落到登录表单；本端点不重新下发 SSO Cookie。
authRouter.post('/sso/try', async (req, res) => {
  if (!isOAuthConfigured()) {
    fail(res, 503, 'sso_unavailable')
    return
  }
  if (hitSsoRateLimit(clientIp(req))) {
    fail(res, 429, 'too_many_requests')
    return
  }
  const session = readSsoCookie(req)
  if (!session) {
    fail(res, 401, 'no_sso')
    return
  }
  try {
    const profile = await verifySsoSession(session)
    const user = await upsertUserFromOAuth(profile)
    ok(res, loginPayload(user, profile))
  } catch (e) {
    if (e instanceof SsoError) {
      if (e.kind === 'unavailable') fail(res, 503, 'sso_unavailable')
      else if (e.kind === 'forbidden') fail(res, 401, 'not_internal')
      else fail(res, 401, 'invalid_sso')
      return
    }
    fail(res, 503, 'sso_unavailable')
  }
})

// 单点登出：撤销 unisso 会话 + 清父域 Cookie + 清本地 JWT（无状态，前端负责）。
authRouter.post('/logout', async (req, res) => {
  const session = readSsoCookie(req)
  if (session) await revokeSsoSession(session)
  clearSsoCookie(res)
  ok(res, { ok: true })
})

authRouter.get('/me', authJwt, (req: AuthedRequest, res) => {
  ok(res, publicUser(req.user!))
})
