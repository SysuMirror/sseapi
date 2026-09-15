/** 统计 messages 中的图片张数（OpenAI 多模态 content parts） */
export function countImagesInMessages(messages: unknown): number {
  if (!Array.isArray(messages)) return 0
  let n = 0
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue
    const content = (msg as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const t = String((part as { type?: string }).type || '').toLowerCase()
      if (t === 'image_url' || t === 'image' || t === 'input_image') n += 1
    }
  }
  return n
}

/** 粗估 token 时去掉图片二进制/超长 URL，避免 base64 暴涨 */
export function redactImagesForEstimate(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages
  return messages.map((msg) => {
    if (!msg || typeof msg !== 'object') return msg
    const m = msg as { content?: unknown }
    if (!Array.isArray(m.content)) return msg
    return {
      ...m,
      content: m.content.map((part) => {
        if (!part || typeof part !== 'object') return part
        const p = part as { type?: string; image_url?: { url?: string } | string; text?: string }
        const t = String(p.type || '').toLowerCase()
        if (t === 'image_url' || t === 'image' || t === 'input_image') {
          return { type: 'image_url', image_url: { url: '[image]' } }
        }
        return part
      }),
    }
  })
}

export function normalizeImageBillingMode(v: unknown): 'token' | 'per_image' {
  return String(v || '').toLowerCase() === 'per_image' ? 'per_image' : 'token'
}
