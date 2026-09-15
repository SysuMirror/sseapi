import type { ModelRow } from '../db.js'

/**
 * reasoning_content 回传缓存（多轮 Tool 循环）。
 *
 * DeepSeek 思考模式强校验：携带 tool_calls 的 assistant 历史消息必须回传
 * reasoning_content（可为空字符串）。但 Claude Code 会把 thinking 块从
 * 回传历史剥离，导致请求侧永远拿不到 reasoning。这里通过跨轮稳定的签名
 * （modelSlug + content 文本 + tool_call ids）缓存 DeepSeek 返回的
 * reasoning_content，在回传历史时补挂回去；缓存未命中则用空串兜底。
 */
const reasoningCache = new Map<string, { reasoning: string; ts: number }>()
const REASONING_TTL_MS = 15 * 60 * 1000

function reasoningKey(slug: string, text: string, toolCallIds: string[]): string {
  return `${slug}\u0000${text}\u0000${toolCallIds.join(',')}`
}

/** 响应侧：记录某条 assistant 历史对应的 reasoning_content（仅带 tool_calls 的轮次需要） */
export function rememberReasoning(
  slug: string,
  text: string,
  toolCallIds: string[],
  reasoning: string,
): void {
  if (!toolCallIds.length) return
  const key = reasoningKey(slug, text, toolCallIds)
  reasoningCache.set(key, { reasoning, ts: Date.now() })
}

/** 请求侧：查某条 assistant 历史是否缓存过 reasoning_content；无则返回 undefined */
export function lookupReasoning(
  slug: string,
  text: string,
  toolCallIds: string[],
): string | undefined {
  if (!toolCallIds.length) return undefined
  const key = reasoningKey(slug, text, toolCallIds)
  const hit = reasoningCache.get(key)
  if (!hit) return undefined
  if (Date.now() - hit.ts > REASONING_TTL_MS) {
    reasoningCache.delete(key)
    return undefined
  }
  return hit.reasoning
}

/** 从 OpenAI 形状的 message 中提取 assistant 纯文本 content 与 tool_calls 的 id 列表 */
function openAiMessageTextAndToolIds(msg: Record<string, unknown>): {
  text: string
  toolCallIds: string[]
} {
  const content = Array.isArray(msg.content)
    ? (msg.content as unknown[])
        .map((b) => {
          if (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string') {
            return String((b as { text: string }).text)
          }
          return ''
        })
        .join('')
    : String(msg.content ?? '')
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
  const toolCallIds = toolCalls.map((c) =>
    String((c as { id?: unknown })?.id ?? ''),
  )
  return { text: content, toolCallIds }
}

/**
 * 请求侧：对 OpenAI Chat 的 messages 数组注入 reasoning_content。
 * 规则：先检测——assistant 消息若已带 reasoning_content（非 null/undefined）则跳过；
 * 若带 tool_calls 但缺 reasoning_content（客户端剥离了思考块），则按缓存补挂。
 * 纯文本/多轮中无 tool_calls 的消息不动，避免污染与不必要的体积。
 * 返回是否发生过补挂（供调用方判断）。
 */
export function applyReasoningToChatMessages(
  messages: unknown,
  slug: string,
): boolean {
  if (!Array.isArray(messages)) return false
  let changed = false
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue
    const msg = m as Record<string, unknown>
    if (msg.role !== 'assistant') continue
    // 已有 reasoning_content（含空串）→ 不覆盖，先检测
    if (msg.reasoning_content != null) continue
    const { text, toolCallIds } = openAiMessageTextAndToolIds(msg)
    // 仅带 tool_calls 的 assistant 历史需要补挂（DeepSeek 思考模式强校验）
    if (!toolCallIds.length) continue
    const cached = lookupReasoning(slug, text, toolCallIds)
    // 补挂：缓存命中用真实值，miss 用空串兜底（带 tool_calls 必须回传 reasoning_content 字段）
    msg.reasoning_content = cached ?? ''
    changed = true
  }
  return changed
}

/**
 * 响应侧：从 OpenAI Chat 响应（非流式 JSON 或流式累计文本）中记住本次 assistant 的
 * reasoning_content，供下一轮（chat 或 claude 路径）请求侧补挂。仅当带 tool_calls 且
 * reasoning_content 非空时写入缓存（避免空值污染 key）。
 */
export function rememberOpenAiResponseReasoning(
  slug: string,
  content: string,
  toolCallIds: string[],
  reasoning: string,
): void {
  if (toolCallIds.length && reasoning) {
    rememberReasoning(slug, content, toolCallIds, reasoning)
  }
}

/** 从 OpenAI 非流式响应 JSON 中提取第一条 choice 的 content / tool_calls / reasoning_content */
export function extractOpenAiResponseReasoning(upstreamJson: unknown): {
  content: string
  toolCallIds: string[]
  reasoning: string
} {
  const o = (upstreamJson ?? {}) as Record<string, unknown>
  const choices = Array.isArray(o.choices) ? (o.choices as unknown[]) : []
  const first = (choices[0] as Record<string, unknown> | undefined) || {}
  const msg = (first.message as Record<string, unknown> | undefined) || {}
  const { text, toolCallIds } = openAiMessageTextAndToolIds(msg)
  return {
    content: text,
    toolCallIds,
    reasoning: String((msg as { reasoning_content?: unknown }).reasoning_content ?? ''),
  }
}

/** 从 OpenAI 流式 SSE 文本（已解析的 chunk JSON）累计中提取 reasoning 与最终 tool_calls 文本 */
export function extractStreamReasoning(
  parsedChunks: unknown[],
): { content: string; toolCallIds: string[]; reasoning: string } {
  let content = ''
  let reasoning = ''
  const toolCallIds: string[] = []
  const accById = new Map<string, { name: string; args: string }>()
  for (const c of parsedChunks) {
    if (!c || typeof c !== 'object') continue
    const chunk = c as Record<string, unknown>
    const choices = Array.isArray(chunk.choices) ? (chunk.choices as unknown[]) : []
    const first = (choices[0] as Record<string, unknown> | undefined) || {}
    const delta = (first.delta as Record<string, unknown> | undefined) || {}
    if (typeof delta.content === 'string') content += delta.content
    if (typeof (delta as { reasoning_content?: unknown }).reasoning_content === 'string') {
      reasoning += String((delta as { reasoning_content: string }).reasoning_content)
    }
    const deltaToolCalls = Array.isArray(delta.tool_calls) ? (delta.tool_calls as unknown[]) : []
    for (const tc of deltaToolCalls) {
      if (!tc || typeof tc !== 'object') continue
      const t = tc as Record<string, unknown>
      const id = String(t.id ?? '')
      const fn = (t.function as Record<string, unknown> | undefined) || {}
      if (id) {
        if (!accById.has(id)) accById.set(id, { name: '', args: '' })
        const acc = accById.get(id)!
        if (typeof fn.name === 'string') acc.name += fn.name
        if (typeof fn.arguments === 'string') acc.args += fn.arguments
      }
    }
  }
  for (const id of accById.keys()) toolCallIds.push(id)
  return { content, toolCallIds, reasoning }
}

