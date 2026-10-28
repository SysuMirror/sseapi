import { apiBaseUrl } from './http'
import { auth } from '../store/auth'

export interface PlaygroundChatBody {
  model: string
  messages: { role: string; content: string }[]
  system?: string
  temperature?: number
  max_tokens?: number
}

export interface StreamHandlers {
  onDelta: (text: string) => void
  /** 思考过程增量（reasoning_content/reasoning），模型不返回时不会触发 */
  onReasoning?: (text: string) => void
  onDone: () => void
  onError: (message: string, status: number, retryAfter?: string) => void
}

/** 平台有两种错误 shape：{error:{message,type}}（守卫/限流）与 {code,message}（鉴权） */
function errorMessageOf(raw: string, status: number): string {
  try {
    const j = JSON.parse(raw)
    const msg = j?.error?.message || j?.message
    if (typeof msg === 'string' && msg) return msg
  } catch {
    /* 非 JSON */
  }
  return raw.trim().slice(0, 300) || `请求失败（HTTP ${status}）`
}

/**
 * 流式对话。整个响应是一条 text/event-stream，逐块解析并回调；
 * 停止 = 调 abort()（服务端会连带掐掉上游）。
 */
export async function streamChat(
  body: PlaygroundChatBody,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response
  try {
    res = await fetch(`${apiBaseUrl()}api/playground/chat`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        // 双保险：服务端的 compression filter 认这个头，绝不压缩 SSE
        Accept: 'text/event-stream',
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify(body),
    })
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') return
    handlers.onError(`网络错误：${(e as Error)?.message || e}`, 0)
    return
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => '')
    handlers.onError(errorMessageOf(raw, res.status), res.status, res.headers.get('retry-after') || undefined)
    return
  }
  if (!res.body) {
    handlers.onError('响应没有可读流', res.status)
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const parts = buf.split(/\r\n\r\n|\n\n/)
      buf = parts.pop() ?? ''
      for (const part of parts) dispatch(part, handlers)
    }
    if (buf.trim()) dispatch(buf, handlers)
  } catch (e) {
    if ((e as Error)?.name !== 'AbortError') {
      handlers.onError(`读取流失败：${(e as Error)?.message || e}`, 0)
    }
  } finally {
    handlers.onDone()
  }
}

/** 一个 SSE 事件块（可能含多行 data:，按规范要用 \n 连接） */
function dispatch(block: string, handlers: StreamHandlers) {
  const dataLines: string[] = []
  for (const line of block.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith(':')) continue // 心跳 `: ping`
    if (t.startsWith('data:')) dataLines.push(t.slice(5).trim())
  }
  if (!dataLines.length) return
  const data = dataLines.join('\n')
  if (!data || data === '[DONE]') return
  let j: any
  try {
    j = JSON.parse(data)
  } catch {
    return
  }
  if (j?.error) {
    handlers.onError(String(j.error.message || j.error), 502)
    return
  }
  const d0 = j?.choices?.[0]?.delta
  const reasoning = d0?.reasoning_content ?? d0?.reasoning
  if (typeof reasoning === 'string' && reasoning && handlers.onReasoning) handlers.onReasoning(reasoning)
  const delta = d0?.content ?? j?.choices?.[0]?.message?.content
  if (typeof delta === 'string' && delta) handlers.onDelta(delta)
}
