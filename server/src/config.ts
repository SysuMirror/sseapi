import fs from 'node:fs'
import path from 'node:path'

function env(key: string, fallback = ''): string {
  return (process.env[key] ?? fallback).trim()
}

/** OpenAI 兼容 /v1 调用的公网根地址（与控制台域名分离） */
function resolveApiPublicBase(): string {
  const direct = env('SSEAPI_API_PUBLIC_URL') || env('SDPY_API_PUBLIC_URL')
  if (direct) return direct.replace(/\/$/, '')

  const pub = env('PUBLIC_BASE') || env('SDPY_PUBLIC_URL')
  if (pub) {
    const u = pub.replace(/\/$/, '')
    if (/platform\.ssemarket\.cn/i.test(u)) return u.replace(/platform\./i, 'api.')
    return u
  }
  return 'https://api.ssemarket.cn'
}

const dataDir = env('DATA_DIR') || env('SDPY_DATA_DIR') || path.join(process.cwd(), 'data')
fs.mkdirSync(dataDir, { recursive: true })

export const config = {
  port: Number(env('PORT', '8080')),
  dataDir,
  jwtSecret: env('JWT_SECRET') || 'dev-insecure-secret-change-me',
  jwtExpireHours: Number(env('JWT_EXPIRE_HOURS', '168')),
  /** @deprecated 请用 apiPublicBase；保留兼容旧引用 */
  publicBase: resolveApiPublicBase(),
  apiPublicBase: resolveApiPublicBase(),
  frontendDist: env('SSEAPI_FRONTEND_DIST') || path.join(process.cwd(), '../web/dist'),
  platformAdminOauthIds: new Set(
    [
      '327', // 内置平台管理员（集市 user_id）
      ...env('PLATFORM_ADMIN_OAUTH_IDS')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ],
  ),
  oauth: {
    baseUrl: env('SSEAPI_OAUTH_BASE_URL', 'https://ssemarket.cn/new'),
    apiBaseUrl:
      env('SSEAPI_OAUTH_API_BASE_URL') ||
      env('SSEAPI_OAUTH_BASE_URL', 'https://ssemarket.cn/new').replace(/\/new\/?$/, '') ||
      'https://ssemarket.cn',
    appId: env('SSEAPI_OAUTH_APP_ID') || env('OAUTH_APP_ID'),
    appSecret: env('SSEAPI_OAUTH_APP_SECRET') || env('OAUTH_APP_SECRET'),
    redirectUri: env('SSEAPI_OAUTH_REDIRECT_URI') || env('OAUTH_REDIRECT_URI'),
    authorizePath: env('SSEAPI_OAUTH_AUTHORIZE_PATH', '/connect'),
    scope: env('SSEAPI_OAUTH_SCOPE', 'read_basic'),
  },

  /**
   * 集市开发者平台（developer-api）开放 API 对接。
   * 用于管理台判定某用户是否「集市开发者」并展示其需求单。
   * developerApiBase：开发者平台根地址（默认 https://developer.ssemarket.cn）
   * developerModuleSlug：开放 API 模块名（默认 platform）
   * developerModulePrivateKey：该模块的 SM2 私钥（64 hex）
   */
  developerApiBase: env('DEVELOPER_API_BASE', 'https://developer.ssemarket.cn').replace(/\/$/, ''),
  developerModuleSlug: env('DEVELOPER_MODULE_SLUG', 'platform'),
  developerModulePrivateKey: env('DEVELOPER_MODULE_PRIVATE_KEY'),
}

export function isOAuthConfigured(): boolean {
  return Boolean(config.oauth.appId && config.oauth.appSecret && config.oauth.redirectUri)
}
