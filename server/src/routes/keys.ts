import { Router } from 'express'
import { config } from '../config.js'
import { db, now, newApiKeyPlain } from '../db.js'
import { authJwt, ok, fail, type AuthedRequest } from '../middleware/auth.js'

export const keysRouter = Router()
keysRouter.use(authJwt)

const MAX_KEYS_PER_USER = Math.max(1, Number(process.env.SSEAPI_MAX_KEYS_PER_USER) || 20)

keysRouter.get('/config', (_req, res) => {
  const host = config.apiPublicBase
  ok(res, {
    apiHost: host,
    maxKeysPerUser: MAX_KEYS_PER_USER,
    endpoints: {
      models: `${host}/v1/models`,
      chatCompletions: `${host}/v1/chat/completions`,
      embeddings: `${host}/v1/embeddings`,
      imagesGenerations: `${host}/v1/images/generations`,
      messages: `${host}/v1/messages`,
      responses: `${host}/v1/responses`,
    },
  })
})

keysRouter.get('/', (req: AuthedRequest, res) => {
  const rows = db
    .getStore()
    .api_keys.filter((k) => k.user_id === req.user!.id)
    .sort((a, b) => b.id - a.id)
    .map(({ id, name, key_prefix, allowed_origins, last_used_at, created_at, revoked_at }) => ({
      id,
      name,
      key_prefix,
      allowed_origins,
      last_used_at,
      created_at,
      revoked_at,
    }))
  ok(res, rows)
})

keysRouter.post('/', async (req: AuthedRequest, res) => {
  const active = db.getStore().api_keys.filter((k) => k.user_id === req.user!.id && !k.revoked_at)
  if (active.length >= MAX_KEYS_PER_USER) {
    fail(res, 400, `最多创建 ${MAX_KEYS_PER_USER} 个有效密钥，请先吊销旧密钥`)
    return
  }
  const name = String(req.body?.name || 'default').slice(0, 64)
  const allowed_origins = String(req.body?.allowedOrigins ?? req.body?.allowed_origins ?? '').slice(0, 2000)
  const rpm_limit = Math.max(0, Math.floor(Number(req.body?.rpmLimit ?? req.body?.rpm_limit ?? 0)) || 0)
  const max_concurrent = Math.max(0, Math.floor(Number(req.body?.maxConcurrent ?? req.body?.max_concurrent ?? 0)) || 0)
  const { plain, prefix, hash } = newApiKeyPlain()
  const t = now()
  const id = db.nextId('api_keys')
  db.getStore().api_keys.push({
    id,
    user_id: req.user!.id,
    name,
    key_prefix: prefix,
    key_hash: hash,
    allowed_origins,
    rpm_limit,
    max_concurrent,
    last_used_at: null,
    created_at: t,
    revoked_at: null,
  })
  await db.persist()
  ok(res, { id, name, key_prefix: prefix, key: plain, allowed_origins, created_at: t })
})

keysRouter.patch('/:id', async (req: AuthedRequest, res) => {
  const id = Number(req.params.id)
  const row = db.getStore().api_keys.find((k) => k.id === id && k.user_id === req.user!.id)
  if (!row || row.revoked_at) {
    fail(res, 404, '密钥不存在')
    return
  }
  if (req.body?.name != null) row.name = String(req.body.name).slice(0, 64)
  if (req.body?.allowedOrigins != null || req.body?.allowed_origins != null) {
    row.allowed_origins = String(req.body.allowedOrigins ?? req.body.allowed_origins).slice(0, 2000)
  }
  if (req.body?.rpmLimit != null || req.body?.rpm_limit != null) {
    row.rpm_limit = Math.max(0, Math.floor(Number(req.body.rpmLimit ?? req.body.rpm_limit)) || 0)
  }
  if (req.body?.maxConcurrent != null || req.body?.max_concurrent != null) {
    row.max_concurrent = Math.max(0, Math.floor(Number(req.body.maxConcurrent ?? req.body.max_concurrent)) || 0)
  }
  await db.persist()
  ok(res, {
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    allowed_origins: row.allowed_origins,
  })
})

keysRouter.delete('/:id', async (req: AuthedRequest, res) => {
  const id = Number(req.params.id)
  const row = db.getStore().api_keys.find((k) => k.id === id && k.user_id === req.user!.id)
  if (!row) {
    fail(res, 404, '密钥不存在')
    return
  }
  row.revoked_at = now()
  await db.persist()
  ok(res, { id })
})
