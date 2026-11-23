import fs from 'node:fs'
import path from 'node:path'
import { loadEnvFile } from './load-env.js'

// 必须在读取任何 env 之前执行。
// index.ts 里那句 loadEnvFile() 其实来不及：ESM 的 import 会先于模块体求值，
// config.ts 早就把 JWT_SECRET 等读完了（线上靠 deploy.sh 先 source server/.env 才没暴露）。
loadEnvFile()

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

// 集市内置平台管理员（user_id 327）在 UniSSO 的 sub
const BUILTIN_ADMIN_SUB = '5dba4932-eb5a-4f80-8ff6-dcf1f1a460a5'

export const config = {
  port: Number(env('PORT', '8080')),
  dataDir,
  jwtSecret: env('JWT_SECRET') || 'dev-insecure-secret-change-me',
  jwtExpireHours: Number(env('JWT_EXPIRE_HOURS', '168')),
  /** @deprecated 请用 apiPublicBase；保留兼容旧引用 */
  publicBase: resolveApiPublicBase(),
  apiPublicBase: resolveApiPublicBase(),
  frontendDist: env('SSEAPI_FRONTEND_DIST') || path.join(process.cwd(), '../web/dist'),
  /** 平台管理员白名单：UniSSO sub（sub 为登录主键） */
  platformAdminSubs: new Set(
    [
      BUILTIN_ADMIN_SUB,
      ...env('PLATFORM_ADMIN_UNISSO_SUBS')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ],
  ),
  // UniSSO 机器对机器密码校验（无 OAuth 跳转）：
  // POST {issuer}/api/oauth/password/verify，form: email/password/client_id/client_secret
  oauth: {
    issuer: env('UNISSO_ISSUER', 'https://sso.ssemarket.cn').replace(/\/$/, ''),
    clientId: env('UNISSO_CLIENT_ID'),
    clientSecret: env('UNISSO_CLIENT_SECRET'),
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
  return Boolean(config.oauth.issuer && config.oauth.clientId && config.oauth.clientSecret)
}
