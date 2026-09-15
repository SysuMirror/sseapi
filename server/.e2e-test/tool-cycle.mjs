// 专项单测：Tool Calling 协议双向转换（OpenAI Chat Completions <-> Anthropic Messages）
// 覆盖：tools 定义、tool_choice、assistant tool_use -> tool_calls、user tool_result -> role:tool、
//       非流式 tool_calls -> tool_use blocks、流式 delta.tool_calls 分片聚合。
// 运行：node .e2e-test/tool-cycle.mjs
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const adapter = require('../dist/services/claude-adapter.js')

let failed = false
function assert(cond, msg) {
  if (!cond) {
    failed = true
    console.error('  FAIL:', msg)
  } else {
    console.log('  ok  :', msg)
  }
}

const modelRow = { upstream_model: 'deepseek-v4', slug: 'deepseek-v4', thinking_enabled: 0 }

// ===== 1) 请求方向：tools + tool_choice + 多轮工具历史 =====
console.log('[case] request: tools / tool_choice / tool_use / tool_result')
{
  const body = {
    model: 'deepseek-v4',
    max_tokens: 1024,
    system: 'You are a coding agent.',
    tools: [
      {
        name: 'Explore',
        description: 'Explore files',
        input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    ],
    tool_choice: { type: 'tool', name: 'Explore' },
    messages: [
      { role: 'user', content: '探索当前目录' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '我先检查目录。' },
          { type: 'tool_use', id: 'call_123', name: 'Explore', input: { path: 'D:\\work' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_123', content: 'src/\npackage.json' }],
      },
    ],
  }
  const payload = adapter.claudeRequestToOpenAi(modelRow, body)
  // tools: input_schema -> parameters
  assert(Array.isArray(payload.tools) && payload.tools.length === 1, 'payload.tools present')
  const tool = payload.tools[0]
  assert(tool.type === 'function', `tools[0].type=function (got ${tool.type})`)
  assert(tool.function.name === 'Explore', `tools[0].function.name (got ${tool.function?.name})`)
  assert(tool.function.parameters?.properties?.path, 'input_schema -> parameters (properties.path kept)')
  // tool_choice
  assert(JSON.stringify(payload.tool_choice) === JSON.stringify({ type: 'function', function: { name: 'Explore' } }), `tool_choice tool mapping (got ${JSON.stringify(payload.tool_choice)})`)
  // system
  assert(payload.messages[0].role === 'system' && payload.messages[0].content === 'You are a coding agent.', 'system mapped')
  // user
  assert(payload.messages[1].role === 'user' && payload.messages[1].content === '探索当前目录', 'user message mapped')
  // assistant 混合内容：text + tool_calls
  const asst = payload.messages[2]
  assert(asst.role === 'assistant', 'assistant role kept')
  assert(asst.content === '我先检查目录。', `assistant text kept (got ${JSON.stringify(asst.content)})`)
  assert(Array.isArray(asst.tool_calls) && asst.tool_calls.length === 1, 'assistant tool_calls present')
  const tc = asst.tool_calls[0]
  assert(tc.id === 'call_123', `tool_calls[0].id kept (got ${tc.id})`)
  assert(tc.type === 'function', `tool_calls[0].type function`)
  assert(tc.function.name === 'Explore', `tool_calls[0].function.name (got ${tc.function?.name})`)
  // input 对象 -> arguments 字符串
  assert(typeof tc.function.arguments === 'string', 'arguments is STRING (serialized from input)')
  const parsedArgs = JSON.parse(tc.function.arguments)
  assert(parsedArgs.path === 'D:\\work', `arguments content roundtrip (got ${tc.function.arguments})`)
  // tool_result -> role=tool + tool_call_id
  const toolMsg = payload.messages[3]
  assert(toolMsg.role === 'tool', `tool_result -> role=tool (got ${toolMsg.role})`)
  assert(toolMsg.tool_call_id === 'call_123', `tool_call_id kept (got ${toolMsg.tool_call_id})`)
  assert(toolMsg.content === 'src/\npackage.json', `tool content kept (got ${JSON.stringify(toolMsg.content)})`)
}

// ===== 1b) tool_choice auto/any/none 映射 =====
console.log('[case] request: tool_choice auto/any/none')
{
  const mk = (tc) => adapter.claudeRequestToOpenAi(modelRow, { model: 'x', max_tokens: 8, tools: [{ name: 'A', input_schema: {} }], tool_choice: tc })
  assert(mk({ type: 'auto' }).tool_choice === 'auto', 'tool_choice auto -> "auto"')
  assert(mk({ type: 'any' }).tool_choice === 'required', 'tool_choice any -> "required"')
  assert(mk({ type: 'none' }).tool_choice === 'none', 'tool_choice none -> "none"')
}

// ===== 1c) is_error 的 tool_result =====
console.log('[case] request: tool_result is_error')
{
  const payload = adapter.claudeRequestToOpenAi(modelRow, {
    model: 'x', max_tokens: 8,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'T', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', is_error: true, content: 'Permission denied' }] },
    ],
  })
  const tm = payload.messages[1]
  assert(tm.role === 'tool' && tm.tool_call_id === 'c1', 'is_error tool_result still role=tool')
  assert(String(tm.content).includes('Permission denied'), `error content kept (got ${tm.content})`)
  assert(String(tm.content).includes('[tool error]'), 'is_error marked')
}

// ===== 2) 非流式响应：tool_calls -> tool_use blocks =====
console.log('[case] response: non-stream tool_calls -> tool_use')
{
  const upstream = {
    id: 'cmpl_1',
    model: 'deepseek-v4',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: '我来查看目录。',
        tool_calls: [
          { id: 'call_abc', type: 'function', function: { name: 'Explore', arguments: '{"path":"D:\\\\work"}' } },
          { id: 'call_def', type: 'function', function: { name: 'Read', arguments: '{"path":"a.py"}' } },
        ],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }
  const resp = adapter.openAiResponseToClaude(upstream)
  assert(resp.stop_reason === 'tool_use', `stop_reason tool_use (got ${resp.stop_reason})`)
  const toolUses = resp.content.filter((b) => b.type === 'tool_use')
  assert(toolUses.length === 2, `two tool_use blocks (got ${toolUses.length})`)
  assert(toolUses[0].id === 'call_abc', `tool_use id kept (got ${toolUses[0].id})`)
  assert(toolUses[0].name === 'Explore', `tool_use name kept (got ${toolUses[0].name})`)
  // arguments 字符串 -> input 对象
  assert(typeof toolUses[0].input === 'object' && toolUses[0].input.path === 'D:\\work', `arguments parsed to input object (got ${JSON.stringify(toolUses[0].input)})`)
  assert(toolUses[1].input.path === 'a.py', 'second tool_use input parsed')
  const textBlock = resp.content.find((b) => b.type === 'text')
  assert(!!textBlock && textBlock.text === '我来查看目录。', 'text block kept alongside tool_use')
}

// ===== 2b) 非流式：arguments 非法 JSON 容错 =====
console.log('[case] response: bad arguments fallback')
{
  const resp = adapter.openAiResponseToClaude({
    id: 'x', model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'c9', type: 'function', function: { name: 'T', arguments: '{broken' } }] }, finish_reason: 'tool_calls' }],
    usage: {},
  })
  const tu = resp.content.find((b) => b.type === 'tool_use')
  assert(!!tu && tu.input && typeof tu.input._raw === 'string', 'bad arguments kept as _raw (no crash)')
}

