import { loadEnvFile } from './load-env.js'

loadEnvFile()

import express from 'express'
import cors from 'cors'
import compression from 'compression'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { initDb } from './db.js'
import { restoreDbIfMissing, shutdown, startBackupLoop, storeBackendLabel } from './storage.js'
import { dbPath } from './sqlite.js'
import { authRouter } from './routes/auth.js'
import { keysRouter } from './routes/keys.js'
import { usageRouter } from './routes/usage.js'
import { billingRouter } from './routes/billing.js'
import { modelsRouter } from './routes/models.js'
import { docsRouter } from './routes/docs.js'
import { adminRouter } from './routes/admin.js'
import { proxyRouter } from './routes/proxy.js'
import { playgroundRouter } from './routes/playground.js'

const app = express()

const corsOrigins = (process.env.SSEAPI_CORS_ORIGINS || 'https://platform.ssemarket.cn,http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true)
      if (corsOrigins.includes('*') || corsOrigins.includes(origin)) return cb(null, true)
      if (origin.endsWith('.ssemarket.cn') || origin.startsWith('http://localhost:')) {
        return cb(null, true)
      }
      cb(null, false)
    },
    credentials: true,
  }),
)

// 压缩:前端 bundle 与 JSON 响应经公网中继传输,不压缩时首屏要拉 ~150KB 文本。
// /v1 是 SSE 流式转发,压缩会缓冲分片、破坏增量输出,必须排除。
app.use(
  compression({
    filter: (req, res) => {
      // 注意：filter 是在 onHeaders 时才调用的，那时 express 已经把 /v1 挂载前缀
      // 从 req.url 上剥掉了（req.path 变成 /chat/completions）。必须用 originalUrl，
      // 否则漏判会把 SSE 流压掉：客户端要等整条流结束才拿到数据，流式就废了。
      if (req.originalUrl.startsWith('/v1')) return false
      // playground 也是 SSE 流式，同样必须排除压缩，否则分片会被缓冲
      if (req.originalUrl.startsWith('/api/playground')) return false
      if (String(req.headers.accept || '').includes('text/event-stream')) return false
      return compression.filter(req, res)
    },
  }),
)

app.use(express.json({ limit: '4mb' }))

/** /v1 对任意 Origin 反射 CORS，域名白名单在代理逻辑内校验 */
app.use(
  '/v1',
  cors({
    origin: true,
    credentials: false,
    allowedHeaders: ['Authorization', 'Content-Type'],
  }),
)

app.get('/api/health', (_req, res) => {
  res.json({ code: 0, message: 'ok', data: { service: 'sseapi', time: new Date().toISOString() } })
})

app.use('/api/auth', authRouter)
app.use('/api/keys', keysRouter)
app.use('/api/usage', usageRouter)
app.use('/api/billing', billingRouter)
app.use('/api/models', modelsRouter)
app.use('/api/docs', docsRouter)
app.use('/api/admin', adminRouter)
// 控制台 playground：登录态(JWT)流式对话
app.use('/api/playground', playgroundRouter)
app.use('/v1', proxyRouter)

const dist = config.frontendDist

if (fs.existsSync(dist)) {
  app.use(
    express.static(dist, {
      index: false,
      // 带内容 hash 的资源可长期强缓存;index.html 必须每次回源校验,
      // 否则发了新版前端用户仍会拿到旧 bundle。
      setHeaders(res, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        } else if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache')
        } else {
          res.setHeader('Cache-Control', 'public, max-age=3600')
        }
      },
    }),
  )
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/v1')) return next()
    res.setHeader('Cache-Control', 'no-cache')
    res.sendFile(path.join(dist, 'index.html'))
  })
}

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err)
  res.status(500).json({ code: 500, message: err instanceof Error ? err.message : '服务器错误' })
})

// 本地没有库时先从 MinIO 拉回最近一次快照（新 Pod / 盘被清）
await restoreDbIfMissing()
await initDb()

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`[sseapi] listening on 0.0.0.0:${config.port}`)
  console.log(`[sseapi] store=${storeBackendLabel()}`)
  console.log(`[sseapi] frontend=${dist} exists=${fs.existsSync(dist)}`)
  // 定时把 SQLite 快照推到 MinIO（异地备份）
  startBackupLoop()
})

// 优雅退出：checkpoint WAL 并补一次备份（supervisor 发 SIGTERM）
let closing = false
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (closing) return
    closing = true
    console.log(`[sseapi] 收到 ${sig}，正在收尾…`)
    const done = () => process.exit(0)
    server.close(() => void shutdown().then(done, done))
    setTimeout(done, 8000).unref()
  })
}
process.on('uncaughtException', (e) => {
  console.error('[sseapi] uncaughtException:', e)
})
console.log(`[sseapi] db=${dbPath()}`)
