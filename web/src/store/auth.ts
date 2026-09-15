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
const OAUTH_PENDING_KEY = 'sseapi_oauth_pending'

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

export function markOAuthPending() {
  sessionStorage.setItem(OAUTH_PENDING_KEY, '1')
}

export function clearOAuthPending() {
  sessionStorage.removeItem(OAUTH_PENDING_KEY)
}

export function isOAuthPending(): boolean {
  return sessionStorage.getItem(OAUTH_PENDING_KEY) === '1'
}
