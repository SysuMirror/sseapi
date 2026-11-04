// SSE 流式响应的用量统计工具。
//
// 这几个函数原先私有在 `routes/proxy.ts` 里，playground 要复用同一套「读最后一个
// chunk 的 usage、读不到就按字符数估」的逻辑，所以单独抽到 services/ 下，
// 避免 route 模块之间互相 import（proxy.ts 也长期在改动中）。
import { readUsage } from './proxy-common.js'
import { redactImagesForEstimate } from './multimodal.js'

/** 遍历 SSE 文本里的 data: 行，返回最后一个带 usage 的 chunk（上游/网关都会改写换行，LF/CRLF 都要认） */
export function extractUsageFromSse(buf: string): {
  prompt: number
  completion: number
  cached: number
  imageTokens: number
  found: boolean
} {
  let last = { prompt: 0, completion: 0, cached: 0, imageTokens: 0, found: false }
  for (const line of buf.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    const data = t.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try {
      const j = JSON.parse(data)
      const u = readUsage(j?.usage)
      if (u.found) last = u
    } catch {
      /* 忽略半包 */
    }
  }
  return last
}

/** 上游没给 usage 时的兜底估算（字符数 / 4） */
export function estimateTokens(messages: unknown, completionText: string) {
  const msgLen = JSON.stringify(redactImagesForEstimate(messages) ?? '').length
  return {
    prompt: Math.max(1, Math.ceil(msgLen / 4)),
    completion: Math.max(0, Math.ceil((completionText || '').length / 4)),
    cached: 0,
    imageTokens: 0,
  }
}

/** 从 SSE 文本里拼出 assistant 的正文（估算 completion 用） */
export function extractStreamCompletionText(buf: string): string {
  let out = ''
  for (const line of buf.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    const data = t.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try {
      const j = JSON.parse(data)
      const delta = j?.choices?.[0]?.delta?.content
      if (typeof delta === 'string') out += delta
      const msg = j?.choices?.[0]?.message?.content
      if (typeof msg === 'string' && !delta) out += msg
    } catch {
      /* ignore */
    }
  }
  return out
}