// ===== 3) 流式：delta.tool_calls 分片聚合 =====
console.log('[case] stream: delta.tool_calls chunked aggregation')
{
  const cs = new adapter.ClaudeContentStream()
  const all = []
  // 分片 1：id+name+arguments 开头
  all.push(...cs.appendToolCallDeltas([{ index: 0, id: 'call_1', type: 'function', function: { name: 'Explore', arguments: '{"pa' } }]))
  // 分片 2：arguments 续（无 id/name）
  all.push(...cs.appendToolCallDeltas([{ index: 0, function: { arguments: 'th":"D:\\\\work"}' } }]))
  // 分片 3：第二个并行工具
  all.push(...cs.appendToolCallDeltas([{ index: 1, id: 'call_2', type: 'function', function: { name: 'Read', arguments: '{"path":"a.py"}' } }]))
  all.push(...cs.close())

  const starts = all.filter((e) => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use')
  assert(starts.length === 2, `two tool_use starts from chunked deltas (got ${starts.length})`)
  assert(starts[0].data.content_block.name === 'Explore', `first tool name (got ${starts[0].data.content_block.name})`)
  assert(starts[0].data.content_block.id === 'call_1', `first tool id kept (got ${starts[0].data.content_block.id})`)
  assert(starts[1].data.content_block.name === 'Read', `second tool name (got ${starts[1].data.content_block.name})`)
  assert(cs.emittedToolUse === true, 'emittedToolUse flagged')
  // input_json_delta 增量按序透传（不提前 json.loads）
  const deltas = all.filter((e) => e.data.delta?.type === 'input_json_delta')
  assert(deltas.length === 3, `three input_json_delta (got ${deltas.length})`)
  // stop 事件收尾
  const stops = all.filter((e) => e.event === 'content_block_stop' && starts.some((s) => s.data.index === e.data.index))
  assert(stops.length === 2, `tool blocks stopped on close (got ${stops.length})`)
}

// ===== 4) openAiStreamChunkToClaude 端到端：文本 + 工具分片 =====
console.log('[case] stream: chunk pipeline text+tools')
{
  const cs = new adapter.ClaudeContentStream()
  const all = []
  const chunk1 = { choices: [{ index: 0, delta: { role: 'assistant', content: '我先查一下。' } }] }
  const chunk2 = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] } }] }
  const chunk3 = { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 4 } }
  for (const c of [chunk1, chunk2, chunk3]) {
    all.push(...adapter.openAiStreamChunkToClaude(c, { input_tokens: 3, output_tokens: 4 }, cs).events)
  }
  const kinds = all.map((e) => `${e.event}:${e.data?.content_block?.type ?? e.data?.delta?.type ?? e.data?.type}`)
  assert(kinds.some((k) => k === 'content_block_start:text'), `text block start (got ${kinds.join(',')})`)
  assert(kinds.some((k) => k === 'content_block_start:tool_use'), 'tool_use block start')
  assert(kinds.some((k) => k === 'content_block_delta:input_json_delta'), 'input_json_delta present')
  const md = all.find((e) => e.event === 'message_delta')
  assert(md?.data?.delta?.stop_reason === 'tool_use', `stop_reason tool_use (got ${md?.data?.delta?.stop_reason})`)
  assert(md?.data?.usage?.output_tokens === 4, `usage output_tokens (got ${md?.data?.usage?.output_tokens})`)
}

