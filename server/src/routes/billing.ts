import { Router } from 'express'
import { db } from '../db.js'
import { authJwt, ok, type AuthedRequest } from '../middleware/auth.js'
import { centsToYuan } from '../services/users.js'

export const billingRouter = Router()
billingRouter.use(authJwt)

billingRouter.get('/summary', (req: AuthedRequest, res) => {
  const userId = req.user!.id
  const ledger = db.getStore().ledger.filter((l) => l.user_id === userId)
  const usageLogs = db.getStore().usage_logs.filter((l) => l.user_id === userId && l.status === 'ok')

  const totalCredited = ledger
    .filter((l) => l.kind === 'credit' && l.amount_cents > 0)
    .reduce((a, l) => a + l.amount_cents, 0)
  const totalSpent = usageLogs.reduce((a, l) => a + l.cost_cents, 0)
  const totalRequests = usageLogs.length
  const totalTokens = usageLogs.reduce((a, l) => a + l.total_tokens, 0)

  ok(res, {
    balanceCents: req.user!.balance_cents,
    balanceYuan: centsToYuan(req.user!.balance_cents),
    totalCreditedCents: totalCredited,
    totalCreditedYuan: centsToYuan(totalCredited),
    totalSpentCents: totalSpent,
    totalSpentYuan: centsToYuan(totalSpent),
    totalRequests,
    totalTokens,
  })
})

billingRouter.get('/balance', (req: AuthedRequest, res) => {
  ok(res, {
    balanceCents: req.user!.balance_cents,
    balanceYuan: centsToYuan(req.user!.balance_cents),
  })
})

billingRouter.get('/ledger', (req: AuthedRequest, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(req.query.page_size) || 20))
  const all = db
    .getStore()
    .ledger.filter((l) => l.user_id === req.user!.id)
    .sort((a, b) => b.id - a.id)
  const total = all.length
  const items = all.slice((page - 1) * pageSize, page * pageSize).map((r) => ({
    ...r,
    amountYuan: centsToYuan(r.amount_cents),
    balanceAfterYuan: centsToYuan(r.balance_after),
  }))
  ok(res, { page, pageSize, total, items })
})