/**
 * Claude Messages 协议 <-> OpenAI Chat Completions 协议的适配层。
 *
 * 平台对外暴露 Claude 风格的 `POST /v1/messages`，经此适配后转发到
 * 已配置的 OpenAI 兼容上游（vLLM 等），并把响应反向规范为 Claude 形状。
 * 底层模型方已完成 Claude 兼容，本层负责字段映射与转发。
 */

/** Claude 角色：user / assistant；system 独立，不参与 messages 数组 */
export type ClaudeRole = 'user' | 'assistant'

export type ClaudeToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export type ClaudeToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content?: string | Array<Record<string, unknown>>
  is_error?: boolean
}

export type ClaudeToolDefinition = {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

export type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | ClaudeToolUseBlock
  | ClaudeToolResultBlock

export type ClaudeMessage = {
  role: ClaudeRole
  content: string | ClaudeContentBlock[]
}

export type ClaudeMessagesRequest = {
  model: string
  max_tokens: number
  messages: ClaudeMessage[]
  system?: string | ClaudeContentBlock[]
  temperature?: number
  top_p?: number
  top_k?: number
  stop_sequences?: string[]
  stream?: boolean
  metadata?: Record<string, unknown>
  tools?: ClaudeToolDefinition[]
  tool_choice?: { type: 'auto' | 'any' | 'none' | 'tool'; name?: string }
  thinking?: { type: 'disabled' } | { type: 'enabled'; budget_tokens: number }
}

/**
 * 判断上游是否为 DeepSeek 官方 API（api.deepseek.com / api.intl.deepseek.com）。
 * 官方 API 严格校验参数：不认 vLLM 的 chat_template_kwargs，只认顶层 thinking 对象。
 */
export function isDeepSeekOfficialUpstream(baseUrl: unknown): boolean {
  const u = String(baseUrl ?? '').toLowerCase()
  try {
    const host = new URL(u.includes('://') ? u : `https://${u}`).host
    return host === 'api.deepseek.com' || host.endsWith('.deepseek.com')
  } catch {
    return false
  }
}

/** 把 Claude system（字符串或 block 数组）转为 OpenAI system message 文本 */
function systemToText(system: string | ClaudeContentBlock[] | undefined): string {
  if (system == null) return ''
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  return system
    .map((b) => {
      if (b && typeof b === 'object') {
        if (b.type === 'text') return b.text
        if (b.type === 'image') return '[image]'
      }
      return ''
    })
    .filter((s) => s.length)
    .join('\n')
}

/** 把 Claude content blocks 转为 OpenAI（text parts + image_url data URI） */
function claudeContentToOpenAi(content: ClaudeContentBlock[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const b of content || []) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text') {
      out.push({ type: 'text', text: b.text })
    } else if (b.type === 'image' && b.source && b.source.type === 'base64') {
      const mediaType = b.source.media_type || 'image/png'
      out.push({
        type: 'image_url',
        image_url: { url: `data:${mediaType};base64,${b.source.data}` },
      })
    }
  }
  return out
}

/**
 * 将 Claude Messages 请求规范为 OpenAI Chat Completions body。
 */
