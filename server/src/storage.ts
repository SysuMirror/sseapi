import fs from 'node:fs'
import path from 'node:path'
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { config } from './config.js'

/** 桶内对象键；与平台「同步历史数据」目录结构一致 */
export const STORE_OBJECT_KEY = 'data/sseapi-store.json'
export const HISTORY_OBJECT_KEYS = { usage_logs: 'data/history/usage_logs.jsonl', ledger: 'data/history/ledger.jsonl' } as const

const localPath = () => path.join(config.dataDir, 'sseapi-store.json')

function env(key: string): string {
  return (process.env[key] ?? '').trim()
}

export function isMinioConfigured(): boolean {
  return Boolean(
    env('MINIO_ENDPOINT') &&
      env('MINIO_ACCESS_KEY') &&
      env('MINIO_SECRET') &&
      env('MINIO_BUCKET'),
  )
}

export function storeBackendLabel(): string {
  if (!isMinioConfigured()) return 'local'
  return `minio:${env('MINIO_BUCKET')}`
}

let s3: S3Client | null = null

function getS3(): S3Client {
  if (s3) return s3
  const endpoint = env('MINIO_ENDPOINT')
  s3 = new S3Client({
    endpoint,
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

async function readFromMinio(): Promise<string | null> {
  try {
    const res = await getS3().send(
      new GetObjectCommand({ Bucket: bucket(), Key: STORE_OBJECT_KEY }),
    )
    if (!res.Body) return null
    return await res.Body.transformToString('utf8')
  } catch (e: unknown) {
    const name = e && typeof e === 'object' && 'name' in e ? String(e.name) : ''
    const code =
      e && typeof e === 'object' && '$metadata' in e
        ? (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
        : undefined
    if (name === 'NoSuchKey' || code === 404) return null
    throw e
  }
}

async function existsInMinio(): Promise<boolean> {
  try {
    await getS3().send(new HeadObjectCommand({ Bucket: bucket(), Key: STORE_OBJECT_KEY }))
    return true
  } catch {
    return false
  }
}

function readLocal(): string | null {
  const p = localPath()
  if (!fs.existsSync(p)) return null
  return fs.readFileSync(p, 'utf8')
}

function writeLocal(content: string): void {
  fs.mkdirSync(config.dataDir, { recursive: true })
  const p = localPath()
  const tmp = `${p}.${process.pid}.tmp`
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, p)
}

async function writeMinio(content: string): Promise<void> {
  await getS3().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: STORE_OBJECT_KEY,
      Body: content,
      ContentType: 'application/json; charset=utf-8',
    }),
  )
}

export function localHistoryPath(table: keyof typeof HISTORY_OBJECT_KEYS): string { return path.join(config.dataDir, `${table}.jsonl`) }
function uniqueHistory(rows: any[]): any[] {
  return [...new Map(rows.map((row) => [row.id, row])).values()].sort((a, b) => a.id - b.id)
}

// ── MinIO 同步去抖 ──
// 之前每次 persist 都全量 PUT store + 全量读改写历史,大对象 PUT 反复超时(12s),
// persist 队列堵塞导致内存堆积到 2GB OOM。本地文件才是持久化主路径,
// MinIO 只是异地备份:本地写完立即返回,远端同步最多每 SYNC_MS 一次(尾沿触发)。
const MINIO_SYNC_MS = Math.max(5_000, Number(process.env.SSEAPI_MINIO_SYNC_MS) || 30_000)
const minioSyncTimers = new Map<string, ReturnType<typeof setTimeout>>()
let minioSyncFailLogAt = 0

function scheduleMinioSync(key: string, upload: () => Promise<void>): void {
  if (!isMinioConfigured()) return
  if (minioSyncTimers.has(key)) return // 已有待同步任务,尾沿定时器会带上最新内容
  const timer = setTimeout(() => {
    minioSyncTimers.delete(key)
    upload().catch((e) => {
      // 限流日志:每分钟最多一条,避免刷屏
      if (Date.now() - minioSyncFailLogAt > 60_000) {
        minioSyncFailLogAt = Date.now()
        console.error('[sseapi] MinIO 同步失败(本地数据完好,稍后重试):', e instanceof Error ? e.message : e)
      }
      scheduleMinioSync(key, upload) // 失败后安排重试
    })
  }, MINIO_SYNC_MS)
  timer.unref?.()
  minioSyncTimers.set(key, timer)
}

export async function appendHistory(table: keyof typeof HISTORY_OBJECT_KEYS, rows: unknown[]): Promise<void> {
  if (!rows.length) return
  // 纯追加:不再全量读取/合并/重写历史(旧实现 O(历史总量),是内存暴涨的主因)。
  // 去重交给 readHistory(按 id),崩溃重放产生的重复行在读取时消解。
  fs.mkdirSync(config.dataDir, { recursive: true })
  fs.appendFileSync(localHistoryPath(table), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  scheduleMinioSync(`history:${table}`, async () => {
    const content = fs.readFileSync(localHistoryPath(table), 'utf8')
    await withTimeout(writeMinioHistory(table, content), 30_000)
  })
}
export async function readHistory(table: keyof typeof HISTORY_OBJECT_KEYS): Promise<any[]> {
  const p = localHistoryPath(table)
  const parse = (text: string): any[] => text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const local = fs.existsSync(p) ? parse(fs.readFileSync(p, 'utf8')) : []
  let remote: any[] = []
  if (isMinioConfigured()) {
    try { const result = await getS3().send(new GetObjectCommand({ Bucket: bucket(), Key: HISTORY_OBJECT_KEYS[table] })); if (result.Body) remote = parse(await result.Body.transformToString('utf8')) }
    catch (error: any) { if (error?.name !== 'NoSuchKey' && error?.$metadata?.httpStatusCode !== 404) throw error }
  }
  return uniqueHistory([...remote, ...local])
}
async function writeMinioHistory(table: keyof typeof HISTORY_OBJECT_KEYS, content: string): Promise<void> { await getS3().send(new PutObjectCommand({Bucket: bucket(), Key: HISTORY_OBJECT_KEYS[table], Body: content, ContentType: 'application/x-ndjson'})) }

/** 启动时加载：MinIO 为主；本地 PVC 为备份/冷启动种子 */
export async function loadStoreRaw(): Promise<string | null> {
  fs.mkdirSync(config.dataDir, { recursive: true })

  if (isMinioConfigured()) {
    const remote = await readFromMinio()
    if (remote != null) {
      writeLocal(remote)
      return remote
    }
    const local = readLocal()
    if (local != null) {
      await writeMinio(local)
      console.log(`[sseapi] 已将本地备份上传到桶: ${STORE_OBJECT_KEY}`)
      return local
    }
    return null
  }

  return readLocal()
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error('MinIO 写入超时')), ms)
      t.unref?.()
    }),
  ])
}

/** 持久化：先写本地（同步、即时），MinIO 去抖异步备份 */
export async function saveStoreRaw(content: string): Promise<void> {
  writeLocal(content)
  if (!isMinioConfigured()) return
  scheduleMinioSync('store', async () => {
    // 上传时重读本地文件,拿到的是最新内容(去抖合并了多次保存)
    await withTimeout(writeMinio(fs.readFileSync(localPath(), 'utf8')), 30_000)
  })
}
