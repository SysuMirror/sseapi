import crypto from 'node:crypto'
import { config } from '../config.js'
import { db, now } from '../db.js'

type Envelope<T> = { code?: number; data?: T; msg?: string; message?: string }

function unwrap<T>(json: Envelope<T> | T): T {
  if (json && typeof json === 'object' && 'data' in (json as Envelope<T>)) {
    return (json as Envelope<T>).data as T
  }
  return json as T
}

export async function createOAuthState(): Promise<string> {
  const state = crypto.randomBytes(16).toString('hex')
  const s = db.getStore()
  const cutoff = Date.now() - 10 * 60 * 1000
  s.oauth_states = s.oauth_states.filter((x) => new Date(x.created_at).getTime() >= cutoff)
  s.oauth_states.push({ state, created_at: now() })
  await db.persist()
  return state
}

export async function consumeOAuthState(state: string): Promise<boolean> {
  const s = db.getStore()
  const i = s.oauth_states.findIndex((x) => x.state === state)
  if (i < 0) return false
  s.oauth_states.splice(i, 1)
  await db.persist()
  return true
}

export function buildAuthorizeUrl(state: string): string {
  const { baseUrl, authorizePath, appId, redirectUri, scope } = config.oauth
  const u = new URL(`${baseUrl.replace(/\/$/, '')}${authorizePath}`)
  u.searchParams.set('appid', appId)
  u.searchParams.set('app_id', appId)
  u.searchParams.set('redirect_uri', redirectUri)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope', scope)
  u.searchParams.set('state', state)
  return u.toString()
}

export async function exchangeCodeForToken(code: string) {
  const body = new URLSearchParams({
    code,
    appid: config.oauth.appId,
    app_id: config.oauth.appId,
    app_secret: config.oauth.appSecret,
  })
  const res = await fetch(`${config.oauth.apiBaseUrl}/api/auth/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const json = (await res.json().catch(() => ({}))) as Envelope<{
    access_token: string
  }> & { error?: string }
  if (!res.ok) {
    throw new Error(json.msg ?? json.message ?? json.error ?? `Token 交换失败 (${res.status})`)
  }
  const data = unwrap(json)
  if (!data?.access_token) throw new Error('未获取到 access_token')
  return data
}

export async function fetchOAuthUserInfo(accessToken: string) {
  const res = await fetch(`${config.oauth.apiBaseUrl}/api/auth/connect/userinfo`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  })
  const json = (await res.json().catch(() => ({}))) as Envelope<{
    user_id: number | string
    name: string
    email?: string
    avatar_url?: string
    avatarUrl?: string
    AvatarURL?: string
    avatar?: string
    picture?: string
  }> & { error?: string }
  if (!res.ok) {
    throw new Error(json.msg ?? json.message ?? json.error ?? `用户信息获取失败 (${res.status})`)
  }
  const data = unwrap(json)
  if (!data?.user_id) throw new Error('未获取到 user_id')
  const avatarRaw =
    data.avatar_url || data.avatarUrl || data.AvatarURL || data.avatar || data.picture || ''
  return {
    user_id: data.user_id,
    name: data.name,
    email: data.email,
    avatar_url: String(avatarRaw).trim(),
  }
}

const pendingSessions = new Map<string, { accessToken: string; expiresAt: number }>()

export function putSession(accessToken: string): string {
  const id = crypto.randomBytes(16).toString('hex')
  pendingSessions.set(id, { accessToken, expiresAt: Date.now() + 5 * 60 * 1000 })
  return id
}

export function takeSession(sessionId: string): string | null {
  const s = pendingSessions.get(sessionId)
  pendingSessions.delete(sessionId)
  if (!s || s.expiresAt < Date.now()) return null
  return s.accessToken
}
