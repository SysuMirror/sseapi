import type { ModelRow } from '../db.js'

/**
 * OpenAI Responses 协议 <-> OpenAI Chat Completions 协议的适配层。
 *
 * 当模型配置了独立的 responses_base_url 时，平台对 `/v1/responses` 做原生透传。
 * 当未配置独立上游（responses_base_url 为空）时，平台把 Responses 请求
 * 转换为 Chat Completions 打到 OpenAI 上游，并把响应反向规范为 Responses 形状。
 *
 * 适配目标客户端是 **Codex CLI**（0.162 起只支持 `wire_api = "responses"`，已彻底
 * 移除 chat 协议）。它的流式解析器（codex-api/src/sse/responses.rs）有几条硬约束，
 * 这里逐条对齐，否则客户端会「完全没有响应」：
 *
 *   1. 文本增量事件 `response.output_text.delta` 只有在**已有活动 item**时才被采纳，
 *      而活动 item 只由 `response.output_item.added` 建立 —— 少了它，所有 delta 都被
 *      丢弃，报 "OutputTextDelta without active item"。
 *   2. 助手消息的正文来自 `response.output_item.done`（message item），不是 delta。
 *   3. 工具调用靠 `response.output_item.done`（function_call item）落地，
 *      `arguments` 必须是**完整 JSON 字符串**。
 *   4. 流必须以 `response.completed` 结束（否则报 "stream closed before response.completed"），
 *      其 `response.usage` 需含 input_tokens/output_tokens/total_tokens 三个整数。
 */

/** 一条 SSE 事件（event 名 + data 体） */
export type SseEvent = { event: string; data: Record<string, unknown> }

