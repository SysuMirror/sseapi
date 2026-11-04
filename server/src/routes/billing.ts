import { Router } from 'express'
import { db } from '../db.js'
import { authJwt, ok, type AuthedRequest } from '../middleware/auth.js'
import { centsToYuan, creditUser } from '../services/users.js'

/** 每日签到奖励（分）：5 元；早间雪峰奖励另加 5 元。 */
const DAILY_REWARD_CENTS = 500
const PEAK_REWARD_CENTS = 500
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

type GrantKind = 'daily' | 'peak'

function shanghaiNow(): Date { return new Date(Date.now() + SHANGHAI_OFFSET_MS) }
function shanghaiDate(now = shanghaiNow()): string { return now.toISOString().slice(0, 10) }
function isPeakWindow(now = shanghaiNow()): boolean {
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes()
  return minutes >= 390 && minutes < 510
}
function isGrantForDate(createdAt: string, date: string): boolean {
  const instant = new Date(createdAt).getTime()
  if (!Number.isFinite(instant)) return createdAt.startsWith(date)
  return shanghaiDate(new Date(instant + SHANGHAI_OFFSET_MS)) === date
}
async function grantStatus(userId: number) {
  const date = shanghaiDate()
  // 只看最近两天的流水就够了（isGrantForDate 只关心「今天」），
  // 交给 SQL 用 (user_id, ts) 索引取，不必把整张表读进来
  const ledger = db.queryLedger({
    userId,
    from: Date.now() - 48 * 60 * 60 * 1000,
    kinds: ['daily', 'peak', 'checkin'],
  })
  const has = (kind: GrantKind | 'checkin') => ledger.some(
    (l) => l.kind === kind && isGrantForDate(l.created_at, date),
  )
  return { date, dailyClaimed: has('daily') || has('checkin'), peakClaimed: has('peak'), peakAvailable: isPeakWindow() }
}

export const billingRouter = Router()
billingRouter.use(authJwt)

billingRouter.get('/summary', async (req: AuthedRequest, res) => {
  const userId = req.user!.id
  // 充值/消费都是全时段累计，交给 SQL 聚合出两个数字
  const credited = db.ledgerSum({
    userId,
    kinds: ['credit', 'checkin', 'daily', 'peak'],
    positiveOnly: true,
  })
  const totals = db.usageTotals({ userId, onlyOk: true })

  const totalCredited = credited.total
  const totalSpent = totals.cost_cents
  const totalRequests = totals.request_count
  const totalTokens = totals.total_tokens

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

/** 查询今日签到状态：北京时间 06:30-08:30 可领取雪峰奖励。 */
billingRouter.get('/checkin', async (req: AuthedRequest, res) => {
  const status = await grantStatus(req.user!.id)
  ok(res, { ...status, checkedIn: status.dailyClaimed, dailyRewardYuan: 5, peakRewardYuan: 5 })
})

let checkinQueue: Promise<void> = Promise.resolve()
billingRouter.post('/checkin', async (req: AuthedRequest, res, next) => {
  const userId = req.user!.id
  const task = checkinQueue.then(async () => {
    const before = await grantStatus(userId)
    const grants: GrantKind[] = []
    if (!before.dailyClaimed) grants.push('daily')
    if (before.peakAvailable && !before.peakClaimed) grants.push('peak')
    let balanceCents = req.user!.balance_cents
    for (const kind of grants) {
      const user = await creditUser(userId, 500, kind, kind === 'daily' ? '每日签到奖励' : '雪峰早间签到奖励')
      balanceCents = user.balance_cents
    }
    const status = await grantStatus(userId)
    ok(res, { ...status, checkedIn: status.dailyClaimed, already: grants.length === 0, granted: grants,
      rewardYuan: grants.length * 5, dailyRewardYuan: 5, peakRewardYuan: 5,
      balanceCents, balanceYuan: centsToYuan(balanceCents), message: grants.length ? '签到奖励已到账' : '今日可领取的奖励已领取' })
  })
  checkinQueue = task.then(() => undefined, () => undefined)
  try { await task } catch (error) { next(error) }
})

billingRouter.get('/ledger', async (req: AuthedRequest, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(req.query.page_size) || 20))
  const userId = req.user!.id
  const total = db.countLedger({ userId })
  const items = db
    .queryLedger({ userId, limit: pageSize, offset: (page - 1) * pageSize })
    .map((r) => ({
      ...r,
      amountYuan: centsToYuan(r.amount_cents),
      balanceAfterYuan: centsToYuan(r.balance_after),
    }))
  ok(res, { page, pageSize, total, items })
})