// ===== 5) 多轮完整循环：response 的 tool_use 再转回 request 的 tool_calls =====
console.log('[case] roundtrip: response tool_use -> next request tool_calls')
{
  const resp = adapter.openAiResponseToClaude({
    id: 'c1', model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_77', type: 'function', function: { name: 'Explore', arguments: '{"path":"E:/app"}' } }] }, finish_reason: 'tool_calls' }],
    usage: {},
  })
  // 客户端把 assistant content 原样放回 + tool_result
  const nextReq = adapter.claudeRequestToOpenAi(modelRow, {
    model: 'm', max_tokens: 100,
    messages: [
      { role: 'user', content: '探索' },
      { role: 'assistant', content: resp.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_77', content: 'files...' }] },
    ],
  })
  const asst = nextReq.messages[1]
  assert(asst.role === 'assistant' && Array.isArray(asst.tool_calls) && asst.tool_calls[0].id === 'call_77', `id stable across roundtrip (got ${JSON.stringify(asst.tool_calls?.[0]?.id)})`)
  assert(asst.tool_calls[0].function.name === 'Explore', 'name stable across roundtrip')
  assert(JSON.parse(asst.tool_calls[0].function.arguments).path === 'E:/app', 'input<->arguments stable across roundtrip')
  const tm = nextReq.messages[2]
  assert(tm.role === 'tool' && tm.tool_call_id === 'call_77', `tool_call_id matches on result turn (got ${tm.tool_call_id})`)
}

// ===== 7) DeepSeek 官方 thinking 特判（400 根因） =====
console.log('[case] thinking: DeepSeek official vs generic upstream')
{
  const ds = { ...modelRow, upstream_base_url: 'https://api.deepseek.com', thinking_enabled: 1 }
  const gen = { ...modelRow, upstream_base_url: 'https://vllm.internal:8000/v1', thinking_enabled: 1 }
  const body = { model: 'x', max_tokens: 64, thinking: { type: 'enabled', budget_tokens: 1024 } }
  const pkDs = adapter.claudeRequestToOpenAi(ds, body)
  const pkGen = adapter.claudeRequestToOpenAi(gen, body)
  // DeepSeek 官方：塞顶层 thinking 对象，不再塞 chat_template_kwargs
  assert(pkDs.thinking?.type === 'enabled', `deepseek uses top-level thinking object (got ${JSON.stringify(pkDs.thinking)})`)
  assert(pkDs.chat_template_kwargs === undefined, `deepseek does NOT send chat_template_kwargs`)
  assert(pkDs.max_tokens >= 1024, `deepseek max_tokens boosted (got ${pkDs.max_tokens})`)
  // 通用上游：保留 chat_template_kwargs（vLLM 兼容）
  assert(pkGen.chat_template_kwargs?.enable_thinking === true, `generic uses chat_template_kwargs`)
  assert(pkGen.thinking === undefined, `generic does NOT send thinking object`)
}

// ===== 8) 非流式 reasoning_content -> thinking block =====
console.log('[case] response: reasoning_content -> thinking block')
{
  const resp = adapter.openAiResponseToClaude({
    id: 'x', model: 'deepseek-v4-flash',
    choices: [{ index: 0, message: { role: 'assistant', reasoning_content: 'user wants file listing', content: '我来查看目录。' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 5 },
  })
  const thinking = resp.content[0]
  assert(thinking.type === 'thinking' && thinking.thinking === 'user wants file listing', `thinking block first (got ${JSON.stringify(thinking)})`)
  const text = resp.content[1]
  assert(text.type === 'text' && text.text === '我来查看目录。', `text after thinking (got ${JSON.stringify(text)})`)
}

// ===== 9) 流式 thinking 生命周期 =====
console.log('[case] stream: reasoning_content -> thinking events')
{
  const cs = new adapter.ClaudeContentStream()
  const all = []
  // 思考增量先行
  all.push(...cs.appendThinking('I need to explore the '))
  all.push(...cs.appendThinking('directory.'))
  // 正文到达：应自动关闭 thinking 块再开文本
  all.push(...cs.appendText('我先看看目录。'))
  all.push(...cs.close())
  const thinkingStart = all.find((e) => e.event === 'content_block_start' && e.data.content_block?.type === 'thinking')
  assert(!!thinkingStart, `thinking content_block_start present`)
  const thinkingDeltas = all.filter((e) => e.data.delta?.type === 'thinking_delta')
  assert(thinkingDeltas.length === 2, `two thinking_delta (got ${thinkingDeltas.length})`)
  const thinkingStop = all.find((e) => e.event === 'content_block_stop' && startsWith(all, e, thinkingStart))
  assert(!!thinkingStop && thinkingStop.data.index === thinkingStart.data.index, 'thinking block stopped')
  // 思考块先于文本块（index 顺序）
  const textStartIdx = all.findIndex((e) => e.event === 'content_block_start' && e.data.content_block?.type === 'text')
  const thinkStartIdx = all.findIndex((e) => e.event === 'content_block_start' && e.data.content_block?.type === 'thinking')
  assert(thinkStartIdx >= 0 && thinkStartIdx < textStartIdx, `thinking before text (think=${thinkStartIdx},text=${textStartIdx})`)
}

// ===== 10) insufficient_system_resource -> end_turn =====
console.log('[case] response: insufficient_system_resource -> end_turn')
{
  const cs = new adapter.ClaudeContentStream()
  const { events } = adapter.openAiStreamChunkToClaude(
    { choices: [{ index: 0, delta: {}, finish_reason: 'insufficient_system_resource' }] },
    undefined,
    cs,
  )
  const md = events.find((e) => e.event === 'message_delta')
  assert(md?.data?.delta?.stop_reason === 'end_turn', `insufficient_system_resource -> end_turn (got ${md?.data?.delta?.stop_reason})`)
}

function startsWith(arr, e, start) {
  const i = arr.indexOf(e)
  const si = arr.indexOf(start)
  return si >= 0 && i > si
}

// ===== 11) 多轮往返：thinking <-> reasoning_content 闭环稳定 =====
console.log('[case] roundtrip: thinking <-> reasoning_content stability')
{
  // 第一轮：DeepSeek 返回 reasoning_content -> Anthropic thinking block
  const resp = adapter.openAiResponseToClaude({
    id: 'r1', model: 'deepseek-v4-flash',
    choices: [{ index: 0, message: { role: 'assistant', reasoning_content: '我需要探索目录', content: '我先看看。' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 6 },
  })
  const thinkingBlock = (resp.content || []).find((b) => b.type === 'thinking')
  assert(!!thinkingBlock && thinkingBlock.thinking === '我需要探索目录', `resp thinking block (got ${JSON.stringify(thinkingBlock)})`)
  assert(resp.content[1].type === 'text' && resp.content[1].text === '我先看看。', 'text after thinking')

  // 第二轮：Claude Code 回传 assistant content（含 thinking 块）-> 重建 reasoning_content
  const nextReq = adapter.claudeRequestToOpenAi(modelRow, {
    model: 'deepseek-v4-flash', max_tokens: 100,
    messages: [
      { role: 'user', content: '探索目录' },
      { role: 'assistant', content: resp.content },
    ],
  })
  const asst = nextReq.messages[1]
  assert(asst.reasoning_content === '我需要探索目录', `reasoning_content reconstructed (got ${JSON.stringify(asst.reasoning_content)})`)
  assert(asst.content === '我先看看。', `content kept separate (got ${JSON.stringify(asst.content)})`)
  // 关键：content 绝不能等于 reasoning_content
  assert(asst.content !== asst.reasoning_content, 'content != reasoning_content')
}

// ===== 12) assistant 顶层带 reasoning_content（字符串 content + 顶层字段）兼容 =====
console.log('[case] request: string content + top-level reasoning_content')
{
  const payload = adapter.claudeRequestToOpenAi(modelRow, {
    model: 'x', max_tokens: 64,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '我来看看。', reasoning_content: 'internal', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'T', arguments: '{}' } }] },
    ],
  })
  const asst = payload.messages[1]
  assert(asst.reasoning_content === 'internal', `top-level reasoning_content kept (got ${asst.reasoning_content})`)
  assert(asst.content === '我来看看。', 'string content kept')
  assert(Array.isArray(asst.tool_calls) && asst.tool_calls.length === 1, `tool_calls kept (got ${JSON.stringify(asst.tool_calls)})`)
}

