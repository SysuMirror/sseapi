// 回归验证：「有 thinking 无内容」相关修复。
// 运行：node .e2e-test/stream-close-regression.mjs
import {
  ClaudeContentStream,
  claudeStreamStartEvents,
  claudeStreamEndEvents,
  openAiStreamChunkToClaude,
} from '../dist/services/claude-adapter.js'

let failed = false
function assert(cond, msg) {
  if (!cond) {
    failed = true
    console.error('  FAIL:', msg)
  } else {
    console.log('  ok  :', msg)
  }
}

const textOf = (events) =>
  events
    .filter((e) => e.event === 'content_block_delta' && e.data?.delta?.type === 'text_delta')
    .map((e) => e.data.delta.text)
    .join('')

// 1) 未闭合的 antArtifact：缓冲里的正文不能丢
{
  console.log('[case] 未闭合 antArtifact 收尾保留正文')
  const ms = new ClaudeContentStream()
  const events = []
  events.push(...ms.appendText('这是正文开头。'))
  events.push(...ms.appendText('<antArtifact identifier="x" type="text/html" title="t">'))
  events.push(...ms.appendText('<b>未闭合的内容</b>'))
  events.push(...ms.close())
  const text = textOf(events)
  assert(text.includes('这是正文开头。'), '开头的正文被输出')
  assert(text.includes('未闭合的内容'), '未闭合 artifact 内部文本被输出（旧实现在此丢弃）')
  assert(events.some((e) => e.event === 'message_stop' === false), 'close() 不产出 message_stop（由结束事件负责）')
}

// 2) 未闭合的 DSML 工具调用：半截 JSON 不应作为正文吐出
{
  console.log('[case] 未闭合 DSML 调用不泄漏半截 JSON')
  const ms = new ClaudeContentStream()
  const events = []
  events.push(...ms.appendText('正文。'))
  events.push(...ms.appendText('<|DSML|tool_calls><|DSML|invoke name="foo">'))
  events.push(...ms.appendText('{"a":'))
  events.push(...ms.close())
  const text = textOf(events)
  assert(text.includes('正文。'), '正文被输出')
  assert(!text.includes('{"a":'), '半截 JSON 未被当成正文')
}

// 3) 上游不给 finish_reason：仍要补出 message_delta + message_stop
{
  console.log('[case] 无 finish_reason 时补收尾事件')
  const ms = new ClaudeContentStream()
  const events = []
  events.push(...claudeStreamStartEvents('m', 10, true))
  events.push(...openAiStreamChunkToClaude({ choices: [{ delta: { reasoning_content: '思考中' } }] }, {}, ms).events)
  events.push(...openAiStreamChunkToClaude({ choices: [{ delta: { content: '答案正文' } }] }, {}, ms).events)
  // 模拟 proxy finally 分支
  events.push(...claudeStreamEndEvents(ms, { input_tokens: 10 }))
  const names = events.map((e) => e.event)
  assert(names.filter((n) => n === 'message_stop').length === 1, '恰好一个 message_stop')
  assert(names.filter((n) => n === 'message_delta').length === 1, '恰好一个 message_delta')
  assert(names.includes('content_block_stop'), 'ContentBlock 已关闭')
  assert(textOf(events).includes('答案正文'), '正文照常输出')
  const order = names.indexOf('content_block_stop') < names.indexOf('message_delta')
  assert(order, 'content_block_stop 在 message_delta 之前')
}

// 4) close() 幂等：finish_reason 与 finally 两条路径都调用也不会重复收尾
{
  console.log('[case] close() 幂等')
  const ms = new ClaudeContentStream()
  const events = []
  events.push(...openAiStreamChunkToClaude({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }, {}, ms).events)
  const second = ms.close()
  assert(second.length === 0, '第二次 close() 不再产出事件')
  assert(events.filter((e) => e.event === 'content_block_stop').length === 1, 'content_block_stop 只出现一次')
}

// 5) 思考→正文：thinking 块必须先关闭再开正文块
{
  console.log('[case] thinking 在前、正文在后')
  const ms = new ClaudeContentStream()
  const a = openAiStreamChunkToClaude({ choices: [{ delta: { reasoning_content: 'th' } }] }, {}, ms)
  const b = openAiStreamChunkToClaude({ choices: [{ delta: { content: 'text' } }] }, {}, ms)
  const ev = [...a.events, ...b.events]
  const idxThinkStop = ev.findIndex((e) => e.event === 'content_block_stop' && e.data.index === 0)
  const idxTextStart = ev.findIndex((e) => e.event === 'content_block_start' && e.data.content_block.type === 'text')
  assert(idxTextStart > idxThinkStop, '正文块在 thinking 块关闭之后才开')
}

console.log(failed ? '\n有失败用例' : '\n全部通过')
process.exit(failed ? 1 : 0)