export function claudeRequestToOpenAi(
  model: ModelRow,
  body: ClaudeMessagesRequest,
): Record<string, unknown> {
  const upstreamModel = model.upstream_model || model.slug
  // 缓存签名用「上游模型 ID」：与响应侧 upstreamJson.model 一致，保证跨轮 key 稳定
  const reasoningSlug = upstreamModel
  const messages: Record<string, unknown>[] = []

  const sys = systemToText(body.system)
  if (sys) messages.push({ role: 'system', content: sys })

  for (const msg of body.messages || []) {
    const role = msg.role === 'assistant' ? 'assistant' : 'user'
    if (typeof msg.content === 'string') {
      const om = msg as Record<string, unknown>
      const out: Record<string, unknown> = { role, content: msg.content }
      // 兼容已是 DeepSeek/OpenAI 形状的 assistant（顶层带 reasoning_content / tool_calls）
      if (role === 'assistant') {
        if (om.reasoning_content != null) {
          out.reasoning_content = String(om.reasoning_content)
        }
        if (Array.isArray(om.tool_calls)) {
          out.tool_calls = om.tool_calls
          // 带 tool_calls 但缺 reasoning_content（被 Claude 剥离）：查缓存补挂，miss 用空串兜底
          if (out.reasoning_content == null) {
            const toolCallIds = om.tool_calls.map((c) => String((c as { id?: unknown })?.id ?? ''))
            out.reasoning_content = lookupReasoning(reasoningSlug, msg.content, toolCallIds) ?? ''
          }
        }
      }
      messages.push(out)
      continue
    }
    // 数组 content：按 block 类型分派（text/image → 内容；tool_use → tool_calls；tool_result → role:tool）
    const blocks = msg.content || []
    // assistant 消息可能同时带 thinking + text + tool_use（混合内容）
    if (role === 'assistant') {
      const texts: string[] = []
      const reasoningParts: string[] = []
      const toolCalls: Array<Record<string, unknown>> = []
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'text') {
          texts.push(b.text)
        } else if (b.type === 'thinking') {
          // Anthropic thinking -> DeepSeek reasoning_content（多块拼接，保持并集）
          reasoningParts.push(String((b as { thinking?: unknown }).thinking ?? ''))
        } else if (b.type === 'tool_use') {
          const tu = b as ClaudeToolUseBlock
          // arguments 是字符串（OpenAI），input 是对象（Anthropic）——这里反向序列化
          toolCalls.push({
            id: tu.id,
            type: 'function',
            function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
          })
        }
      }
      const out: Record<string, unknown> = { role, content: texts.join('') || null }
      // reasoning_content 来源优先级：thinking 块 > 服务端缓存（Claude 剥离后回传）> 空串兜底（带 tool_calls 必须回传）
      const textJoined = texts.join('')
      let reasoningOut = ''
      if (reasoningParts.length) {
        reasoningOut = reasoningParts.join('\n')
      } else if (toolCalls.length) {
        // DeepSeek 思考模式强校验：带 tool_calls 的 assistant 历史必须回传 reasoning_content（可为空串）
        const toolCallIds = toolCalls.map((c) => String((c as { id?: unknown }).id ?? ''))
        const cached = lookupReasoning(reasoningSlug, textJoined, toolCallIds)
        reasoningOut = cached ?? ''
      }
      if (reasoningOut || toolCalls.length) out.reasoning_content = reasoningOut
      if (toolCalls.length) out.tool_calls = toolCalls
      messages.push(out)
      continue
    }
    // user 消息：tool_result 必须拆成独立 role=tool 消息（tool_call_id 是链路主键）
    const userParts: Array<Record<string, unknown>> = []
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'tool_result') {
        const tr = b as ClaudeToolResultBlock
        // 先落已积累的普通 user parts
        if (userParts.length) {
          messages.push({ role: 'user', content: userParts.slice() })
          userParts.length = 0
        }
        let resultText = ''
        if (typeof tr.content === 'string') resultText = tr.content
        else if (Array.isArray(tr.content)) {
          resultText = tr.content
            .map((p) => (p && typeof p === 'object' && p.type === 'text' ? String(p.text ?? '') : ''))
            .filter(Boolean)
            .join('\n')
        }
        if (tr.is_error) resultText = `[tool error] ${resultText}`
        messages.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: resultText })
        continue
      }
      if (b.type === 'text') userParts.push({ type: 'text', text: b.text })
      else if (b.type === 'image' && b.source && b.source.type === 'base64') {
        userParts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type || 'image/png'};base64,${b.source.data}` } })
      }
    }
    if (userParts.length) messages.push({ role: 'user', content: userParts })
  }

  const payload: Record<string, unknown> = {
    model: upstreamModel,
    messages,
    max_tokens: Math.max(1, Math.floor(Number(body.max_tokens) || 1024)),
  }

  // tools：input_schema → parameters，并包一层 {type:'function', function:{...}}
  if (Array.isArray(body.tools) && body.tools.length) {
    payload.tools = body.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.input_schema ?? { type: 'object', properties: {} },
      },
    }))
  }
  // tool_choice：auto → 'auto'，any → 'required'，none → 'none'，tool → 指定函数
  if (body.tool_choice && body.tools && body.tools.length) {
    const tc = body.tool_choice
    if (tc.type === 'auto') payload.tool_choice = 'auto'
    else if (tc.type === 'none') payload.tool_choice = 'none'
    else if (tc.type === 'any') payload.tool_choice = 'required'
    else if (tc.type === 'tool' && tc.name) payload.tool_choice = { type: 'function', function: { name: tc.name } }
  }

  if (body.temperature != null) payload.temperature = Number(body.temperature)
  if (body.top_p != null) payload.top_p = Number(body.top_p)
  if (body.stream != null) payload.stream = Boolean(body.stream)
  if (body.stop_sequences && Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
    payload.stop = body.stop_sequences
  }

  // thinking 映射：Claude budget_tokens -> 上游思考模式参数
  if (body.thinking && body.thinking.type === 'enabled') {
    if (model.thinking_enabled) {
      const budget = Number(body.thinking.budget_tokens)
      // DeepSeek 官方 API 严格校验参数，只认顶层 thinking:{type,reasoning_effort}；
      // chat_template_kwargs 是 vLLM 私有扩展，发给 DeepSeek 官方会 400。
      if (isDeepSeekOfficialUpstream(model.upstream_base_url)) {
        payload.thinking = { type: 'enabled' }
      } else {
        payload.chat_template_kwargs = { ...(payload.chat_template_kwargs as object || {}), enable_thinking: true }
      }
      if (budget > 0) payload.max_tokens = Math.max(Number(payload.max_tokens), budget)
    }
  }

  return payload
}

/**
 * 将 OpenAI Chat Completions 非流式响应规范为 Claude Messages 形状。
 */
export function openAiResponseToClaude(
  upstreamJson: Record<string, unknown>,
): Record<string, unknown> {
  const choices = Array.isArray(upstreamJson.choices) ? upstreamJson.choices : []
  const first = (choices[0] as Record<string, unknown> | undefined) || {}
  const msg = (first.message as Record<string, unknown> | undefined) || {}
  const rawContent = String(msg.content ?? '')
  const reasoningContent = String((msg as { reasoning_content?: unknown }).reasoning_content ?? '')

  // 非流式也做标记解析：DSML -> tool_use、antArtifact -> artifact
  const contentParts = openAiContentToClaudeBlocks(rawContent)

  // DeepSeek 思考模式：reasoning_content -> Anthropic thinking block（置于文本之前）
  if (reasoningContent) {
    contentParts.unshift({ type: 'thinking', thinking: reasoningContent })
  }

  // OpenAI tool_calls -> Anthropic tool_use blocks（arguments 字符串必须 JSON.parse 成对象）
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
  for (const tc of toolCalls) {
    if (!tc || typeof tc !== 'object') continue
    const call = tc as Record<string, unknown>
    const fn = (call.function as Record<string, unknown> | undefined) || {}
    let input: Record<string, unknown> = {}
    const argsRaw = String(fn.arguments ?? '')
    if (argsRaw) {
      try {
        const parsed = JSON.parse(argsRaw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as Record<string, unknown>
      } catch {
        // arguments 非法 JSON：放进 input 的原始字段，保持信息不丢
        input = { _raw: argsRaw }
      }
    }
    contentParts.push({
      type: 'tool_use',
      id: String(call.id ?? `toolu_${Math.random().toString(36).slice(2, 10)}`),
      name: String(fn.name ?? 'unknown'),
      input,
    })
  }

  const usage = (upstreamJson.usage as Record<string, unknown>) || {}

  let stopReason = 'end_turn'
  const finish = String(first.finish_reason ?? '')
  if (finish === 'length') stopReason = 'max_tokens'
  else if (finish === 'stop') stopReason = 'end_turn'
  else if (finish === 'tool_calls') stopReason = 'tool_use'
  else if (finish === 'insufficient_system_resource') stopReason = 'end_turn'
  else if (finish) stopReason = finish
  const parsedToolUse = contentParts.some((b) => (b as { type?: string }).type === 'tool_use')
  if (parsedToolUse && finish !== 'length') stopReason = 'tool_use'

  // 缓存 reasoning_content 供多轮回传补挂（带 tool_calls 的轮次才需要）。
  // 注意：该字段对 DeepSeek 是强校验（缺失会 400），对 OpenAI 兼容上游是静默忽略。
  // 统一补挂是安全通用的（OpenAI 兼容层忽略未知历史字段），故不按上游分派。
  const toolUseIds = contentParts.filter((b) => (b as { type?: string }).type === 'tool_use').map((b) => String((b as { id?: unknown }).id ?? ''))
  // 仅当确实有 tool_use 且 reasoning_content 非空才缓存（避免空值污染非 DeepSeek 上游的缓存键）
  if (toolUseIds.length && reasoningContent) {
    rememberReasoning(String(upstreamJson.model ?? ''), rawContent, toolUseIds, reasoningContent)
  }

  return {
    id: String(upstreamJson.id ?? ''),
    type: 'message',
    role: 'assistant',
    model: String(upstreamJson.model ?? ''),
    content: contentParts,
    stop_reason: stopReason,
    usage: {
      input_tokens: Number(usage.prompt_tokens ?? 0) + Number(usage.completion_tokens ?? 0),
      output_tokens: Number(usage.completion_tokens ?? 0),
      // 保留拓展字段，供服务端计费读取
      prompt_tokens: Number(usage.prompt_tokens ?? 0),
      completion_tokens: Number(usage.completion_tokens ?? 0),
      input_tokens_details: usage.prompt_tokens_details ?? undefined,
    },
  }
}

/**
 * 把上游错误响应规范化为 Anthropic 错误形状（JSON body 或 SSE error 事件共用）。
 * 上游可能是 OpenAI 形状 {error:{message}}、纯文本、或 HTML，统一收敛。
 */
export function upstreamErrorToClaude(
  status: number,
  bodyText: string,
): { type: 'error'; error: { type: string; message: string } } {
  let message = ''
  const trimmed = (bodyText || '').trim()
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed) as Record<string, unknown>
      const err = (j.error as Record<string, unknown> | undefined) || {}
      message =
        String(err.message ?? '') ||
        String((j as { message?: unknown }).message ?? '') ||
        trimmed.slice(0, 300)
    } catch {
      message = trimmed.slice(0, 300)
    }
  } else {
    // 非 JSON（可能是 HTML 错误页）：剥离标签取可读文本
    message = trimmed.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300)
  }
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
  return { type: 'error', error: { type, message } }
}

/**
 * 非流式：把 OpenAI 返回的纯文本 content 拆成 Claude content blocks，
 * 识别 DSML（tool_calls / invoke / parameter）与 antArtifact 标签。
 */
export function openAiContentToClaudeBlocks(content: string): Array<Record<string, unknown>> {
  if (!content) return []
  const blocks: Array<Record<string, unknown>> = []
  const textBuf: string[] = []
  const flushText = () => {
    const t = textBuf.join('').trim()
    if (t) blocks.push({ type: 'text', text: t })
    textBuf.length = 0
  }

  const dsmlOne = /<｜DSML｜tool_calls>([\s\S]*?)<\/｜DSML｜tool_calls>/g
  const artOne = /<antArtifact\s+([^>]*)>([\s\S]*?)<\/antArtifact>/gi
  // 按 DSML/artifact 位置切分（兼容全角/半角竖线，DSML tool_calls 容忍无尾 >）
  const markerRe = /<[｜|]DSML[｜|]tool_calls\b[^>]*>?|<\/[｜|]DSML[｜|]tool_calls\s*>|<antArtifact\b[^>]*>|<\/antArtifact>/gi
  markerRe.lastIndex = 0
  const parts: Array<{ start: number; end: number; kind: 'dsml' | 'art' | 'text' }> = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = markerRe.exec(content)) !== null) {
    if (m.index > last) parts.push({ start: last, end: m.index, kind: 'text' })
    if (m[0].startsWith('<antArtifact')) {
      const close = content.indexOf('</antArtifact>', m.index)
      if (close >= 0) {
        parts.push({ start: m.index, end: close + '</antArtifact>'.length, kind: 'art' })
        last = close + '</antArtifact>'.length
        markerRe.lastIndex = last
        continue
      }
    } else if (m[0].startsWith('</')) {
      // 闭合标签单独出现：当作文本边界
      parts.push({ start: m.index, end: m.index + m[0].length, kind: 'text' })
      last = m.index + m[0].length
      markerRe.lastIndex = last
      continue
    } else if (/tool_calls\b/i.test(m[0])) {
      // DSML 开标签
      const close = findDsmlEnd(content, m.index)
      if (close >= 0) {
        const endLen = dsmlEndTagLen(content, close)
        parts.push({ start: m.index, end: close + endLen, kind: 'dsml' })
        last = close + endLen
        markerRe.lastIndex = last
        continue
      }
    }
    // 其余当作文本片段的边界
    parts.push({ start: m.index, end: m.index + m[0].length, kind: 'text' })
    last = m.index + m[0].length
    markerRe.lastIndex = last
  }
  if (last < content.length) parts.push({ start: last, end: content.length, kind: 'text' })

  for (const p of parts) {
    const seg = content.slice(p.start, p.end)
    if (p.kind === 'text') {
      let t = seg
      // 清除散落的 DSML 单标签
      t = t.replace(DSML_ANY_OPEN_RE, '').replace(DSML_ANY_CLOSE_RE, '')
      if (t.trim()) textBuf.push(t)
    } else if (p.kind === 'dsml') {
      flushText()
      const events = parseNonStreamDsml(seg)
      blocks.push(...events)
    } else if (p.kind === 'art') {
      flushText()
      const art = parseArtifactNonStream(seg)
      if (art) blocks.push(art)
    }
  }
  flushText()
  return blocks
}

/** 解析非流式 DSML 块为 tool_use content blocks */
function parseNonStreamDsml(raw: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  DSML_INVOKE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = DSML_INVOKE_RE.exec(raw)) !== null) {
    const nameMatch = m[0].match(DSML_INVOKE_OPEN_RE)
    const name = nameMatch ? nameMatch[1].trim() : 'unknown'
    const input: Record<string, unknown> = {}
    DSML_PARAM_RE.lastIndex = 0
    let pm: RegExpExecArray | null
    while ((pm = DSML_PARAM_RE.exec(m[0])) !== null) {
      const key = pm[1].trim()
      const isString = pm[2] === 'true'
      let val: unknown = pm[3] ?? ''
      if (!isString) {
        try { val = JSON.parse(val as string) } catch { val = (val as string).trim() }
      } else {
        val = (val as string).trim()
      }
      input[key] = val
    }
    out.push({ type: 'tool_use', id: `toolu_${Date.now().toString(36)}_${out.length}`, name, input })
  }
  return out
}

/** 解析非流式 antArtifact 块为 artifact content block */
function parseArtifactNonStream(raw: string): Record<string, unknown> | null {
  const openMatch = raw.match(ARTIFACT_OPEN_RE)
  if (!openMatch) return null
  const attrs = openMatch[1]
  const idAttrs = attrs.match(/identifier="([^"]*)"/)
  const typAttrs = attrs.match(/type="([^"]*)"/)
  const titleAttrs = attrs.match(/title="([^"]*)"/)
  const closeAt = raw.lastIndexOf(ARTIFACT_CLOSE)
  const code = raw.slice(openMatch[0].length, closeAt >= 0 ? closeAt : undefined).trim()
  return {
    type: 'artifact',
    identifier: idAttrs ? idAttrs[1] : 'artifact',
    content_type: typAttrs ? typAttrs[1] : 'application/vnd.ant.code',
    title: titleAttrs ? titleAttrs[1] : '',
    text: code,
  }
}

/**
 * 将 OpenAI 流式 SSE chunk 规范为 Claude 流式事件结构化对象。
 * 返回的事件按 Claude Messages 流式协议命名（message_start /
 * content_block_start / content_block_delta / content_block_stop /
 * message_delta / message_stop）。
 */
export function openAiStreamChunkToClaude(
  raw: Record<string, unknown>,
  usageHint?: { input_tokens?: number; output_tokens?: number },
  contentStream?: ClaudeContentStream,
): { events: Array<{ event: string; data: Record<string, unknown> }>; done: boolean } {
  const events: Array<{ event: string; data: Record<string, unknown> }> = []
  const choices = Array.isArray(raw.choices) ? raw.choices : []
  const first = (choices[0] as Record<string, unknown> | undefined) || {}
  const delta = (first.delta as Record<string, unknown> | undefined) || {}
  const finish = first.finish_reason

  const text = String(delta.content ?? '')
  if (text) {
    if (contentStream) {
      // 识别 DSML / antArtifact，转成结构化 content_block 事件
      events.push(...contentStream.appendText(text))
    } else {
      events.push({
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      })
    }
  }

  // DeepSeek 思考模式流式：reasoning_content -> thinking 块（start → thinking_delta → stop）
  const reasoning = String((delta as { reasoning_content?: unknown }).reasoning_content ?? '')
  if (reasoning && contentStream) {
    events.push(...contentStream.appendThinking(reasoning))
  }

  // OpenAI 流式工具调用分片 -> Anthropic tool_use 块（start + input_json_delta + stop）
  const streamToolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
  if (streamToolCalls.length && contentStream) {
    events.push(...contentStream.appendToolCallDeltas(streamToolCalls))
  }

  if (finish) {
    let stopReason = 'end_turn'
    if (finish === 'length') stopReason = 'max_tokens'
    else if (finish === 'stop') stopReason = 'end_turn'
    else if (finish === 'tool_calls') stopReason = 'tool_use'
    else if (finish === 'content_filter') stopReason = 'end_turn'
    else if (finish === 'insufficient_system_resource') stopReason = 'end_turn'
    else stopReason = String(finish)

    // 若通过 DSML 转出了工具调用，且上游没给明确的 length，则 stop_reason 应为 tool_use
    if (contentStream?.emittedToolUse && finish !== 'length') {
      stopReason = 'tool_use'
    }

    if (contentStream) {
      // 关闭仍打开的文本块（若有 DSML/artifact，块早已 stop）
      events.push(...contentStream.close())
    } else {
      events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } })
    }
    events.push({
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: usageHint
          ? { input_tokens: Number(usageHint.input_tokens ?? 0), output_tokens: Number(usageHint.output_tokens ?? 0) }
          : { output_tokens: 0 },
      },
    })
    events.push({ event: 'message_stop', data: { type: 'message_stop' } })
    return { events, done: true }
  }

  return { events, done: false }
}

/** 统计 Claude messages 中的图片张数（OpenAI 兼容 content parts） */
export function countClaudeImages(messages: unknown): number {
  if (!Array.isArray(messages)) return 0
  let n = 0
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue
    const content = (msg as Record<string, unknown>).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      if (String((part as Record<string, unknown>).type).toLowerCase() === 'image') n += 1
    }
  }
  return n
}

/** 统计 Claude messages 文本长度，用于无 usage 时的粗估 token */
export function estimateClaudeTokens(messages: unknown, system?: unknown): { promptTokens: number } {
  const textParts: string[] = []
  if (system) textParts.push(systemToText(system as ClaudeContentBlock[] | string))
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue
      const c = (msg as Record<string, unknown>).content
      if (typeof c === 'string') textParts.push(c)
      else if (Array.isArray(c)) {
        for (const p of c) {
          if (p && typeof p === 'object' && (p as Record<string, unknown>).type === 'text') {
            textParts.push(String((p as Record<string, unknown>).text ?? ''))
          }
        }
      }
    }
  }
  const s = JSON.stringify(textParts) || ''
  return { promptTokens: Math.max(1, Math.ceil(s.length / 4)) }
}

/** 构造 Claude 流式的起始事件（message_start + content_block_start） */
export function claudeStreamStartEvents(
  modelName: string,
  inputTokens: number,
  withoutContentBlock = false,
): Array<{ event: string; data: Record<string, unknown> }> {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: `msg_${Date.now().toString(36)}`,
          type: 'message',
          role: 'assistant',
          model: modelName,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 0 },
        },
      },
    },
  ]
  if (!withoutContentBlock) {
    events.push({
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
    })
  }
  return events
}

// ============================================================================
// DeepSeek DSML / antArtifact 标记 -> Anthropic 结构化 content_block 转换
//
// 模型（如 DeepSeek-V4）在纯文本里输出 <｜DSML｜tool_calls> 或 <antArtifact>
// 标签。Claude Code 客户端只识别结构化 content_block（tool_use / artifact），
// 不会解析文本里的这些标记。本模块把流式文本增量解析成标准 SSE 事件，
// 让工具调用与工件被客户端正确执行/渲染，而不是把原始标签打印出来。
// ============================================================================

/** DSML / artifact 标记相关的常量字符串（兼容全角 ｜ 与半角 | 两种竖线） */
const DSML_TOOL_START_FULL = '<｜DSML｜tool_calls'
const DSML_TOOL_START_HALF = '<|DSML|tool_calls'
const DSML_TOOL_END_FULL = '</｜DSML｜tool_calls>'
const DSML_TOOL_END_HALF = '</|DSML|tool_calls>'
const DSML_INVOKE_RE = /<[｜|]DSML[｜|]invoke\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/[｜|]DSML[｜|]invoke>/g
const DSML_INVOKE_OPEN_RE = /<[｜|]DSML[｜|]invoke\s+name="([^"]*)"[^>]*>/
const DSML_PARAM_RE = /<[｜|]DSML[｜|]parameter\s+name="([^"]*)"\s+string="(true|false)"[^>]*>([\s\S]*?)<\/[｜|]DSML[｜|]parameter>/g
const ARTIFACT_OPEN_RE = /<antArtifact\s+([^>]*)>/i
const ARTIFACT_CLOSE = '</antArtifact>'
const DSML_ANY_OPEN_RE = /<[｜|]DSML[｜|][a-zA-Z_]*>/g
const DSML_ANY_CLOSE_RE = /<\/[｜|]DSML[｜|][a-zA-Z_]*>/g

/** 在 buf 里找 DSML tool_calls 块起始位置（兼容全角/半角竖线），找不到返回 -1 */
function findDsmlStart(buf: string): number {
  const i1 = buf.indexOf(DSML_TOOL_START_FULL)
  const i2 = buf.indexOf(DSML_TOOL_START_HALF)
  if (i1 < 0) return i2
  if (i2 < 0) return i1
  return Math.min(i1, i2)
}

/** 在 buf 里从 from 开始找 DSML tool_calls 块结束位置，找不到返回 -1 */
function findDsmlEnd(buf: string, from: number): number {
  const i1 = buf.indexOf(DSML_TOOL_END_FULL, from)
  const i2 = buf.indexOf(DSML_TOOL_END_HALF, from)
  if (i1 < 0) return i2
  if (i2 < 0) return i1
  return Math.min(i1, i2)
}

/** 返回 from 处的 DSML 结束标记长度（全角或半角） */
function dsmlEndTagLen(buf: string, from: number): number {
  if (buf.startsWith(DSML_TOOL_END_FULL, from)) return DSML_TOOL_END_FULL.length
  if (buf.startsWith(DSML_TOOL_END_HALF, from)) return DSML_TOOL_END_HALF.length
  return 0
}

type EmittedEvent = { event: string; data: Record<string, unknown> }

/** 从单个 <｜DSML｜invoke> 块解析出 tool_use 参数 */
function parseDsmlInvoke(raw: string, idx: number): EmittedEvent[] {
  const events: EmittedEvent[] = []
  const nameMatch = raw.match(DSML_INVOKE_OPEN_RE)
  const name = nameMatch ? nameMatch[1].trim() : 'unknown'
  const input: Record<string, unknown> = {}
  let m: RegExpExecArray | null
  DSML_PARAM_RE.lastIndex = 0
  while ((m = DSML_PARAM_RE.exec(raw)) !== null) {
    const key = m[1].trim()
    const isString = m[2] === 'true'
    let val: unknown = m[3] ?? ''
    if (!isString) {
      try {
        val = JSON.parse(val as string)
      } catch {
        val = (val as string).trim()
      }
    } else {
      val = (val as string).trim()
    }
    input[key] = val
  }
  // 单个 invoke 作为一个完整 content_block（start + input_json_delta + stop）
  events.push({
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: idx,
      content_block: { type: 'tool_use', id: `toolu_${Date.now().toString(36)}`, name, input },
    },
  })
  events.push({
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
  })
  events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: idx } })
  return events
}

/** 解析完整的 <antArtifact> 块，返回 content_block（start + text_delta + stop） */
function parseArtifact(raw: string, idx: number): EmittedEvent[] {
  const events: EmittedEvent[] = []
  const openMatch = raw.match(ARTIFACT_OPEN_RE)
  let identifier = 'artifact'
  let type = 'application/vnd.ant.code'
  let title = ''
  let code = ''
  if (openMatch) {
    const attrs = openMatch[1]
    const idAttrs = attrs.match(/identifier="([^"]*)"/)
    const typAttrs = attrs.match(/type="([^"]*)"/)
    const titleAttrs = attrs.match(/title="([^"]*)"/)
    if (idAttrs) identifier = idAttrs[1]
    if (typAttrs) type = typAttrs[1]
    if (titleAttrs) title = titleAttrs[1]
    const closeAt = raw.lastIndexOf(ARTIFACT_CLOSE)
    code = raw.slice(openMatch[0].length, closeAt >= 0 ? closeAt : undefined).trim()
  }
  events.push({
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: idx,
      content_block: { type: 'artifact', identifier, content_type: type, title },
    },
  })
  if (code) {
    events.push({
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: code } },
    })
  }
  events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: idx } })
  return events
}

/**
 * 流式「内容」状态机：逐 chunk 接收 OpenAI 流式文本，增量识别
 * DSML / antArtifact 结构，并负责对外输送一整个、符合 Claude 协议的
 * content_block 生命周期（start -> delta... -> stop）。
 *
 * 约定：调用方通过 `claudeStreamStartEvents` 只发 `message_start`（不含
 * content_block_start）。text / tool_use / artifact 的 content_block_start
 * 全部由本类按需发出，index 由本类统一分配，保证与内容顺序一致。
 *
 * 用法：
 *   const ms = new ClaudeContentStream()
 *   events.push(...ms.appendText(textChunk))   // 每个文本增量
 *   events.push(...ms.close())                 // 结束/上游 finish 时冲刷
 */
export class ClaudeContentStream {
  private buf = ''
  private nextIndex = 0
  /** 是否有「文本块」正处于打开（已 start、未 stop）状态 */
  private textOpen = false
  private textIndex = -1
  /** 本次响应是否产出过 tool_use 块（用于 message_delta.stop_reason = tool_use） */
  private _emittedToolUse = false
  /** 累计快照：供多轮回传补挂 reasoning_content 缓存 */
  private snapText = ''
  private snapReasoning = ''
  private snapToolCallIds: string[] = []
  /** 流式 tool_call 分片聚合状态：openAiIndex -> {id, name, argsStr, blockIndex} */
  private openToolCalls = new Map<number, { id: string; name: string; argsStr: string; blockIndex: number }>()
  /** 流式 thinking 块状态：index、是否已 start、是否已 stop */
  private thinkingState: { index: number; open: boolean; closed: boolean } | null = null

  /**
   * DeepSeek 思考模式流式：reasoning_content 增量 -> Anthropic thinking 块。
   * 块生命周期：content_block_start(thinking) → thinking_delta… → content_block_stop。
   * thinking 必须先于正文输出，正文到来时由 appendText 内部先关闭 thinking 块。
   */
  appendThinking(text: string): EmittedEvent[] {
    if (!text) return []
    this.snapReasoning += text
    const events: EmittedEvent[] = []
    if (!this.thinkingState) {
      events.push(...this.closeText())
      const index = this.nextIndex++
      this.thinkingState = { index, open: true, closed: false }
      events.push({
        event: 'content_block_start',
        data: { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } },
      })
    }
    if (this.thinkingState.open) {
      events.push({
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: this.thinkingState.index,
          delta: { type: 'thinking_delta', thinking: text },
        },
      })
    }
    return events
  }

  /** 关闭 thinking 块（正文/工具开始前调用；幂等） */
  private closeThinking(): EmittedEvent[] {
    if (!this.thinkingState || !this.thinkingState.open) return []
    const events: EmittedEvent[] = [{ event: 'content_block_stop', data: { type: 'content_block_stop', index: this.thinkingState.index } }]
    this.thinkingState.open = false
    this.thinkingState.closed = true
    return events
  }

  /** 是否产出了工具调用（供 finish 时决定 stop_reason） */
  get emittedToolUse(): boolean {
    return this._emittedToolUse
  }

  /** 累计快照：供 proxy 流式收尾写 reasoning_content 缓存（跨轮补挂用） */
  snapshot(): { text: string; reasoning: string; toolCallIds: string[] } {
    return { text: this.snapText, reasoning: this.snapReasoning, toolCallIds: this.snapToolCallIds.slice() }
  }

  /** 累计一段文本，返回需发送的 SSE 事件 */
  appendText(text: string): EmittedEvent[] {
    if (!text) return []
    this.snapText += text
    // 正文开始：先关闭 thinking 块（Anthropic 顺序要求 thinking 在前）
    const pre = this.closeThinking()
    this.buf += text
    return [...pre, ...this.drain()]
  }

  /**
   * 处理 OpenAI 流式 delta.tool_calls 分片。
   * 首片带 id+name（发 content_block_start tool_use），后续片只有 arguments 增量
   * （原样作为 input_json_delta 转发，不提前 json.loads）。
   */
  appendToolCallDeltas(toolCalls: unknown[]): EmittedEvent[] {
    const events: EmittedEvent[] = []
    for (const raw of toolCalls) {
      if (!raw || typeof raw !== 'object') continue
      const tc = raw as Record<string, unknown>
      const oaiIdx = Number(tc.index ?? 0)
      const fn = (tc.function as Record<string, unknown> | undefined) || {}
      let st = this.openToolCalls.get(oaiIdx)
      if (!st) {
        // 先关掉打开中的文本块，保证 tool_use 块顺序正确
        events.push(...this.closeText())
        const id = String(tc.id ?? `toolu_${Date.now().toString(36)}_${oaiIdx}`)
        this.snapToolCallIds.push(id)
        const name = String(fn.name ?? '')
        const blockIndex = this.nextIndex++
        st = { id, name, argsStr: '', blockIndex }
        this.openToolCalls.set(oaiIdx, st)
        this._emittedToolUse = true
        events.push({
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'tool_use', id, name, input: {} },
          },
        })
      } else if (fn.name && !st.name) {
        st.name = String(fn.name)
      }
      const argDelta = String(fn.arguments ?? '')
      if (argDelta) {
        st.argsStr += argDelta
        events.push({
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: st.blockIndex,
            delta: { type: 'input_json_delta', partial_json: argDelta },
          },
        })
      }
    }
    return events
  }

  /** 冲刷：关闭仍打开的文本块 + 收尾未结束的 tool_call 块 + 清空 buffer */
  close(): EmittedEvent[] {
    const events: EmittedEvent[] = []
    if (this.textOpen) {
      events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: this.textIndex } })
      this.textOpen = false
    }
    events.push(...this.closeThinking())
    // 收尾所有打开的 tool_call 块
    for (const [, st] of this.openToolCalls) {
      events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: st.blockIndex } })
    }
    this.openToolCalls.clear()
    this.buf = ''
    return events
  }

  private drain(): EmittedEvent[] {
    const events: EmittedEvent[] = []
    let guard = 0
    while (this.buf.length && guard++ < 200) {
      const dsmlStart = findDsmlStart(this.buf)
      const artMatch = this.buf.match(ARTIFACT_OPEN_RE)
      const artStart = artMatch ? artMatch.index! : -1

      // 无任何结构标记开头：纯文本期
      if (dsmlStart < 0 && artStart < 0) {
        // 先把缓冲区里残留的 DSML 单开标签清理掉（残缺/意外出现的），
        // 但保留真正的文本。这里若 buffer 全是普通文本则直接输出。
        events.push(...this.emitText(this.buf))
        this.buf = ''
        break
      }

      // 找到最近的标记位置
      let markerStart = -1
      if (dsmlStart >= 0) markerStart = dsmlStart
      if (artStart >= 0 && (markerStart < 0 || artStart < markerStart)) markerStart = artStart

      // 标记之前的普通文本先输出
      if (markerStart > 0) {
        const lead = this.buf.slice(0, markerStart)
        events.push(...this.emitText(lead))
        this.buf = this.buf.slice(markerStart)
        continue
      }

      // DSML 完整块
      if (dsmlStart === markerStart) {
        const dsmlEnd = findDsmlEnd(this.buf, dsmlStart)
        if (dsmlEnd >= 0) {
          const endTagLen = dsmlEndTagLen(this.buf, dsmlEnd)
          const blockRaw = this.buf.slice(dsmlStart, dsmlEnd + endTagLen)
          this.buf = this.buf.slice(dsmlEnd + endTagLen)
          events.push(...this.closeText())
          events.push(...this.emitToolBlock(blockRaw))
          continue
        }
        // DSML 已开始但未结束：停止等待后续 chunk（不输出残缺文本）
        break
      }

      // antArtifact 完整块
      if (artStart === markerStart) {
        const artClose = this.buf.indexOf(ARTIFACT_CLOSE, artStart)
        if (artClose >= 0) {
          const blockRaw = this.buf.slice(artStart, artClose + ARTIFACT_CLOSE.length)
          this.buf = this.buf.slice(artClose + ARTIFACT_CLOSE.length)
          events.push(...this.closeText())
          events.push(...parseArtifact(blockRaw, this.nextIndex++))
          continue
        }
        // 正在解析 artifact：累积文本，静默等待结束
        break
      }
      break
    }
    return events
  }

  /** 输出缓冲里的普通文本为 text content_block 的 delta，必要时先开块 */
  private emitText(text: string): EmittedEvent[] {
    if (!text) return []
    const events: EmittedEvent[] = []
    // 清理可能混入的残缺 DSML 开标签
    const clean = text.replace(DSML_ANY_OPEN_RE, '')
    if (!clean) return events
    if (!this.textOpen) {
      this.textIndex = this.nextIndex++
      this.textOpen = true
      events.push({
        event: 'content_block_start',
        data: { type: 'content_block_start', index: this.textIndex, content_block: { type: 'text', text: '' } },
      })
    }
    events.push({
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: this.textIndex, delta: { type: 'text_delta', text: clean } },
    })
    return events
  }

  /** 关闭当前打开的文本块（若存在） */
  private closeText(): EmittedEvent[] {
    if (!this.textOpen) return []
    const events: EmittedEvent[] = [{ event: 'content_block_stop', data: { type: 'content_block_stop', index: this.textIndex } }]
    this.textOpen = false
    return events
  }

  private emitToolBlock(raw: string): EmittedEvent[] {
    const events: EmittedEvent[] = []
    DSML_INVOKE_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = DSML_INVOKE_RE.exec(raw)) !== null) {
      this._emittedToolUse = true
      events.push(...parseDsmlInvoke(m[0], this.nextIndex++))
    }
    return events
  }
}

/**
 * Anthropic SSE 流转换器：上游（透传路径）返回的 Claude Messages SSE 里，
 * content 块可能以「纯文本」形式携带 DSML / antArtifact 标签。Claude Code 客户端
 * 只认结构化 content_block。本类把上游的 content_block_start/delta/stop 事件吞掉，
 * 从累积的 text_delta 文本里用 ClaudeContentStream 重建规范 content_block，
 * 只保留 message_start / message_delta / message_stop。
 *
 * 用法（透传路径）：
 *   const t = new ClaudePassthroughSse()
 *   for (const { event, data } of upstreamEvents) writes(...t.pushEvent(event, data))
 *   writes(...t.finish())
 */
export class ClaudePassthroughSse {
  private cs = new ClaudeContentStream()
  private collect = ''
  private started = false
  private sawDelta = false
  /** 上游已输出结构化 content block（tool_use 等）时待透传的 content_block_start */
  private pendingStart: EmittedEvent | null = null

  /** 接收上游一个 SSE 事件（event 名 + data 对象），返回应发给客户端的 SSE 事件列表 */
  pushEvent(event: string, data: unknown): EmittedEvent[] {
    const out: EmittedEvent[] = []
    if (event === 'message_start') {
      out.push({ event, data: data as Record<string, unknown> })
      this.started = true
      return out
    }
    if (event === 'content_block_start') {
      const cb = (data as { content_block?: { type?: string } })?.content_block
      if (cb && cb.type !== 'text') {
        // 上游是结构化 tool_use 等：暂存 start，等非 text delta 或 stop 到来时透传
        this.pendingStart = { event, data: data as Record<string, unknown> }
      }
      // 纯文本块 start：吞掉，交给重建
      return out
    }
    if (event === 'content_block_stop') {
      if (this.pendingStart) {
        out.push(this.pendingStart)
        this.pendingStart = null
      }
      return out
    }
    if (event === 'content_block_delta') {
      this.sawDelta = true
      const d = data as { delta?: { type?: string; text?: unknown } } | undefined
      if (d?.delta?.type === 'text_delta') {
        this.collect += String(d.delta.text ?? '')
        return out
      }
      // 非 text（如 input_json_delta / thinking_delta）：上游已结构化，先补 start 再透传
      if (this.pendingStart) {
        out.push(this.pendingStart)
        this.pendingStart = null
      }
      out.push({ event, data: data as Record<string, unknown> })
      return out
    }
    if (event === 'message_delta') {
      // 先把累积文本重建为 content 事件
      if (this.collect && this.sawDelta) {
        out.push(...this.cs.appendText(this.collect))
        out.push(...this.cs.close())
        this.collect = ''
      }
      if (this.pendingStart) {
        out.push(this.pendingStart)
        this.pendingStart = null
      }
      // stop_reason：若有工具调用且上游没给 length，补 tool_use
      const md = data as { delta?: { stop_reason?: string } } | undefined
      const stop = md?.delta?.stop_reason
      if (this.cs.emittedToolUse && stop !== 'max_tokens' && md?.delta) {
        const merged = JSON.parse(JSON.stringify(data)) as Record<string, unknown>
        const delta = (merged.delta as Record<string, unknown>) || {}
        delta.stop_reason = 'tool_use'
        merged.delta = delta
        out.push({ event, data: merged })
      } else {
        out.push({ event, data: data as Record<string, unknown> })
      }
      return out
    }
    if (event === 'message_stop') {
      out.push({ event, data: data as Record<string, unknown> })
      return out
    }
    if (event === 'ping') return out
    return out
  }

  /** 处理完所有上游事件后调用，冲刷残留 */
  finish(): EmittedEvent[] {
    const out: EmittedEvent[] = []
    if (this.pendingStart) {
      out.push(this.pendingStart)
      this.pendingStart = null
    }
    if (this.collect && this.sawDelta) {
      const e = this.cs.appendText(this.collect)
      this.collect = ''
      out.push(...e)
      out.push(...this.cs.close())
    }
    return out
  }
}
