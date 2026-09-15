// 专项单测：ClaudeContentStream 把 DSML / antArtifact 文本增量转换为结构化
// content_block 事件。不依赖上游，直接 import 编译后的 adapter。
// 运行：node .e2e-test/stream-marker.mjs
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { ClaudeContentStream, ClaudePassthroughSse, openAiContentToClaudeBlocks } = require('../dist/services/claude-adapter.js')

let failed = false
function assert(cond, msg) {
  if (!cond) {
    failed = true
    console.error('  FAIL:', msg)
  } else {
    console.log('  ok  :', msg)
  }
}

function run(name, chunks, expect) {
  console.log(`[case] ${name}`)
  const ms = new ClaudeContentStream()
  const events = []
  for (const c of chunks) events.push(...ms.appendText(c))
  events.push(...ms.close())
  const kinds = events.map((e) => `${e.event}:${String((e.data?.type ?? ''))}`)
  console.log('  events:', JSON.stringify(events.map((e) => e.event)))
  for (const exp of expect) assert(kinds.includes(exp), `contains ${exp}`)
  return events
}

// 1) 纯文本：应产出 text content_block
{
  const ev = run('纯文本', ['Hel', 'lo 世界'], [
    'content_block_start:content_block_start',
    'content_block_delta:content_block_delta',
    'content_block_stop:content_block_stop',
  ])
  const textBlock = ev.find((e) => e.event === 'content_block_start')
  assert(textBlock.data.content_block.type === 'text', 'text block type=text')
}

