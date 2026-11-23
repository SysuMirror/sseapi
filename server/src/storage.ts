import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { config } from './config.js'
import { db } from './db.js'
import { closeDb, dbPath, openDb, snapshotTo } from './sqlite.js'

const gzip = promisify(zlib.gzip)
const gunzip = promisify(zlib.gunzip)

/**
 * MinIO 备份层。
 *
 * SQLite 文件（~80MB）是唯一的事实来源，跑在持久盘上；
 * MinIO 只放「异地快照」：VACUUM INTO 出一份一致的副本 → gzip → 上传。
 *
 * 旧实现是每次把 200MB+ 的历史整份重新 PUT，还带一次同步 readFileSync，
 * 既是卡顿主因也是内存暴涨的来源；现在一次备份是几十 MB 且频率可调。
 */

/** 桶内对象键；与平台「同步历史数据」目录结构一致 */
export const STORE_OBJECT_KEY = 'data/sseapi-store.json'
export const DB_OBJECT_KEY = 'data/sseapi.db.gz'

export type HistoryTable = 'usage_logs' | 'ledger'

function env(key: string): string {
  return (process.env[key] ?? '').trim()
}

export function isMinioConfigured(): boolean {
  return Boolean(
    env('MINIO_ENDPOINT') && env('MINIO_ACCESS_KEY') && env('MINIO_SECRET') && env('MINIO_BUCKET'),
  )
}

export function storeBackendLabel(): string {
  if (!isMinioConfigured()) return 'local'
  return `sqlite:${dbPath()} + minio:${env('MINIO_BUCKET')}`
}

let s3: S3Client | null = null

function getS3(): S3Client {
  if (s3) return s3
  s3 = new S3Client({
    endpoint: env('MINIO_ENDPOINT'),
    region: 'us-east-1',
    credentials: {
      accessKeyId: env('MINIO_ACCESS_KEY'),
      secretAccessKey: env('MINIO_SECRET'),
    },
    forcePathStyle: true,
  })
  return s3
}

function bucket(): string {
  return env('MINIO_BUCKET')
}

function isNotFound(e: unknown): boolean {
  const name = e && typeof e === 'object' && 'name' in e ? String(e.name) : ''
  const code =
    e && typeof e === 'object' && '$metadata' in e
      ? (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      : undefined
  return name === 'NoSuchKey' || name === 'NotFound' || code === 404
}

async function readObjectBytes(key: string): Promise<Buffer | null> {
  try {
    const res = await getS3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }))
    if (!res.Body) return null
    return Buffer.from(await res.Body.transformToByteArray())
  } catch (e) {
    if (isNotFound(e)) return null
    throw e
  }
}

async function writeObject(key: string, body: Buffer | string, contentType: string): Promise<void> {
  await getS3().send(
    new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType }),
  )
}

// ── 冷启动还原 ──
// 本地 db 不存在（新 Pod / 盘被清）时，从 MinIO 拉回最近一次快照。
export async function restoreDbIfMissing(): Promise<boolean> {
  const target = dbPath()
  if (fs.existsSync(target)) return false
  if (!isMinioConfigured()) return false
  const packed = await readObjectBytes(DB_OBJECT_KEY)
  if (!packed) return false
  await fsp.mkdir(config.dataDir, { recursive: true })
  const raw = await gunzip(packed)
  await fsp.writeFile(target, raw)
  console.log(`[sseapi] 已从 MinIO 还原数据库快照：${(raw.length / 1048576).toFixed(1)}MB`)
  return true
}

// ── 备份 ──
// 一次快照是几十 MB（gzip 后），这是异地灾备而不是主存储（主存储在持久盘上），
// 所以按半小时一次：RPO 半小时，同时对共享 MinIO 的压力可控。
const BACKUP_MS = Math.max(60_000, Number(process.env.SSEAPI_BACKUP_MS) || 30 * 60_000)
const MINIO_SYNC_MS = Math.max(5_000, Number(process.env.SSEAPI_MINIO_SYNC_MS) || 30_000)

let backupTimer: ReturnType<typeof setTimeout> | null = null
let backupRunning = false
let backupFailLogAt = 0

async function runBackup(): Promise<void> {
  if (!isMinioConfigured() || backupRunning) return
  backupRunning = true
  const tmp = path.join(config.dataDir, `.backup-${process.pid}.db`)
  try {
    // 先把 WAL 合并回主库，避免它无限增长占盘（后台写入量大时尤其明显）
    try {
      openDb().pragma('wal_checkpoint(TRUNCATE)')
    } catch {
      /* 有并发读时 checkpoint 可能被跳过，下次再来 */
    }
    // VACUUM INTO 不阻塞读，产出的是整理过的单文件（不含 -wal/-shm）
    fs.rmSync(tmp, { force: true })
    snapshotTo(tmp)
    const raw = await fsp.readFile(tmp)
    const packed = await gzip(raw)
    await writeObject(DB_OBJECT_KEY, packed, 'application/gzip')
    // 兼容旧结构：store JSON 很小（约 50KB），顺带导出给平台的同步工具
    await writeObject(STORE_OBJECT_KEY, JSON.stringify(exportLegacyStore()), 'application/json; charset=utf-8')
    console.log(
      `[sseapi] 备份完成：db ${(raw.length / 1048576).toFixed(1)}MB → gz ${(packed.length / 1048576).toFixed(1)}MB`,
    )
  } finally {
    fs.rmSync(tmp, { force: true })
    backupRunning = false
  }
}

export function scheduleBackup(): void {
  if (!isMinioConfigured()) return
  if (backupTimer) return
  const t = setTimeout(() => {
    backupTimer = null
    runBackup().catch((e) => {
      if (Date.now() - backupFailLogAt > 60_000) {
        backupFailLogAt = Date.now()
        console.error('[sseapi] MinIO 备份失败(本地数据完好,稍后重试):', e instanceof Error ? e.message : e)
      }
      scheduleBackup()
    })
  }, MINIO_SYNC_MS)
  t.unref?.()
  backupTimer = t
}

/** 定时备份（默认 15 分钟） */
export function startBackupLoop(): void {
  if (!isMinioConfigured()) return
  const tick = () => {
    runBackup().catch((e) => {
      console.error('[sseapi] 定时备份失败:', e instanceof Error ? e.message : e)
    })
  }
  const t = setInterval(tick, BACKUP_MS)
  t.unref?.()
  // 首启延迟一次，避免和冷启动抢 IO
  const first = setTimeout(tick, Math.min(BACKUP_MS, 60_000))
  first.unref?.()
}

/** 优雅退出：落盘 WAL + 立刻做一次备份 */
export async function shutdown(): Promise<void> {
  try {
    closeDb()
  } catch {
    /* ignore */
  }
  if (!isMinioConfigured()) return
  try {
    await runBackup()
  } catch {
    /* 退出路径不再报错 */
  }
}

/** 旧结构的 store JSON（仅配置类小表，不含明细） */
function exportLegacyStore(): Record<string, unknown> {
  const s = db.getStore()
  return {
    seq: s.seq,
    users: s.users,
    api_keys: s.api_keys,
    models: s.models,
    docs: s.docs,
    oauth_states: s.oauth_states,
    rate_limits: s.rate_limits,
  }
}

export { openDb }
