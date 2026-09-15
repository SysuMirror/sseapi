import { config } from '../config.js'
import { db, now, type UserRow } from '../db.js'

export type { UserRow }

export async function upsertUserFromOAuth(profile: {
  user_id: number | string
  name: string
  email?: string
  avatar_url?: string
}): Promise<UserRow> {
  const oauthId = String(profile.user_id)
  const t = now()
  const s = db.getStore()
  const existing = s.users.find((u) => u.oauth_id === oauthId)
  const seedAdmin = config.platformAdminOauthIds.has(oauthId) ? 1 : 0

  if (!existing) {
    const user: UserRow = {
      id: db.nextId('users'),
      oauth_id: oauthId,
      name: profile.name || `用户${oauthId}`,
      email: profile.email || '',
      avatar_url: profile.avatar_url || '',
      is_admin: seedAdmin,
      balance_cents: 0,
      admin_note: '',
      rpm_limit: 0,
      max_concurrent: 0,
      created_at: t,
      updated_at: t,
    }
    s.users.push(user)
    await db.persist()
    return user
  }

  existing.name = profile.name || existing.name
  existing.email = profile.email || existing.email
  existing.avatar_url = profile.avatar_url || existing.avatar_url
  existing.is_admin = existing.is_admin || seedAdmin
  existing.updated_at = t
  await db.persist()
  return existing
}

export function getUserById(id: number): UserRow | undefined {
  return db.getStore().users.find((u) => u.id === id)
}

export function getUserByOauthId(oauthId: string): UserRow | undefined {
  const id = String(oauthId || '').trim()
  if (!id) return undefined
  return db.getStore().users.find((u) => u.oauth_id === id)
}

export function publicUser(u: UserRow, opts?: { admin?: boolean }) {
  const base = {
    id: u.id,
    oauthId: u.oauth_id,
    name: u.name,
    email: u.email,
    avatarUrl: u.avatar_url,
    isAdmin: !!u.is_admin,
    balanceCents: u.balance_cents,
  }
  if (opts?.admin) {
    return {
      ...base,
      adminNote: u.admin_note || '',
      rpmLimit: u.rpm_limit || 0,
      maxConcurrent: u.max_concurrent || 0,
      updatedAt: u.updated_at,
      createdAt: u.created_at,
    }
  }
  return base
}

/** 将余额设为绝对值（元→分在路由层换算） */
export async function setUserBalance(
  userId: number,
  balanceCents: number,
  note: string,
  operatorId?: number,
): Promise<UserRow> {
  if (!Number.isFinite(balanceCents) || balanceCents < 0) {
    throw new Error('余额无效')
  }
  return db.transaction(() => {
    const u = db.getStore().users.find((x) => x.id === userId)
    if (!u) throw new Error('用户不存在')
    const delta = Math.round(balanceCents) - u.balance_cents
    u.balance_cents = Math.round(balanceCents)
    u.updated_at = now()
    db.getStore().ledger.push({
      id: db.nextId('ledger'),
      user_id: userId,
      kind: 'adjust',
      amount_cents: delta,
      balance_after: u.balance_cents,
      note: note || '管理员设定余额',
      operator_id: operatorId ?? null,
      created_at: now(),
    })
    pruneLedger()
    return u
  })
}

/** 裁剪 ledger：保留最近 10000 条，防止 store 无限增长导致 OOM */
function pruneLedger() {
  const MAX_LEDGER = 10000
  const ledger = db.getStore().ledger
  if (ledger.length > MAX_LEDGER) {
    ledger.splice(0, ledger.length - MAX_LEDGER)
  }
}

export function centsToYuan(cents: number): number {
  return Math.round(cents) / 100
}

export async function creditUser(
  userId: number,
  amountCents: number,
  kind: string,
  note: string,
  operatorId?: number,
): Promise<UserRow> {
  return db.transaction(() => {
    const u = db.getStore().users.find((x) => x.id === userId)
    if (!u) throw new Error('用户不存在')
    const next = u.balance_cents + amountCents
    if (next < 0) throw new Error('余额不足')
    u.balance_cents = next
    u.updated_at = now()
    db.getStore().ledger.push({
      id: db.nextId('ledger'),
      user_id: userId,
      kind,
      amount_cents: amountCents,
      balance_after: next,
      note,
      operator_id: operatorId ?? null,
      created_at: now(),
    })
    pruneLedger()
    return u
  })
}

/**
 * 计费：未命中输入 × 输入价 + 缓存命中 × 缓存价 + 输出 × 输出价（均为 ¥/1M tokens）
 * + 可选图片 token 价 / 按张计价。
 * prompt = 未命中 + 命中；cached 不得超过 prompt。
 * 用整数路径换算到「分」再 ceil，避免 IEEE 浮点误差。
 */
export type CostExtras = {
  /** token=图片计入 prompt；per_image=另收每张图费用并从 prompt 扣减预估图 token */
  imageBillingMode?: 'token' | 'per_image'
  imageCount?: number
  /** ¥ / 张 */
  imagePricePerImage?: number
  /** 按张计费时，从 prompt 中扣除的「每图约多少 token」，避免与上游图 token 双重计费 */
  imageTokensPerImage?: number
  /** 上游拆出的 image tokens（若有）；token 模式下可走独立图片单价 */
  imageTokens?: number
  /** ¥ / 1M image tokens；0 表示与输入价相同（不单独拆） */
  imagePer1m?: number
}

export function calcCostCents(
  promptTokens: number,
  completionTokens: number,
  inputPer1m: number,
  outputPer1m: number,
  cachedTokens = 0,
  cachePer1m = 0,
  extras: CostExtras = {},
): number {
  const prompt = Math.max(0, Math.floor(Number(promptTokens) || 0))
  const cached = Math.min(prompt, Math.max(0, Math.floor(Number(cachedTokens) || 0)))
  let fresh = prompt - cached
  const out = Math.max(0, Math.floor(Number(completionTokens) || 0))
  const imageCount = Math.max(0, Math.floor(Number(extras.imageCount) || 0))
  const mode = extras.imageBillingMode || 'token'

  let imageTokenBill = 0
  let perImageYuan = 0

  if (mode === 'per_image' && imageCount > 0) {
    const perImgTok = Math.max(0, Math.floor(Number(extras.imageTokensPerImage) || 0))
    const deduct = Math.min(fresh, imageCount * perImgTok)
    fresh -= deduct
    perImageYuan = imageCount * (Number(extras.imagePricePerImage) || 0)
  } else if (mode === 'token') {
    const imgTokRaw = Math.max(0, Math.floor(Number(extras.imageTokens) || 0))
    const imgPer1m = Number(extras.imagePer1m) || 0
    if (imgTokRaw > 0 && imgPer1m > 0) {
      const imgTok = Math.min(fresh, imgTokRaw)
      fresh -= imgTok
      imageTokenBill = imgTok * imgPer1m
    }
  }

  // sum(token * ¥/1M) → 元 = sum/1e6 → 分 = ceil(sum/1e4)
  const sum =
    fresh * (Number(inputPer1m) || 0) +
    cached * (Number(cachePer1m) || 0) +
    out * (Number(outputPer1m) || 0) +
    imageTokenBill

  let cents = sum > 0 ? Math.max(0, Math.ceil(sum / 10_000)) : 0
  if (perImageYuan > 0) {
    // ¥ → 分，ceil；用 1e6 缩放减轻浮点
    cents += Math.max(0, Math.ceil(Math.round(perImageYuan * 1_000_000) / 10_000))
  }
  return cents
}
