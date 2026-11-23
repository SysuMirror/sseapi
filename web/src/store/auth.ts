import { reactive } from 'vue'

export interface User {
  id: number
  oauthId: string
  name: string
  email?: string
  avatarUrl?: string
  isAdmin: boolean
  balanceCents: number
}

const TOKEN_KEY = 'sseapi_token'
const USER_KEY = 'sseapi_user'
const REDIRECT_KEY = 'sseapi_redirect'

export const auth = reactive<{ token: string; user: User | null }>({
  token: localStorage.getItem(TOKEN_KEY) || '',
  user: JSON.parse(localStorage.getItem(USER_KEY) || 'null') as User | null,
})

export function isLoggedIn(): boolean {
  return !!auth.token
}

export function setAuth(token: string, user: User) {
  auth.token = token
  auth.user = user
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(USER_KEY, JSON.stringify(user))
}

export function patchUser(partial: Partial<User>) {
  if (!auth.user) return
  auth.user = { ...auth.user, ...partial }
  localStorage.setItem(USER_KEY, JSON.stringify(auth.user))
}

export function clearAuth() {
  auth.token = ''
  auth.user = null
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}

export function saveRedirect(path: string) {
  sessionStorage.setItem(REDIRECT_KEY, path)
}

export function consumeRedirect(): string {
  const p = sessionStorage.getItem(REDIRECT_KEY) || '/'
  sessionStorage.removeItem(REDIRECT_KEY)
  return p
}

/**
 * 每次页面加载向 unisso 复核共享 SSO Cookie 一次（无论本地有没有 token）：
 * - 200：刷新本地会话（顺带完成「无 token 时静默登录」）
 * - 401：Cookie 已失效/已被其它平台单点登出 → 清本地会话，回登录页
 * - 503/429/网络：unisso 暂时不可达 → 保留本地会话，不把已登录用户踢下线
 */
export type SsoCheck = 'ok' | 'invalid' | 'unavailable'

let ssoCheck: Promise<SsoCheck> | null = null
let ssoChecked = false

async function probeSsoOnce(): Promise<{ state: SsoCheck; retryable: boolean }> {
  try {
    // 动态引入避免 store ↔ api 的循环依赖
    const { api } = await import('../api')
    const data = await api.ssoTry()
    setAuth(data.token, data.user)
    return { state: 'ok', retryable: false }
  } catch (e) {
    const status = (e as { status?: number }).status
    if (status === 401) {
      clearAuth()
      return { state: 'invalid', retryable: false }
    }
    // 429 契约明确不自动重试；其余不可达类错误（超时/断连/5xx）允许重试一次
    return { state: 'unavailable', retryable: status !== 429 }
  }
}

export function revalidateSso(): Promise<SsoCheck> {
  if (ssoCheck) return ssoCheck
  if (ssoChecked) return Promise.resolve(isLoggedIn() ? 'ok' : 'invalid')
  ssoCheck = (async () => {
    let r = await probeSsoOnce()
    if (r.state === 'unavailable' && r.retryable) {
      // 冷启动首连偶发挂起/断连：短退避重试一次，不让用户被迫手动刷新
      await new Promise((resolve) => setTimeout(resolve, 600))
      r = await probeSsoOnce()
    }
    ssoChecked = true
    ssoCheck = null
    return r.state
  })()
  return ssoCheck
}