// ===== 13) thinking + tool_use 混合（思考内容 -> reasoning_content，文本与工具不串） =====
console.log('[case] request: thinking + text + tool_use mixed block')
{
  const payload = adapter.claudeRequestToOpenAi(modelRow, {
    model: 'x', max_tokens: 64,
    messages: [
      { role: 'user', content: '探索' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '用户要探索目录，调用 Explore' },
          { type: 'text', text: '我先检查目录。' },
          { type: 'tool_use', id: 'call_mix', name: 'Explore', input: { path: 'D:\\work' } },
        ],
      },
    ],
  })
  const asst = payload.messages[1]
  assert(asst.reasoning_content === '用户要探索目录，调用 Explore', `thinking -> reasoning_content (got ${asst.reasoning_content})`)
  assert(asst.content === '我先检查目录。', `text -> content (got ${asst.content})`)
  assert(Array.isArray(asst.tool_calls) && asst.tool_calls[0].id === 'call_mix', `tool_calls present (got ${JSON.stringify(asst.tool_calls)})`)
  assert(asst.tool_calls[0].function.name === 'Explore', 'tool name kept')
  assert(JSON.parse(asst.tool_calls[0].function.arguments).path === 'D:\\work', 'arguments roundtrip')
}

// ===== 14) 多轮 Tool 循环：Claude 剥离 thinking 回传 -> 缓存补挂 reasoning_content =====
console.log('[case] multi-turn: Claude strips thinking, cache re-attaches reasoning_content')
{
  const slug = 'deepseek-v4-flash'
  const dsModel = { ...modelRow, slug, upstream_model: slug }
  // 第一轮：DeepSeek 非流式返回 reasoning_content + tool_calls
  // -> openAiResponseToClaude 写入缓存（rememberReasoning）
  const resp1 = adapter.openAiResponseToClaude({
    id: 'r1', model: slug,
    choices: [{ index: 0, message: { role: 'assistant', reasoning_content: '我需要探索目录', content: '我先查看目录。', tool_calls: [{ id: 'call_r9', type: 'function', function: { name: 'Explore', arguments: '{"path":"D:\\\\work"}' } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 4, completion_tokens: 6 },
  })
  const tu = (resp1.content || []).find((b) => b.type === 'tool_use')
  assert(!!tu && tu.id === 'call_r9', `response1 tool_use id (got ${tu?.id})`)
  assert((resp1.content || []).some((b) => b.type === 'thinking'), 'response1 has thinking block (from reasoning_content)')

  // 关键模拟：Claude Code 回传下一轮时【剥离 thinking】——
  // assistant content 数组只剩 text + tool_use（无 thinking）。但 tool_use.id 保持 call_r9。
  const stripped = {
    role: 'assistant',
    content: (resp1.content || []).filter((b) => b.type !== 'thinking').map((b) => ({ ...b })),
  }

  const nextReq = adapter.claudeRequestToOpenAi(dsModel, {
    model: slug, max_tokens: 100,
    messages: [
      { role: 'user', content: '探索目录' },
      stripped,
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_r9', content: 'src/' }] },
    ],
  })
  const asstStripped = nextReq.messages[1]
  // 无 thinking 块也无顶层 reasoning_content，但带 tool_calls —— 应通过缓存补挂
  assert(asstStripped.tool_calls?.[0]?.id === 'call_r9', `stripped assistant tool_calls kept (got ${asstStripped.tool_calls?.[0]?.id})`)
  assert(asstStripped.reasoning_content === '我需要探索目录', `stripped assistant re-attached reasoning_content via cache (got ${JSON.stringify(asstStripped.reasoning_content)})`)
  assert(asstStripped.content === '我先查看目录。', `stripped assistant content kept separate (got ${JSON.stringify(asstStripped.content)})`)
  assert(asstStripped.content !== asstStripped.reasoning_content, 'stripped content != reasoning_content')
}

console.log(failed ? '\nFAILED' : '\nALL TOOL-CYCLE TESTS PASSED')
process.exit(failed ? 1 : 0)
