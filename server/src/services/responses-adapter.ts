import type { ModelRow } from '../db.js'

/**
 * OpenAI Responses 协议 <-> OpenAI Chat Completions 协议的适配层。
 *
 * 当模型配置了独立的 responses_base_url 时，平台对 `/v1/responses` 做原生透传
 * （最兼容 Codex 等使用 OpenAI Responses SDK 的客户端）。
 * 当未配置独立上游（responses_base_url 为空）时，平台把 Responses 请求
 * 转换为 Chat Completions 打到 openai 上游，并把响应反向规范为 Responses 形状。
 */

/** 把 Responses 请求的 input（字符串/数组）转为 Chat messages 数组 */
function responsesInputToMessages(input: unknown): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = []
  if (typeof input === 'string') {
    if (input.trim()) messages.push({ role: 'user', content: input })
    return messages
  }
  if (!Array.isArray(input)) return messages
  for (const item of input) {
    if (!item || typeof item !== 'object') continue
    const m = item as Record<string, unknown>
    const role = String(m.role ?? 'user')
    const content = responsesContentToOpenAi(m.content)
    // instructions 合并到 system
    if (m.instructions != null) {
      messages.push({ role: 'system', content: String(m.instructions) })
    }
    if (content) messages.push({ role: role === 'assistant' ? 'assistant' : 'user', content })
  }
  return messages
}

/** 把 Responses content（string 或 item 数组）转为 OpenAI content 值 */
function responsesContentToOpenAi(content: unknown): string | Record<string, unknown>[] {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const out: Record<string, unknown>[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const p = part as Record<string, unknown>
    const type = String(p.type ?? '')
    if (type === 'input_text' || type === 'output_text' || type === 'text') {
      out.push({ type: 'text', text: String(p.text ?? '') })
    } else if (type === 'input_image') {
      // Responses 图片可能是 url 或 base64
      const img = p.image_url ? String((p.image_url as Record<string, unknown>)?.url ?? '') : ''
      out.push({ type: 'image_url', image_url: { url: img || `data:${p.media_type || 'image/png'};base64,${p.image_base64 || ''}` } })
    }
  }
  return out
}

/**
 * 将 OpenAI Responses 请求规范为 OpenAI Chat Completions body。
 * 未配置独立 responses 上游时（回退模式）使用。
 */
export function responsesRequestToOpenAi(model: ModelRow, body: Record<string, unknown>): Record<string, unknown> {
  const upstreamModel = model.upstream_model || model.slug
  const messages = responsesInputToMessages(body.input)
  if (body.instructions != null && typeof body.instructions === 'string' && body.instructions.trim()) {
    // 前置一条 system
    messages.unshift({ role: 'system', content: body.instructions })
  }
  const payload: Record<string, unknown> = {
    model: upstreamModel,
    messages: messages.length ? messages : [{ role: 'user', content: '' }],
  }
  if (body.max_output_tokens != null) payload.max_tokens = Math.max(1, Math.floor(Number(body.max_output_tokens)))
  if (body.temperature != null) payload.temperature = Number(body.temperature)
  if (body.top_p != null) payload.top_p = Number(body.top_p)
  if (body.stream != null) payload.stream = Boolean(body.stream)
  if (body.tools != null) payload.tools = body.tools
  if (body.tool_choice != null) payload.tool_choice = body.tool_choice
  if (body.stop != null) payload.stop = body.stop
  return payload
}

/** 提取 Chat 响应 content 文本（首条 choices.message.content） */
function chatCompletionText(json: Record<string, unknown>): string {
  const choices = Array.isArray(json.choices) ? json.choices : []
  const first = (choices[0] as Record<string, unknown> | undefined) || {}
  const msg = (first.message as Record<string, unknown> | undefined) || {}
  const content = msg.content
  if (Array.isArray(content)) {
    return content.map((c) => String((c as Record<string, unknown>)?.text ?? '')).join('')
  }
  return String(content ?? '')
}

/**
 * 将 OpenAI Chat Completions 非流式响应规范为 OpenAI Responses 形状。
 */
export function openAiResponseToResponses(upstreamJson: Record<string, unknown>): Record<string, unknown> {
  const text = chatCompletionText(upstreamJson)
  const usage = (upstreamJson.usage as Record<string, unknown>) || {}
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0)
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0)
  return {
    id: String(upstreamJson.id ?? `resp_${Date.now().toString(36)}`),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: String(upstreamJson.model ?? ''),
    output: [
      {
        type: 'message',
        id: `msg_${Date.now().toString(36)}`,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text }],
      },
    ],
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      input_tokens_details: usage.prompt_tokens_details ?? undefined,
    },
    error: null,
  }
}

/**
 * 将 OpenAI Chat Completions 流式 chunk 转换为 OpenAI Responses 流式事件。
 * 返回事件数组并标记是否结束。
 *
 * Responses 流式事件约定（简化）：
 *   response.created
 *   response.output_text.delta  -> { delta, item_id, output_index, content_index }
 *   response.completed
 */
export function openAiStreamChunkToResponses(
  raw: Record<string, unknown>,
  runId: string,
): { events: Array<{ event: string; data: Record<string, unknown> }>; done: boolean } {
  const events: Array<{ event: string; data: Record<string, unknown> }> = []
  const choices = Array.isArray(raw.choices) ? raw.choices : []
  const first = (choices[0] as Record<string, unknown> | undefined) || {}
  const delta = (first.delta as Record<string, unknown> | undefined) || {}
  const finish = first.finish_reason

  const text = String(delta.content ?? '')
  if (text) {
    events.push({
      event: 'response.output_text.delta',
      data: {
        type: 'response.output_text.delta',
        item_id: runId,
        output_index: 0,
        content_index: 0,
        delta: text,
      },
    })
  }

  if (finish) {
    events.push({
      event: 'response.completed',
      data: {
        type: 'response.completed',
        response: {
          id: runId,
          object: 'response',
          status: 'completed',
          output: [],
        },
      },
    })
    return { events, done: true }
  }
  return { events, done: false }
}
