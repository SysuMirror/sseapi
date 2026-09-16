import { Router } from 'express'
import { db } from '../db.js'
import { authJwt, ok, type AuthedRequest } from '../middleware/auth.js'
import { centsToYuan, creditUser } from '../services/users.js'

/** 每日签到奖励（分）：10 元 */
const CHECKIN_REWARD_CENTS = 1000

function todayStr(): string {
  return new Date().toISOString().slice(0, 10) // YYYY-MM-DD
}

async function hasCheckedInToday(userId: number): Promise<boolean> {
  const today = todayStr()
  return (await db.readLedger()).some(
      (l) => l.user_id === userId && l.kind === 'checkin' && l.created_at.startsWith(today),
    )
}

export const billingRouter = Router()
billingRouter.use(authJwt)

billingRouter.get('/summary', async (req: AuthedRequest, res) => {
  const userId = req.user!.id
  const ledger = (await db.readLedger()).filter((l) => l.user_id === userId)
  const usageLogs = (await db.readUsageLogs()).filter((l) => l.user_id === userId && l.status === 'ok')

  const totalCredited = ledger
    .filter((l) => ['credit', 'checkin'].includes(l.kind) && l.amount_cents > 0)
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

/** 查询今日签到状态 */
billingRouter.get('/checkin', async (req: AuthedRequest, res) => {
  ok(res, {
    checkedIn: await hasCheckedInToday(req.user!.id),
    rewardYuan: CHECKIN_REWARD_CENTS / 100,
  })
})

// A single queue protects the read/check/write sequence, including archive reads.
// The JSON store is single-process; cross-process writers require a database lock.
let checkinQueue: Promise<void> = Promise.resolve()

/** 每日签到：每天一次，奖励 10 元余额 */
billingRouter.post('/checkin', async (req: AuthedRequest, res, next) => {
  const userId = req.user!.id
  const task = checkinQueue.then(async () => {
    if (await hasCheckedInToday(userId)) {
      ok(res, {
        checkedIn: true,
        already: true,
        rewardYuan: CHECKIN_REWARD_CENTS / 100,
        message: '今日已签到',
      })
      return
    }
    const user = await creditUser(userId, CHECKIN_REWARD_CENTS, 'checkin', '每日签到奖励')
    ok(res, {
      checkedIn: true,
      already: false,
      rewardYuan: CHECKIN_REWARD_CENTS / 100,
      balanceCents: user.balance_cents,
      balanceYuan: centsToYuan(user.balance_cents),
    })
  })
  checkinQueue = task.then(() => undefined, () => undefined)
  try { await task } catch (error) { next(error) }
})

billingRouter.get('/ledger', async (req: AuthedRequest, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(req.query.page_size) || 20))
  const all = (await db.readLedger()).filter((l) => l.user_id === req.user!.id)
    .sort((a, b) => b.id - a.id)
  const total = all.length
  const items = all.slice((page - 1) * pageSize, page * pageSize).map((r) => ({
    ...r,
    amountYuan: centsToYuan(r.amount_cents),
    balanceAfterYuan: centsToYuan(r.balance_after),
  }))
  ok(res, { page, pageSize, total, items })
})