// 2) DSML 完整块：应产出 tool_use（start + input_json_delta + stop）
{
  const dsml = '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="Bash">\n<｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>'
  const ev = run('DSML tool_use', ['先搜索目录，', dsml], [
    'content_block_start:content_block_start',
    'content_block_delta:content_block_delta',
    'content_block_stop:content_block_stop',
  ])
  const toolStart = ev.find((e) => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use')
  assert(!!toolStart, 'tool_use start exists')
  if (toolStart) {
    assert(toolStart.data.content_block.name === 'Bash', `tool name Bash (got ${toolStart.data.content_block.name})`)
    assert(toolStart.data.content_block.input?.command === 'ls', `input command (got ${JSON.stringify(toolStart.data.content_block.input)})`)
  }
  const inputDelta = ev.find((e) => e.data.delta?.type === 'input_json_delta')
  assert(!!inputDelta, 'input_json_delta exists')
  const rawEvent = eventsOf(ev)
  // tool_use 不收文本进 text 块，DSML 标签不应以 text_delta 出现
  const textDeltas = ev.filter((e) => e.event === 'content_block_delta' && e.data.delta?.type === 'text_delta')
  assert(textDeltas.every((d) => !String(d.data.delta.text).includes('｜DSML｜')), 'DSML tags not leaked as text')
  void rawEvent
}

// 3) antArtifact 完整块
{
  const art = '<antArtifact identifier="demo" type="application/vnd.ant.code" title="Demo">\nconsole.log(1)\n</antArtifact>'
  const ev = run('antArtifact', ['生成代码：', art], [
    'content_block_start:content_block_start',
    'content_block_delta:content_block_delta',
    'content_block_stop:content_block_stop',
  ])
  const artStart = ev.find((e) => e.event === 'content_block_start' && e.data.content_block?.type === 'artifact')
  assert(!!artStart, 'artifact start exists')
  if (artStart) {
    assert(artStart.data.content_block.identifier === 'demo', `identifier demo (got ${artStart.data.content_block.identifier})`)
    assert(artStart.data.content_block.content_type === 'application/vnd.ant.code', `content_type (got ${artStart.data.content_block.content_type})`)
  }
  const textDeltas = ev.filter((e) => e.event === 'content_block_delta' && e.data.delta?.type === 'text_delta')
  assert(textDeltas.some((d) => String(d.data.delta.text).includes('console.log(1)')), 'artifact code emitted as delta')
}

// 4) 跨 chunk 拆分：DSML 结束标记被拆到两步
{
  const c1 = '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="Read">'
  const c2 = '\n<｜DSML｜parameter name="file_path" string="true">a.txt</｜DSML｜parameter>\n</｜DSML｜invoke>'
  const c3 = '\n</｜DSML｜tool_calls>'
  const ev = run('DSML split chunks', [c1, c2, c3], [
    'content_block_start:content_block_start',
    'content_block_stop:content_block_stop',
  ])
  const toolStart = ev.find((e) => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use')
  assert(!!toolStart, 'split tool_use start exists')
  if (toolStart) {
    assert(toolStart.data.content_block.name === 'Read', `tool name Read (got ${toolStart.data.content_block.name})`)
    assert(toolStart.data.content_block.input?.file_path === 'a.txt', `input file_path (got ${JSON.stringify(toolStart.data.content_block.input)})`)
  }
}

// 5) 流式结束后 show_stop
{
  const ev = run('结束时 close', ['hello'], ['content_block_stop:content_block_stop'])
}

// 6) DSML 无结束标记（截断）：不应把残留当作 text 输出
{
  const ev = run('截断 DSML', ['<｜DSML｜tool_calls>\n<｜DSML｜invoke name="Run">'], [])
  const textDeltas = ev.filter((e) => e.event === 'content_block_delta' && e.data.delta?.type === 'text_delta')
  assert(textDeltas.length === 0, 'truncated DSML not emitted as text')
}

function eventsOf(ev) { return ev }

// 7) 非流式 openAiContentToClaudeBlocks：拆 DSML + artifact
{
  console.log('[case] 非流式 content -> blocks')
  const content = '先看这个代码：' +
    '<antArtifact identifier="svg" type="image/svg+xml" title="Blue">\n<svg></svg>\n</antArtifact>' +
    '再来调用工具：' +
    '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="Write">\n<｜DSML｜parameter name="file_path" string="true">b.py</｜DSML｜parameter>\n<｜DSML｜parameter name="content" string="true">print(1)</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>'
  const blocks = openAiContentToClaudeBlocks(content)
  const types = blocks.map((b) => b.type)
  console.log('  types:', JSON.stringify(types))
  assert(types.includes('text'), 'has text block')
  assert(types.includes('artifact'), 'has artifact block')
  assert(types.includes('tool_use'), 'has tool_use block')
  const art = blocks.find((b) => b.type === 'artifact')
  if (art) assert(art.identifier === 'svg', `artifact svg (got ${art.identifier})`)
  const tool = blocks.find((b) => b.type === 'tool_use')
  if (tool) {
    assert(tool.name === 'Write', `tool Write (got ${tool.name})`)
    assert(tool.input?.file_path === 'b.py', `input file_path ${JSON.stringify(tool.input)}`)
  }
}

// 8) 半角竖线变体：流式 DSML 用 |DSML| 也应转成 tool_use
{
  console.log('[case] 半角 | 流式 DSML')
  const ms = new ClaudeContentStream()
  const dsmlHalf = '<|DSML|tool_calls>\n<|DSML|invoke name="Bash">\n<|DSML|parameter name="command" string="true">ls</|DSML|parameter>\n</|DSML|invoke>\n</|DSML|tool_calls>'
  const events = [...ms.appendText('执行：'), ...ms.appendText(dsmlHalf), ...ms.close()]
  const toolStart = events.find((e) => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use')
  assert(!!toolStart, 'half-width tool_use start exists')
  if (toolStart) {
    assert(toolStart.data.content_block.name === 'Bash', `half tool name (got ${toolStart.data.content_block.name})`)
    assert(toolStart.data.content_block.input?.command === 'ls', `half input command (got ${JSON.stringify(toolStart.data.content_block.input)})`)
  }
  const leak = events.some((e) => e.event === 'content_block_delta' && e.data.delta?.type === 'text_delta' && String(e.data.delta.text).includes('DSML'))
  assert(!leak, 'half-width DSML not leaked as text')
}

// 9) 半角竖线变体：非流式 blocks
{
  console.log('[case] 半角 | 非流式')
  const content = '<|DSML|tool_calls>\n<|DSML|invoke name="Read">\n<|DSML|parameter name="file_path" string="true">c.txt</|DSML|parameter>\n</|DSML|invoke>\n</|DSML|tool_calls>'
  const blocks = openAiContentToClaudeBlocks(content)
  const tool = blocks.find((b) => b.type === 'tool_use')
  assert(!!tool, 'half non-stream tool_use exists')
  if (tool) {
    assert(tool.name === 'Read', `half tool name Read (got ${tool.name})`)
    assert(tool.input?.file_path === 'c.txt', `half input file_path ${JSON.stringify(tool.input)}`)
  }
}

// 10) ClaudePassthroughSse：透传路径上把 <antartifact> 文本标签重建为 artifact 块
{
  console.log('[case] passthrough: antArtifact 标签重建')
  const t = new ClaudePassthroughSse()
  const evs = []
  evs.push(...t.pushEvent('message_start', { type: 'message_start', message: { id: 'm1', role: 'assistant', content: [], usage: {} } }))
  evs.push(...t.pushEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  evs.push(...t.pushEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '结果：' } }))
  evs.push(...t.pushEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '<antArtifact identifier="x" type="application/vnd.ant.code" title="Demo">\nconsole.log(1)\n</antArtifact>' } }))
  evs.push(...t.pushEvent('content_block_stop', { type: 'content_block_stop', index: 0 }))
  evs.push(...t.pushEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }))
  evs.push(...t.pushEvent('message_stop', { type: 'message_stop' }))
  evs.push(...t.finish())
  const artStart = evs.find((e) => e.event === 'content_block_start' && e.data.content_block?.type === 'artifact')
  assert(!!artStart, 'passthrough artifact start exists')
  if (artStart) assert(artStart.data.content_block.identifier === 'x', `passthrough identifier x (got ${artStart.data.content_block.identifier})`)
  const leak = evs.some((e) => e.event === 'content_block_delta' && e.data.delta?.type === 'text_delta' && String(e.data.delta.text).includes('antArtifact'))
  assert(!leak, 'passthrough antArtifact not leaked as text')
}

