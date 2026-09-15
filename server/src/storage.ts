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

/** 持久化：先写本地（快），MinIO 异步尽力同步 */
export async function saveStoreRaw(content: string): Promise<void> {
  writeLocal(content)
  if (!isMinioConfigured()) return
  const minioWrite = writeMinio(content)
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('MinIO 写入超时')), 12_000)
  })
  try {
    await Promise.race([minioWrite, timeout])
  } catch (e) {
    console.error('[sseapi] MinIO 写入失败，已保留本地备份:', e instanceof Error ? e.message : e)
  }
}
