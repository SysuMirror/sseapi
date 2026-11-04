import { config } from '../config.js'

// UniSSO 机器对机器认证（平台自持邮箱+密码表单，后端持 client 凭据代验，无 OAuth 跳转）：
//   POST {issuer}/api/oauth/password/verify  → 登录
//   POST {issuer}/api/oauth/session/verify   → 静默 SSO（共享父域 Cookie 里的会话）
//   POST {issuer}/api/oauth/session/revoke   → 单点登出
// 三者都返回 {"ok":true,"user":{sub,sso_sub,sse_sub,internal,...}}，前两者另带
// sso_session/sso_cookie_name/sso_cookie_domain/sso_max_age 等 Cookie 元数据。

export type UniSSOProfile = {
  sub: string
  /** 绑定的集市 userID，可为空 */
  sseSub: string
  internal: boolean
  name: string
  email: string
  avatar_url: string
}

/** 由 unisso 下发、平台负责种到浏览器的共享会话 Cookie */
export type SsoTicket = {
  session: string
  cookieName: string
  cookieDomain: string
  maxAge: number
}

export type PasswordLoginResult = {
  profile: UniSSOProfile
  sso: SsoTicket | null
}

export type SsoErrorKind = 'invalid' | 'forbidden' | 'unavailable'

export class SsoError extends Error {
  kind: SsoErrorKind
  constructor(kind: SsoErrorKind, message: string) {
    super(message)
    this.name = 'SsoError'
    this.kind = kind
  }
}

const INTERNAL_REQUIRED_MSG = '仅限软件工程学院院内账号登录本平台（当前 UniSSO 账号无院内身份）'

function parseInternal(v: unknown): boolean {
  return v === true || v === 1 || v === 'true' || v === '1'
}

type RawUser = {
  sub?: string
  sse_sub?: string
  internal?: unknown
  preferred_username?: string
  name?: string
  email?: string
  picture?: string
}

type RawResponse = {
  ok?: boolean
  user?: RawUser
  sso_session?: string
  sso_cookie_name?: string
  sso_cookie_domain?: string
  sso_max_age?: number | string
  error?: string
}

function toProfile(user: RawUser, requireInternal: boolean): UniSSOProfile {
  const internal = parseInternal(user.internal)
  if (requireInternal && !internal) throw new SsoError('forbidden', INTERNAL_REQUIRED_MSG)
  return {
    sub: String(user.sub),
    sseSub: user.sse_sub != null ? String(user.sse_sub) : '',
    internal,
    name: user.name || user.preferred_username || '',
    email: user.email || '',
    avatar_url: String(user.picture || '').trim(),
  }
}

function readTicket(json: RawResponse): SsoTicket | null {
  const session = String(json.sso_session || '').trim()
  if (!session) return null
  const maxAge = Number(json.sso_max_age)
  return {
    session,
    cookieName: String(json.sso_cookie_name || 'sse_sso').trim(),
    cookieDomain: String(json.sso_cookie_domain || '.ssemarket.cn').trim(),
    maxAge: Number.isFinite(maxAge) && maxAge > 0 ? Math.floor(maxAge) : 604800,
  }
}

async function postForm(path: string, body: URLSearchParams, timeoutMs: number) {
  const { issuer } = config.oauth
  try {
    return await fetch(`${issuer}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new SsoError('unavailable', '登录服务暂时不可用')
  }
}

function clientBody(): URLSearchParams {
  return new URLSearchParams({
    client_id: config.oauth.clientId,
    client_secret: config.oauth.clientSecret,
  })
}

export async function verifyPassword(email: string, password: string): Promise<PasswordLoginResult> {
  const body = clientBody()
  body.set('email', email.trim().toLowerCase())
  body.set('password', password)

  const res = await postForm('/api/oauth/password/verify', body, 15000)
  const json = (await res.json().catch(() => ({}))) as RawResponse

  if (res.status === 429) throw new Error('尝试次数过多，请 15 分钟后再试')
  if (res.status === 400) throw new Error('请填写邮箱和密码')
  if (res.status === 401) {
    if (json.error === 'invalid_client') throw new Error('登录服务配置错误，请联系管理员')
    throw new Error('邮箱或密码错误')
  }
  if (res.status === 403) throw new Error('登录服务拒绝本应用，请检查客户端配置')
  if (!res.ok || !json.ok || !json.user?.sub) throw new Error('登录失败，请稍后再试')
  return {
    profile: toProfile(json.user, true),
    sso: readTicket(json),
  }
}

/**
 * 用共享 Cookie 里的会话向 unisso 换身份。Cookie 值只是会话指针，必须由服务端校验。
 * invalid → 401 invalid_sso；429/5xx/超时 → 503 sso_unavailable；非院内 → 401 not_internal。
 */
export async function verifySsoSession(session: string): Promise<UniSSOProfile> {
  const body = clientBody()
  body.set('session', session)

  const res = await postForm('/api/oauth/session/verify', body, 8000)
  if (res.status === 401) throw new SsoError('invalid', 'SSO 会话已失效')
  if (res.status === 429) throw new SsoError('unavailable', 'SSO 校验请求过多')
  if (!res.ok) throw new SsoError('unavailable', 'SSO 校验失败')
  const json = (await res.json().catch(() => ({}))) as RawResponse
  if (!json.ok || !json.user?.sub) throw new SsoError('invalid', 'SSO 会话已失效')
  return toProfile(json.user, true)
}

/** 单点登出：尽力撤销 unisso 侧会话，失败不阻塞本地登出 */
export async function revokeSsoSession(session: string): Promise<void> {
  const body = clientBody()
  body.set('session', session)
  try {
    await postForm('/api/oauth/session/revoke', body, 5000)
  } catch {
    /* unisso 不可达时由平台清本地会话兜底 */
  }
}