// 11) ClaudePassthroughSse：透传 DSML 标签 -> tool_use 块
{
  console.log('[case] passthrough: DSML 标签重建')
  const t = new ClaudePassthroughSse()
  const evs = []
  evs.push(...t.pushEvent('message_start', { type: 'message_start', message: { id: 'm2', role: 'assistant', content: [], usage: {} } }))
  evs.push(...t.pushEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  evs.push(...t.pushEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '<|DSML|tool_calls>\n<|DSML|invoke name="Bash">\n<|DSML|parameter name="command" string="true">ls</|DSML|parameter>\n</|DSML|invoke>\n</|DSML|tool_calls>' } }))
  evs.push(...t.pushEvent('content_block_stop', { type: 'content_block_stop', index: 0 }))
  evs.push(...t.pushEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }))
  evs.push(...t.pushEvent('message_stop', { type: 'message_stop' }))
  evs.push(...t.finish())
  const toolStart = evs.find((e) => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use')
  assert(!!toolStart, 'passthrough DSML tool_use start exists')
  if (toolStart) {
    assert(toolStart.data.content_block.name === 'Bash', `passthrough tool name (got ${toolStart.data.content_block.name})`)
    assert(toolStart.data.content_block.input?.command === 'ls', `passthrough input (got ${JSON.stringify(toolStart.data.content_block.input)})`)
  }
  const md = evs.find((e) => e.event === 'message_delta')
  assert(md?.data?.delta?.stop_reason === 'tool_use', `passthrough stop_reason tool_use (got ${md?.data?.delta?.stop_reason})`)
}

// 12) ClaudePassthroughSse：标准结构化 tool_use 上游应原样透传（不破坏）
{
  console.log('[case] passthrough: 原生 tool_use 透传')
  const t = new ClaudePassthroughSse()
  const evs = []
  evs.push(...t.pushEvent('message_start', { type: 'message_start', message: { id: 'm3', role: 'assistant', content: [], usage: {} } }))
  evs.push(...t.pushEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'Read', input: {} } }))
  evs.push(...t.pushEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"a.txt"}' } }))
  evs.push(...t.pushEvent('content_block_stop', { type: 'content_block_stop', index: 0 }))
  evs.push(...t.pushEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }))
  evs.push(...t.pushEvent('message_stop', { type: 'message_stop' }))
  evs.push(...t.finish())
  const toolStart = evs.find((e) => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use')
  assert(!!toolStart, 'native tool_use start passthrough')
  const inputDelta = evs.find((e) => e.data.delta?.type === 'input_json_delta')
  assert(!!inputDelta, 'native input_json_delta passthrough')
}

console.log(failed ? '\nFAILED' : '\nALL STREAM-MARKER TESTS PASSED')
process.exit(failed ? 1 : 0)
