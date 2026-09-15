import { Router } from 'express'
import { db, DEFAULT_DOCS_URL } from '../db.js'
import { authJwt, ok } from '../middleware/auth.js'
import { config } from '../config.js'

export const docsRouter = Router()

docsRouter.get('/', authJwt, (_req, res) => {
  const doc = db.getStore().docs
  const host = config.apiPublicBase
  const url = String(doc.external_url || DEFAULT_DOCS_URL).trim() || DEFAULT_DOCS_URL
  ok(res, {
    title: doc.title || 'API 文档',
    url,
    external: true,
    updatedAt: doc.updated_at,
    apiHost: host,
  })
})
