import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { config } from '../config.js'
import { db, hashToken, now } from '../db.js'
import { getUserById, type UserRow } from '../services/users.js'

export type AuthedRequest = Request & {
  user?: UserRow
  apiKeyId?: number
}

export function signUserToken(user: UserRow): string {
  return jwt.sign(
    { sub: user.id, oauthId: user.oauth_id, isAdmin: !!user.is_admin },
    config.jwtSecret,
    { expiresIn: config.jwtExpireHours * 3600 },
  )
}

export async function authJwt(req: AuthedRequest, res: Response, next: NextFunction) {
  const h = req.headers.authorization || ''
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  if (!token) {
    res.status(401).json({ code: 401, message: '未登录' })
    return
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret) as unknown as { sub: number }
    const user = getUserById(payload.sub)
    if (!user) {
      res.status(401).json({ code: 401, message: '用户不存在' })
      return
    }
    // 内置/环境种子管理员：每次鉴权时抬权（无需重新 OAuth）
    if (!user.is_admin && config.platformAdminOauthIds.has(user.oauth_id)) {
      user.is_admin = 1
      user.updated_at = now()
      await db.persist()
    }
    req.user = user
    next()
  } catch {
    res.status(401).json({ code: 401, message: '登录已失效' })
  }
}

export function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.user?.is_admin) {
    res.status(403).json({ code: 403, message: '需要管理员权限' })
    return
  }
  next()
}

export async function authApiKey(req: AuthedRequest, res: Response, next: NextFunction) {
  const raw = extractApiKey(req)
  if (!raw || !raw.startsWith('sk-')) {
    res.status(401).json({ code: 401, message: '缺少有效的 API Key' })
    return
  }
  const hash = hashToken(raw)
  const key = db.getStore().api_keys.find((k) => k.key_hash === hash && !k.revoked_at)
  if (!key) {
    res.status(401).json({ code: 401, message: 'API Key 无效或已吊销' })
    return
  }
  const user = getUserById(key.user_id)
  if (!user) {
    res.status(401).json({ code: 401, message: '用户不存在' })
    return
  }
  key.last_used_at = now()
  await db.persist()
  req.user = user
  req.apiKeyId = key.id
  next()
}

/**
 * 从请求中提取 API Key，兼容多种客户端：
 *  - Authorization: Bearer sk-...   （OpenAI SDK / 本平台）
 *  - x-api-key: sk-...               （Anthropic / Claude SDK）
 *  - api-key: sk-... / apikey: sk-...
 */
export function extractApiKey(req: AuthedRequest): string {
  const auth = req.headers.authorization || ''
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim()
  const x = (req.headers['x-api-key'] ||
    req.headers['api-key'] ||
    req.headers['apikey']) as string | undefined
  if (x) return x.trim()
  return ''
}

export function ok<T>(res: Response, data: T, message = 'ok') {
  res.json({ code: 0, message, data })
}

export function fail(res: Response, status: number, message: string) {
  res.status(status).json({ code: status, message })
}
