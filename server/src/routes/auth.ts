import { Router } from 'express'
import { config, isOAuthConfigured } from '../config.js'
import {
  buildAuthorizeUrl,
  consumeOAuthState,
  createOAuthState,
  exchangeCodeForToken,
  fetchOAuthUserInfo,
  putSession,
  takeSession,
} from '../services/oauth.js'
import { publicUser, upsertUserFromOAuth } from '../services/users.js'
import { authJwt, ok, fail, signUserToken, type AuthedRequest } from '../middleware/auth.js'

export const authRouter = Router()

authRouter.get('/oauth/config', (_req, res) => {
  if (!isOAuthConfigured()) {
    fail(res, 503, 'OAuth 未配置，请设置 SSEAPI_OAUTH_APP_ID / SECRET / REDIRECT_URI')
    return
  }
  ok(res, {
    configured: true,
    provider: config.oauth.baseUrl,
    appId: config.oauth.appId,
  })
})

authRouter.get('/oauth/login-url', async (_req, res) => {
  if (!isOAuthConfigured()) {
    fail(res, 503, 'OAuth 未配置')
    return
  }
  const state = await createOAuthState()
  ok(res, { authorize_url: buildAuthorizeUrl(state), state })
})

authRouter.post('/oauth/token', async (req, res) => {
  try {
    const { code, state } = req.body || {}
    if (!code || !state) {
      fail(res, 400, '缺少 code 或 state')
      return
    }
    if (!(await consumeOAuthState(String(state)))) {
      fail(res, 400, 'state 无效或已过期')
      return
    }
    const token = await exchangeCodeForToken(String(code))
    const sessionId = putSession(token.access_token)
    ok(res, { session_id: sessionId })
  } catch (e) {
    fail(res, 400, e instanceof Error ? e.message : '换票失败')
  }
})

authRouter.post('/oauth/userinfo', async (req, res) => {
  try {
    const { session_id: sessionId } = req.body || {}
    if (!sessionId) {
      fail(res, 400, '缺少 session_id')
      return
    }
    const accessToken = takeSession(String(sessionId))
    if (!accessToken) {
      fail(res, 400, 'session 无效或已过期')
      return
    }
    const profile = await fetchOAuthUserInfo(accessToken)
    const user = await upsertUserFromOAuth(profile)
    const token = signUserToken(user)
    ok(res, { token, user: publicUser(user), profile })
  } catch (e) {
    fail(res, 400, e instanceof Error ? e.message : '登录失败')
  }
})

authRouter.get('/me', authJwt, (req: AuthedRequest, res) => {
  ok(res, publicUser(req.user!))
})
