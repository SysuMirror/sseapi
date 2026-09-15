import { Router } from 'express'
import { db } from '../db.js'
import { authJwt, ok, type AuthedRequest } from '../middleware/auth.js'
import { mapModelConsole } from '../services/model-catalog.js'
import { mayAccessDevOnly } from '../services/dev-platform.js'

export const modelsRouter = Router()

modelsRouter.get('/', authJwt, async (req: AuthedRequest, res) => {
  const admin = !!req.user!.is_admin
  const canDev = admin || (await mayAccessDevOnly(req))
  const rows = db
    .getStore()
    .models.filter((m) => (admin || m.enabled) && (!m.dev_only || canDev))
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
  ok(
    res,
    rows.map((r) => mapModelConsole(r, admin)),
  )
})

modelsRouter.get('/:slug', authJwt, async (req: AuthedRequest, res) => {
  const admin = !!req.user!.is_admin
  const canDev = admin || (await mayAccessDevOnly(req))
  const row = db.getStore().models.find((m) => m.slug === req.params.slug)
  if (!row || (!row.enabled && !admin) || (row.dev_only && !canDev)) {
    res.status(404).json({ code: 404, message: '模型不存在' })
    return
  }
  ok(res, mapModelConsole(row, admin))
})
