import { loadEnvFile } from './load-env.js'

loadEnvFile()



import express from 'express'

import cors from 'cors'

import fs from 'node:fs'

import path from 'node:path'

import { config } from './config.js'

import { initDb } from './db.js'

import { storeBackendLabel } from './storage.js'

import { authRouter } from './routes/auth.js'

import { keysRouter } from './routes/keys.js'

import { usageRouter } from './routes/usage.js'

import { billingRouter } from './routes/billing.js'

import { modelsRouter } from './routes/models.js'

import { docsRouter } from './routes/docs.js'

import { adminRouter } from './routes/admin.js'

import { proxyRouter } from './routes/proxy.js'



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

app.use('/v1', proxyRouter)



const dist = config.frontendDist

if (fs.existsSync(dist)) {

  app.use(express.static(dist))

  app.get('*', (req, res, next) => {

    if (req.path.startsWith('/api') || req.path.startsWith('/v1')) return next()

    res.sendFile(path.join(dist, 'index.html'))

  })

}



app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {

  console.error(err)

  res.status(500).json({ code: 500, message: err instanceof Error ? err.message : '服务器错误' })

})



await initDb()



app.listen(config.port, '0.0.0.0', () => {

  console.log(`[sseapi] listening on 0.0.0.0:${config.port}`)

  console.log(`[sseapi] store=${storeBackendLabel()} local_backup=${config.dataDir}/sseapi-store.json`)

  console.log(`[sseapi] frontend=${dist} exists=${fs.existsSync(dist)}`)

})