function randId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`
}

/** Responses 的 content（string 或 item 数组）→ Chat content。纯文本收敛成字符串，带图才用数组。 */
function responsesContentToOpenAi(content: unknown): string | Record<string, unknown>[] {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const texts: string[] = []
  const parts: Record<string, unknown>[] = []
  let hasNonText = false
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const p = part as Record<string, unknown>
    const type = String(p.type ?? '')
    if (type === 'input_text' || type === 'output_text' || type === 'text' || type === 'summary_text') {
      texts.push(String(p.text ?? ''))
      parts.push({ type: 'text', text: String(p.text ?? '') })
    } else if (type === 'input_image' || type === 'image_url') {
      const img = p.image_url ? String((p.image_url as Record<string, unknown>)?.url ?? '') : ''
      const url = img || `data:${p.media_type || 'image/png'};base64,${p.image_base64 || ''}`
      if (url) {
        hasNonText = true
        parts.push({ type: 'image_url', image_url: { url } })
      }
    }
  }
  // 纯文本 → 单个字符串，兼容性最好（不少 vLLM/SGLang 的 chat 模板不认 content 数组）
  if (!hasNonText) return texts.join('')
  return parts
}

/** 把 Responses 的 tools（扁平 function 形状）转成 Chat 的 tools（function 嵌套形状）。 */
export function responsesToolsToOpenAi(tools: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(tools)) return undefined
  const out: Record<string, unknown>[] = []
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue
    const tool = t as Record<string, unknown>
    const type = String(tool.type ?? '')
    // 已是 Chat 形状，原样保留
    if (type === 'function' && tool.function && typeof tool.function === 'object') {
      out.push(tool)
      continue
    }
    const name = typeof tool.name === 'string' ? tool.name : ''
    if (!name) continue
    const fn: Record<string, unknown> = {
      name,
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters:
        tool.parameters && typeof tool.parameters === 'object'
          ? tool.parameters
          : { type: 'object', properties: {} },
    }
    // Codex 的自定义工具（如 apply_patch）没有 JSON schema，给一个宽松 schema 以便模型仍能调用
    if (type === 'custom') fn.parameters = { type: 'object', properties: {}, additionalProperties: true }
    if (typeof tool.strict === 'boolean') fn.strict = tool.strict
    out.push({ type: 'function', function: fn })
  }
  return out.length ? out : undefined
}

/** Responses 的 tool_choice → Chat 的 tool_choice */
function responsesToolChoiceToOpenAi(choice: unknown): unknown {
  if (choice == null) return undefined
  if (typeof choice === 'string') return choice
  if (typeof choice === 'object') {
    const c = choice as Record<string, unknown>
    if (c.function && typeof c.function === 'object') return c
    const name = typeof c.name === 'string' ? c.name : ''
    if (name) return { type: 'function', function: { name } }
  }
  return undefined
}

/** function_call_output 的 output 字段 → Chat tool 消息的文本 */
function functionCallOutputToText(output: unknown): string {
  if (output == null) return ''
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output
      .map((o) => {
        if (typeof o === 'string') return o
        if (o && typeof o === 'object') return String((o as Record<string, unknown>).text ?? '')
        return ''
      })
      .join('')
  }
  if (typeof output === 'object') return String((output as Record<string, unknown>).text ?? '')
  return String(output)
}

type ChatMsg = Record<string, unknown>

/**
 * 把 Responses 请求的 input 转为 Chat messages。
 *
 * 覆盖 Codex 实际会发的内容项：
 *   {type:'message', role:'developer'|'user'|'assistant', content:[...]}
 *   {type:'function_call', name, arguments, call_id}
 *   {type:'function_call_output', call_id, output}
 *   {type:'reasoning', ...}   ← 丢弃（Chat 上游没有等价物）
 */
function responsesInputToMessages(input: unknown): ChatMsg[] {
  const messages: ChatMsg[] = []

  const pushMessage = (role: string, content: string | Record<string, unknown>[]) => {
    if (content === '' || (Array.isArray(content) && content.length === 0)) return
    // developer/instructions 归并成 system，兼容不会处理 developer 角色的上游
    const mappedRole = role === 'developer' || role === 'system' ? 'system' : role === 'assistant' ? 'assistant' : 'user'
    messages.push({ role: mappedRole, content })
  }

  if (typeof input === 'string') {
    pushMessage('user', input)
    return messages
  }

  const items: unknown[] = Array.isArray(input) ? input : input && typeof input === 'object' ? [input] : []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const m = item as Record<string, unknown>
    const type = String(m.type ?? 'message')

    if (type === 'function_call') {
      // 一轮里可能有多个并行调用：相邻的 function_call 合并进同一条 assistant 消息，
      // 否则后面的 tool 结果会对不上 tool_call_id。
      const call: Record<string, unknown> = {
        id: String(m.call_id ?? m.id ?? randId('call')),
        type: 'function',
        function: { name: String(m.name ?? ''), arguments: String(m.arguments ?? '') },
      }
      const last = messages[messages.length - 1]
      if (last && last.role === 'assistant' && Array.isArray(last.tool_calls)) {
        ;(last.tool_calls as unknown[]).push(call)
      } else {
        messages.push({ role: 'assistant', content: '', tool_calls: [call] })
      }
      continue
    }

    if (type === 'function_call_output') {
      const callId = String(m.call_id ?? '')
      if (!callId) continue
      messages.push({ role: 'tool', tool_call_id: callId, content: functionCallOutputToText(m.output) })
      continue
    }

    if (type === 'reasoning') continue

    // 普通消息（含 Codex 的 developer 指令）
    const role = String(m.role ?? 'user')
    const content = responsesContentToOpenAi(m.content)
    pushMessage(role, content)
  }
  return messages
}

/**
 * 将 OpenAI Responses 请求规范为 OpenAI Chat Completions body。
 * 未配置独立 responses 上游时（回退模式）使用。
 */
export function responsesRequestToOpenAi(model: ModelRow, body: Record<string, unknown>): Record<string, unknown> {
  const upstreamModel = model.upstream_model || model.slug
  const messages = responsesInputToMessages(body.input)
  if (body.instructions != null && typeof body.instructions === 'string' && body.instructions.trim()) {
    messages.unshift({ role: 'system', content: body.instructions })
  }
  // 纯工具回灌的 Responses 输入（只有 function_call / function_call_output）转出来
  // 只剩 assistant + tool，没有 user。vLLM/SGLang 一类上游的 chat 模板会直接
  // 400 "No user query found in messages"，补一条占位 user 让它们也能续上。
  if (!messages.some((m) => m.role === 'user')) {
    messages.push({ role: 'user', content: 'Continue from the tool results above.' })
  }
  const payload: Record<string, unknown> = {
    model: upstreamModel,
    messages: messages.length ? messages : [{ role: 'user', content: '' }],
  }
  if (body.max_output_tokens != null) payload.max_tokens = Math.max(1, Math.floor(Number(body.max_output_tokens)))
  if (body.temperature != null) payload.temperature = Number(body.temperature)
  if (body.top_p != null) payload.top_p = Number(body.top_p)
  if (body.stream != null) payload.stream = Boolean(body.stream)
  const tools = responsesToolsToOpenAi(body.tools)
  if (tools) payload.tools = tools
  const toolChoice = responsesToolChoiceToOpenAi(body.tool_choice)
  if (toolChoice != null) payload.tool_choice = toolChoice
  if (typeof body.parallel_tool_calls === 'boolean') payload.parallel_tool_calls = body.parallel_tool_calls
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

/** Chat 的 tool_calls → Responses 的 function_call item 列表 */
function chatToolCallsToItems(toolCalls: unknown): Record<string, unknown>[] {
  if (!Array.isArray(toolCalls)) return []
  const out: Record<string, unknown>[] = []
  for (const tc of toolCalls) {
    if (!tc || typeof tc !== 'object') continue
    const call = tc as Record<string, unknown>
    const fn = (call.function as Record<string, unknown> | undefined) || {}
    out.push({
      type: 'function_call',
      id: randId('fc'),
      call_id: String(call.id ?? randId('call')),
      name: String(fn.name ?? ''),
      arguments: String(fn.arguments ?? ''),
      status: 'completed',
    })
  }
  return out
}

/** 组装 Responses 的 usage 字段 */
function responsesUsage(usageRaw: Record<string, unknown> | null): Record<string, unknown> {
  const input = Number(usageRaw?.input_tokens ?? usageRaw?.prompt_tokens ?? 0) || 0
  const output = Number(usageRaw?.output_tokens ?? usageRaw?.completion_tokens ?? 0) || 0
  const detailsIn =
    (usageRaw?.prompt_tokens_details as Record<string, unknown> | undefined) ||
    (usageRaw?.input_tokens_details as Record<string, unknown> | undefined) ||
    {}
  const detailsOut =
    (usageRaw?.completion_tokens_details as Record<string, unknown> | undefined) ||
    (usageRaw?.output_tokens_details as Record<string, unknown> | undefined) ||
    {}
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: Number(detailsIn?.cached_tokens ?? 0) || 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: Number(detailsOut?.reasoning_tokens ?? 0) || 0 },
    total_tokens: Number(usageRaw?.total_tokens ?? input + output) || input + output,
  }
}

/**
 * 将 OpenAI Chat Completions 非流式响应规范为 OpenAI Responses 形状。
 */
export function openAiResponseToResponses(upstreamJson: Record<string, unknown>): Record<string, unknown> {
  const text = chatCompletionText(upstreamJson)
  const choices = Array.isArray(upstreamJson.choices) ? upstreamJson.choices : []
  const first = (choices[0] as Record<string, unknown> | undefined) || {}
  const msg = (first.message as Record<string, unknown> | undefined) || {}
  const callItems = chatToolCallsToItems(msg.tool_calls)

  const output: Record<string, unknown>[] = []
  if (text) {
    output.push({
      type: 'message',
      id: randId('msg'),
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    })
  }
  output.push(...callItems)

  return {
    id: String(upstreamJson.id ?? randId('resp')),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: String(upstreamJson.model ?? ''),
    output,
    output_text: text,
    usage: responsesUsage((upstreamJson.usage as Record<string, unknown>) ?? null),
    error: null,
    incomplete_details: null,
  }
}

/**
 * 上游错误 → Responses 形状的错误体。
 *
 * Responses 客户端的错误信封是 `{"error": {message, type, code}}`。
 * 注意不要复用 Anthropic 的 `{type:'error', error:{...}}`：Responses 客户端会把
 * 带 `type` 的载荷当成正常事件解析，于是「错误」被静默吞掉，最终表现为
 * 「流在 completed 之前结束」这种没有信息量的报错。
 */
export function upstreamErrorToResponses(
  status: number,
  bodyText: string,
): { error: { message: string; type: string; code: number | null } } {
  let message = ''
  const trimmed = (bodyText || '').trim()
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed) as Record<string, unknown>
      const err = (j.error as Record<string, unknown> | undefined) || {}
      message = String(err.message ?? '') || String((j as { message?: unknown }).message ?? '')
    } catch {
      /* 非 JSON，走下面的兜底 */
    }
  }
  if (!message) message = trimmed.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300)
  if (!message) message = `上游错误 (HTTP ${status})`
  const type =
    status === 401 || status === 403
      ? 'authentication_error'
      : status === 404
        ? 'not_found_error'
        : status === 429
          ? 'rate_limit_error'
          : status >= 500
            ? 'api_error'
            : 'invalid_request_error'
  return { error: { message, type, code: null } }
}

/** 判断一个 SSE 事件块是否是「上游把错误塞进 200 流」的形态（形如 data: {"error":...) */
export function sseBlockIsErrorPayload(block: string): string | null {
  const m = /^data:\s*(.+)$/m.exec(block)
  if (!m) return null
  try {
    const j = JSON.parse(m[1].trim()) as Record<string, unknown>
    if (j && typeof j === 'object' && j.error && typeof j.error === 'object' && !j.type) {
      const err = j.error as Record<string, unknown>
      return String(err.message ?? '上游返回错误')
    }
  } catch {
    /* 不是 JSON，交给调用方原样转发 */
  }
  return null
}

type CallState = { itemId: string; callId: string; name: string; args: string; added: boolean }

/**
 * 有状态的 Chat 流 → Responses 流转换器。
 *
 * 与旧版「每个 chunk 独立转事件」的实现不同：Responses 的事件是**有生命周期**的
 * （item 先 added、再增量、最后 done），必须跨 chunk 累积状态，否则 Codex 收不到
 * 完整的 output_item.done，界面上就是一片空白。
 */
export class ResponsesStreamBuilder {
  private seq = 0
  private messageId = ''
  private messageAdded = false
  private text = ''
  private readonly calls = new Map<number, CallState>()
  private usage: Record<string, unknown> | null = null
  private created = false
  private terminated = false

  constructor(
    private readonly runId: string,
    private readonly model: string,
  ) {}

  private next(): number {
    return this.seq++
  }

  private baseResponse(status: string): Record<string, unknown> {
    return {
      id: this.runId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status,
      model: this.model,
      output: [],
      error: null,
      incomplete_details: null,
      usage: null,
    }
  }

  /** 流开始：response.created + response.in_progress */
  start(): SseEvent[] {
    if (this.created) return []
    this.created = true
    return [
      { event: 'response.created', data: { type: 'response.created', sequence_number: this.next(), response: this.baseResponse('in_progress') } },
      { event: 'response.in_progress', data: { type: 'response.in_progress', sequence_number: this.next(), response: this.baseResponse('in_progress') } },
    ]
  }

  /** 吃一个 Chat chunk，产出对应事件；done 表示上游已给出 finish_reason */
  push(raw: Record<string, unknown>): { events: SseEvent[]; done: boolean } {
    const events: SseEvent[] = []
    if (this.terminated) return { events, done: true }

    const usageRaw = raw.usage as Record<string, unknown> | undefined
    if (usageRaw && typeof usageRaw === 'object') this.usage = usageRaw

    const choices = Array.isArray(raw.choices) ? raw.choices : []
    const first = (choices[0] as Record<string, unknown> | undefined) || {}
    const delta = (first.delta as Record<string, unknown> | undefined) || {}

    // 文本增量：首个 delta 前必须先建 message item，否则客户端会丢弃全部 delta
    let text = ''
    const rawContent = delta.content
    if (typeof rawContent === 'string') text = rawContent
    else if (Array.isArray(rawContent)) text = rawContent.map((c) => String((c as Record<string, unknown>)?.text ?? '')).join('')
    if (text) {
      if (!this.messageAdded) {
        this.messageAdded = true
        this.messageId = randId('msg')
        events.push({
          event: 'response.output_item.added',
          data: {
            type: 'response.output_item.added',
            sequence_number: this.next(),
            output_index: 0,
            item: { id: this.messageId, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
          },
        })
        events.push({
          event: 'response.content_part.added',
          data: {
            type: 'response.content_part.added',
            sequence_number: this.next(),
            item_id: this.messageId,
            output_index: 0,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          },
        })
      }
      this.text += text
      events.push({
        event: 'response.output_text.delta',
        data: {
          type: 'response.output_text.delta',
          sequence_number: this.next(),
          item_id: this.messageId,
          output_index: 0,
          content_index: 0,
          delta: text,
          logprobs: [],
        },
      })
    }

    // 工具调用增量：按 index 归并，首个分片即建立 function_call item
    const streamToolCalls = Array.isArray(delta.tool_calls) ? (delta.tool_calls as Record<string, unknown>[]) : []
    for (const tc of streamToolCalls) {
      if (!tc || typeof tc !== 'object') continue
      const idx = Number(tc.index ?? 0) || 0
      const fn = (tc.function as Record<string, unknown> | undefined) || {}
      let state = this.calls.get(idx)
      if (!state) {
        state = { itemId: randId('fc'), callId: String(tc.id ?? randId('call')), name: '', args: '', added: false }
        this.calls.set(idx, state)
      }
      if (typeof tc.id === 'string' && tc.id) state.callId = tc.id
      if (typeof fn.name === 'string' && fn.name) state.name = fn.name
      if (!state.added && state.name) {
        state.added = true
        events.push({
          event: 'response.output_item.added',
          data: {
            type: 'response.output_item.added',
            sequence_number: this.next(),
            output_index: this.calls.size,
            item: { id: state.itemId, type: 'function_call', call_id: state.callId, name: state.name, arguments: '' },
          },
        })
      }
      const argDelta = typeof fn.arguments === 'string' ? fn.arguments : ''
      if (argDelta) {
        state.args += argDelta
        events.push({
          event: 'response.function_call_arguments.delta',
          data: {
            type: 'response.function_call_arguments.delta',
            sequence_number: this.next(),
            item_id: state.itemId,
            output_index: this.calls.size,
            delta: argDelta,
          },
        })
      }
    }

    const finish = first.finish_reason
    return { events, done: finish != null }
  }

  /**
   * 收尾：关闭已开启的 item，并以 response.completed 结束。
   * 无论上游有没有给 finish_reason，都**必须**发这个事件，否则客户端会一直等。
   */
  finish(): SseEvent[] {
    if (this.terminated) return []
    this.terminated = true
    // 即使一个 chunk 都没吃到，也必须先有 response.created：
    // 官方 SDK 的 stream() 见到没有前置 created 的事件会直接报错。
    const events: SseEvent[] = this.start()
    const output: Record<string, unknown>[] = []

    if (this.messageAdded) {
      const item = {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: this.text, annotations: [] }],
      }
      events.push({
        event: 'response.output_text.done',
        data: { type: 'response.output_text.done', sequence_number: this.next(), item_id: this.messageId, output_index: 0, content_index: 0, text: this.text, logprobs: [] },
      })
      events.push({
        event: 'response.content_part.done',
        data: { type: 'response.content_part.done', sequence_number: this.next(), item_id: this.messageId, output_index: 0, content_index: 0, part: { type: 'output_text', text: this.text, annotations: [] } },
      })
      events.push({ event: 'response.output_item.done', data: { type: 'response.output_item.done', sequence_number: this.next(), output_index: 0, item } })
      output.push(item)
    }

    for (const state of this.calls.values()) {
      const item = {
        id: state.itemId,
        type: 'function_call',
        call_id: state.callId,
        name: state.name,
        arguments: state.args,
        status: 'completed',
      }
      events.push({
        event: 'response.function_call_arguments.done',
        data: { type: 'response.function_call_arguments.done', sequence_number: this.next(), item_id: state.itemId, output_index: output.length, arguments: state.args },
      })
      events.push({ event: 'response.output_item.done', data: { type: 'response.output_item.done', sequence_number: this.next(), output_index: output.length, item } })
      output.push(item)
    }

    const response = {
      ...this.baseResponse('completed'),
      output,
      output_text: this.text,
      usage: responsesUsage(this.usage),
      end_turn: this.calls.size === 0,
    }
    events.push({ event: 'response.completed', data: { type: 'response.completed', sequence_number: this.next(), response } })
    return events
  }

  /** 上游出错：发 response.failed，让客户端拿到可读错误而不是「流意外结束」 */
  fail(message: string, code = 'upstream_error'): SseEvent[] {
    if (this.terminated) return []
    this.terminated = true
    const response = {
      ...this.baseResponse('failed'),
      error: { code, message: message.slice(0, 800) },
    }
    // 同上：response.failed 之前必须有 response.created，否则官方 SDK 抛
    // "Expected to have received `response.created` before `response.failed`"。
    return [...this.start(), { event: 'response.failed', data: { type: 'response.failed', sequence_number: this.next(), response } }]
  }

  get hasOutput(): boolean {
    return this.messageAdded || this.calls.size > 0
  }

  get outputText(): string {
    return this.text
  }

  get isTerminated(): boolean {
    return this.terminated
  }
}
