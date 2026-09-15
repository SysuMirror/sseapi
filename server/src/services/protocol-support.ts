import { anthropicMessagesUrl, responsesUrl, anthropicAuthHeader, upstreamAuthHeader } from './proxy-common.js'
import { claudeRequestToOpenAi } from './claude-adapter.js'
import { responsesRequestToOpenAi } from './responses-adapter.js'
import type { ModelRow } from '../db.js'

/**
 * 上游协议支持 / 连通性探测。
 *
 * 管理台开启某协议开关后，可对「该协议是否可用」做一次最小探测，分两种情况：
 *  1) 配置了该协议独立 base_url（baseUrl 非空）：
 *     直接发该协议请求，判断上游是否「原生支持」该协议：
 *       - anthropic：响应含 type=message 且 content 数组 → mode=passthrough
 *       - responses：响应含 object=response 且 output 数组 → mode=passthrough
 *     若不支持 → mode=relay（建议平台反代）。
 *  2) 未配置独立 base_url（反代模式）：
 *     将探测请求经转换适配转成 OpenAI chat，打到 openai 上游（openAiBaseUrl），
 *     验证「反代链路」是否连通 → supported=true 表示链路可用，mode=relay。
 *
 * 探测结果用于指导管理员：到底选「透传」还是「反代」，以及链路是否真正可用。
 */

export type ProtocolSupportResult = {
  ok: boolean
  supported: boolean
  mode: 'passthrough' | 'relay'
  protocol: 'anthropic' | 'responses'
  viaRelay: boolean
  httpStatus: number
  elapsedMs: number
  upstreamUrl: string
  message: string
  rawPreview: string
}

export type ProtocolProbeInput = {
  /** 该协议独立 base（anthropic_base_url / responses_base_url）；空=走反代 */
  baseUrl: string
  /** openai 上游 base（反代目标）；仅 baseUrl 为空时使用 */
  openAiBaseUrl?: string
  protocol: 'anthropic' | 'responses'
  upstreamModel: string
  apiKey?: string
}

const PROBE_TIMEOUT_MS = 12_000

function safeProbeBody(protocol: 'anthropic' | 'responses', model: string): Record<string, unknown> {
  if (protocol === 'anthropic') {
    return {
      model,
      max_tokens: 32,
      stream: false,
      messages: [{ role: 'user', content: 'ping' }],
    }
  }
  return { model, input: 'ping', stream: false, max_output_tokens: 16 }
}

function looksLikeAnthropic(json: unknown): boolean {
  const j = json as Record<string, unknown> | null
  if (!j || typeof j !== 'object') return false
  if (String(j.type) !== 'message') return false
  const content = j.content
  return Array.isArray(content) && content.length > 0
}

function looksLikeResponses(json: unknown): boolean {
  const j = json as Record<string, unknown> | null
  if (!j || typeof j !== 'object') return false
  if (String(j.object) !== 'response') return false
  const output = j.output
  return Array.isArray(output) && output.length > 0
}

function buildProbeRow(model: string, apiKey: string, baseUrl: string, openAiBase: string): ModelRow {
  return {
    id: 0,
    slug: model,
    display_name: model,
    description: '',
    badge: '',
    card_color: '',
    model_type: 'chat',
    upstream_api_format: 'openai',
    upstream_path_override: '',
    upstream_base_url: openAiBase,
    upstream_model: model,
    upstream_api_key: apiKey,
    anthropic_base_url: baseUrl,
    anthropic_enabled: 0,
    responses_base_url: baseUrl,
    responses_enabled: 0,
    allowed_origins: '',
    rpm_limit: 0,
    max_concurrent: 0,
    input_price_per_1m: 0,
    output_price_per_1m: 0,
    cache_price_per_1m: 0,
    multimodal_enabled: 0,
    image_billing_mode: 'token',
    image_price_per_1m: 0,
    image_price_per_image: 0,
    image_tokens_per_image: 512,
    thinking_enabled: 0,
    thinking_levels: '[]',
    default_thinking: 'off',
    claude_compat: 0,
    context_length: 0,
    dev_only: 0,
    enabled: 1,
    sort_order: 0,
    created_at: '',
    updated_at: '',
  }
}

function chatUrl(base: string): string {
  const b = String(base || '').replace(/\/$/, '')
  return /\/v1$/.test(b) ? `${b}/chat/completions` : `${b}/v1/chat/completions`
}

