import { http } from './http'
import type { User } from '../store/auth'

export const api = {
  loginUrl: () => http.get<{ authorize_url: string; state: string }>('api/auth/oauth/login-url'),
  oauthToken: (code: string, state: string) =>
    http.post<{ session_id: string }>('api/auth/oauth/token', { code, state }),
  oauthUserinfo: (session_id: string) =>
    http.post<{ token: string; user: User }>('api/auth/oauth/userinfo', { session_id }),
  me: () => http.get<User>('api/auth/me'),

  keys: () => http.get<any[]>('api/keys'),
  keysConfig: () => http.get<any>('api/keys/config'),
  createKey: (name: string, allowedOrigins = '') =>
    http.post<any>('api/keys', { name, allowedOrigins }),
  patchKey: (id: number, body: { name?: string; allowedOrigins?: string }) =>
    http.patch(`api/keys/${id}`, body),
  revokeKey: (id: number) => http.delete(`api/keys/${id}`),

  usageSummary: (days = 30) => http.get<any>(`api/usage/summary?days=${days}`),
  usageLogs: (q: Record<string, string | number> = {}) => {
    const qs = Object.entries(q)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&')
    return http.get<any>(`api/usage/logs${qs ? `?${qs}` : ''}`)
  },
  usageAggregate: (q: Record<string, string | number> = {}) => {
    const qs = Object.entries(q)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&')
    return http.get<any>(`api/usage/aggregate${qs ? `?${qs}` : ''}`)
  },
  // 管理台「个人 token 面板」：按用户聚合（仅管理员）
  usageByUser: (q: Record<string, string | number> = {}) => {
    const qs = Object.entries(q)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&')
    return http.get<any>(`api/usage/by-user${qs ? `?${qs}` : ''}`)
  },
  // 某平台用户的需求单（集市开发者职责，仅管理员）
  usageUserReqs: (userId: number) => http.get<any>(`api/usage/by-user/${userId}/reqs`),

  balance: () => http.get<any>('api/billing/balance'),
  billingSummary: () => http.get<any>('api/billing/summary'),
  ledger: (page = 1) => http.get<any>(`api/billing/ledger?page=${page}`),

  models: () => http.get<any[]>('api/models'),
  docs: () =>
    http.get<{ title: string; url: string; external: boolean; apiHost: string }>('api/docs'),

  adminStats: () => http.get<any>('api/admin/stats'),
  adminUsers: (q = '') => http.get<any[]>(`api/admin/users?q=${encodeURIComponent(q)}`),
  adminUserDetail: (id: number) => http.get<any>(`api/admin/users/${id}`),
  adminCredit: (id: number, amountYuan: number, note: string) =>
    http.post(`api/admin/users/${id}/credit`, { amountYuan, note }),
  adminSetBalance: (id: number, balanceYuan: number, note: string) =>
    http.post(`api/admin/users/${id}/set-balance`, { balanceYuan, note }),
  adminSetAdmin: (id: number, isAdmin: boolean) =>
    http.patch(`api/admin/users/${id}`, { isAdmin }),
  adminPatchUser: (id: number, body: Record<string, unknown>) =>
    http.patch(`api/admin/users/${id}`, body),
  adminRateLimits: () => http.get<any>('api/admin/rate-limits'),
  adminRateLimitsStatus: () => http.get<any>('api/admin/rate-limits/status'),
  adminSaveRateLimits: (body: {
    enabled: boolean
    defaultRpm: number
    defaultMaxConcurrent: number
  }) => http.put('api/admin/rate-limits', body),
  adminModels: () => http.get<any[]>('api/admin/models'),
  adminCreateModel: (body: any) => http.post('api/admin/models', body),
  adminUpdateModel: (id: number, body: any) => http.put(`api/admin/models/${id}`, body),
  adminDeleteModel: (id: number) => http.delete(`api/admin/models/${id}`),
  adminTestModel: (
    idOrBody:
      | number
      | {
          stream?: boolean
          prompt?: string
          maxTokens?: number
          upstreamBaseUrl?: string
          upstreamModel?: string
          upstreamApiKey?: string
          modelType?: string
          upstreamApiFormat?: string
          upstreamPathOverride?: string
        },
    body?: {
      stream?: boolean
      prompt?: string
      maxTokens?: number
      upstreamBaseUrl?: string
      upstreamModel?: string
      upstreamApiKey?: string
      modelType?: string
      upstreamApiFormat?: string
      upstreamPathOverride?: string
    },
  ) => {
    if (typeof idOrBody === 'number') {
      return http.post(`api/admin/models/${idOrBody}/test`, body || {}, { timeout: 130000 })
    }
    return http.post('api/admin/models/test', idOrBody, { timeout: 130000 })
  },
  adminTestProtocol: (
    id: number,
    body: { protocol: 'anthropic' | 'responses'; baseUrl?: string; upstreamModel?: string; apiKey?: string },
  ) => http.post(`api/admin/models/${id}/test-protocol`, body, { timeout: 30000 }),
  adminDocs: () => http.get<{ title: string; externalUrl: string; updatedAt: string }>('api/admin/docs'),
  adminSaveDocs: (title: string, externalUrl: string) =>
    http.put('api/admin/docs', { title, externalUrl }),
}
