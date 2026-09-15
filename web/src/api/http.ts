import axios, { type AxiosInstance } from 'axios'
import { auth, clearAuth } from '../store/auth'

/**
 * API 根地址：
 * - 生产双域：VITE_API_BASE=https://api.ssemarket.cn/
 * - 同域/本地：走 BASE_URL 或 Vite 代理
 */
function resolveBase(): string {
  const api = (import.meta.env.VITE_API_BASE || '').trim()
  if (api) return api.endsWith('/') ? api : `${api}/`
  const raw = (import.meta.env.BASE_URL || '/').trim()
  return raw.endsWith('/') ? raw : `${raw}/`
}

const instance: AxiosInstance = axios.create({
  baseURL: resolveBase(),
  timeout: 60000,
})

instance.interceptors.request.use((config) => {
  if (auth.token) {
    config.headers.Authorization = `Bearer ${auth.token}`
  }
  return config
})

instance.interceptors.response.use(
  (resp) => {
    const body = resp.data
    if (body && typeof body === 'object' && 'code' in body) {
      if (body.code === 0) return body.data
      return Promise.reject(new Error(body.message || '请求失败'))
    }
    return body
  },
  (error) => {
    const status = error.response?.status
    const body = error.response?.data
    const message = body?.message || error.message || '网络错误'
    if (status === 401) {
      clearAuth()
      const loginPath = `${import.meta.env.BASE_URL}login`.replace(/\/{2,}/g, '/')
      if (!window.location.pathname.endsWith('/login')) {
        window.location.replace(loginPath)
      }
    }
    return Promise.reject(new Error(message))
  },
)

export const http = {
  get: <T = any>(url: string, config?: any) => instance.get(url, config) as unknown as Promise<T>,
  post: <T = any>(url: string, data?: any, config?: any) =>
    instance.post(url, data, config) as unknown as Promise<T>,
  put: <T = any>(url: string, data?: any) => instance.put(url, data) as unknown as Promise<T>,
  patch: <T = any>(url: string, data?: any) => instance.patch(url, data) as unknown as Promise<T>,
  delete: <T = any>(url: string) => instance.delete(url) as unknown as Promise<T>,
}
