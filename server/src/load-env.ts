import fs from 'node:fs'
import path from 'node:path'

/** 读取 server/.env 或 DATA_DIR 旁配置，不覆盖已有 process.env */
export function loadEnvFile() {
  const candidates = [
    path.join(process.cwd(), '.env'),
    path.join(process.cwd(), 'server', '.env'),
  ]
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue
    const text = fs.readFileSync(file, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim()
      if (!s || s.startsWith('#')) continue
      const i = s.indexOf('=')
      if (i <= 0) continue
      const key = s.slice(0, i).trim()
      let val = s.slice(i + 1).trim()
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1)
      }
      if (process.env[key] === undefined) process.env[key] = val
    }
    break
  }
}