export async function probeProtocolSupport(input: ProtocolProbeInput): Promise<ProtocolSupportResult> {
  const base = String(input.baseUrl || '').trim().replace(/\/$/, '')
  const openAiBase = String(input.openAiBaseUrl || '').trim().replace(/\/$/, '')
  const ts = Date.now()

  // —— 无独立 base：反代连通性探测（转 chat 打到 openai 上游）——
  if (!base) {
    if (!openAiBase) {
      return {
        ok: false,
        supported: false,
        mode: 'relay',
        protocol: input.protocol,
        viaRelay: true,
        httpStatus: 0,
        elapsedMs: 0,
        upstreamUrl: '',
        message: '未配置目标 Base URL（该协议将走反代，但没有 OpenAI 上游可测）',
        rawPreview: '',
      }
    }
    const row = buildProbeRow(input.upstreamModel, input.apiKey || '', '', openAiBase)
    const url = chatUrl(openAiBase)
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...upstreamAuthHeader(row) }
    const nativeBody = safeProbeBody(input.protocol, input.upstreamModel)
    let chatPayload: Record<string, unknown>
    try {
      chatPayload =
        input.protocol === 'anthropic'
          ? claudeRequestToOpenAi(row, nativeBody as never)
          : responsesRequestToOpenAi(row, nativeBody)
    } catch (e) {
      return {
        ok: false,
        supported: false,
        mode: 'relay',
        protocol: input.protocol,
        viaRelay: true,
        httpStatus: 0,
        elapsedMs: Date.now() - ts,
        upstreamUrl: url,
        message: `转为 ${input.protocol} 失败：${e instanceof Error ? e.message : String(e)}`,
        rawPreview: '',
      }
    }
    delete (chatPayload as Record<string, unknown>).api_key
    let upstreamRes: globalThis.Response
    try {
      upstreamRes = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(chatPayload),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
    } catch (e) {
      return {
        ok: false,
        supported: false,
        mode: 'relay',
        protocol: input.protocol,
        viaRelay: true,
        httpStatus: 0,
        elapsedMs: Date.now() - ts,
        upstreamUrl: url,
        message: `反代链路连接失败：${e instanceof Error ? e.message : String(e)}`,
        rawPreview: '',
      }
    }
    const text = await upstreamRes.text()
    const elapsedMs = Date.now() - ts
    const ok = upstreamRes.ok
    return {
      ok,
      supported: ok,
      mode: 'relay',
      protocol: input.protocol,
      viaRelay: true,
      httpStatus: upstreamRes.status,
      elapsedMs,
      upstreamUrl: url,
      message: ok
        ? `未配置独立上游，将反代（转 chat 到 OpenAI）。链路连通（HTTP ${upstreamRes.status}）`
        : `反代链路异常：HTTP ${upstreamRes.status}（${text.slice(0, 200)}）`,
      rawPreview: text.slice(0, 300),
    }
  }

  // —— 有独立 base：探测原生透传支持 ——
  const probeRow = buildProbeRow(input.upstreamModel, input.apiKey || '', base, openAiBase)
  const url = input.protocol === 'anthropic' ? anthropicMessagesUrl(base) : responsesUrl(base)
  const headers: Record<string, string> =
    input.protocol === 'anthropic'
      ? { 'content-type': 'application/json', ...anthropicAuthHeader(probeRow) }
      : { 'Content-Type': 'application/json', ...upstreamAuthHeader(probeRow) }
  const payload = safeProbeBody(input.protocol, input.upstreamModel)

  let upstreamRes: globalThis.Response
  try {
    upstreamRes = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
  } catch (e) {
    return {
      ok: false,
      supported: false,
      mode: 'relay',
      protocol: input.protocol,
      viaRelay: false,
      httpStatus: 0,
      elapsedMs: Date.now() - ts,
      upstreamUrl: url,
      message: `上游连接失败：${e instanceof Error ? e.message : String(e)}`,
      rawPreview: '',
    }
  }

  const elapsedMs = Date.now() - ts
  const text = await upstreamRes.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }

  const supported =
    upstreamRes.ok &&
    (input.protocol === 'anthropic' ? looksLikeAnthropic(json) : looksLikeResponses(json))

  const shape = input.protocol === 'anthropic' ? 'type=message + content[]' : 'object=response + output[]'
  const errObj = (json as Record<string, unknown> | null)?.error as Record<string, unknown> | undefined
  const errText = String(errObj?.message || text.slice(0, 200) || `HTTP ${upstreamRes.status}`)

  return {
    ok: true,
    supported,
    mode: supported ? 'passthrough' : 'relay',
    protocol: input.protocol,
    viaRelay: false,
    httpStatus: upstreamRes.status,
    elapsedMs,
    upstreamUrl: url,
    message: supported
      ? `上游原生支持 ${input.protocol}（返回 ${shape}），可透传`
      : `上游未返回 ${input.protocol} 格式（期望 ${shape}），建议反代（转 chat）`,
    rawPreview: supported ? text.slice(0, 300) : errText.slice(0, 300),
  }
}
