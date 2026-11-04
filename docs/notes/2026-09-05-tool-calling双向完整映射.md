# 2026-09-05 Tool Calling 协议双向完整映射（Claude Messages <-> OpenAI Chat）

## 背景

用户反馈 Claude Code 通过平台接入 DeepSeek（`/v1/messages` 中继路径）时，普通对话正常但工具调用「done 但没真正执行」。根因：协议转换器只做了 Chat 消息转换，**Tool Calling 整套数据结构没有双向映射**：

- `ClaudeMessagesRequest` 缺 `tools` / `tool_choice` → 客户端工具定义被丢弃
- `ClaudeContentBlock` 缺 `tool_use` / `tool_result` → 多轮工具历史被剥掉
- 响应侧 `tool_calls` 被忽略 → 客户端拿不到规范 `tool_use` 块，工具执行链断裂

## 改动（全部在 `server/src/services/claude-adapter.ts`）

### 类型扩展

- `ClaudeToolUseBlock` / `ClaudeToolResultBlock` / `ClaudeToolDefinition`
- `ClaudeContentBlock` += `tool_use` / `tool_result`
- `ClaudeMessagesRequest` += `tools` / `tool_choice`

### 请求方向（Claude -> OpenAI，`claudeRequestToOpenAi`）

- `tools[].input_schema` -> `tools[].function.parameters`，外包 `{type:'function', function:{...}}`
- `tool_choice`：`auto`->`"auto"`、`any`->`"required"`、`none`->`"none"`、`{type:'tool',name}`->`{type:'function',function:{name}}`
- assistant 混合内容（text + tool_use）：text 合并为 `content`，每个 `tool_use` -> `tool_calls[]`，`input` 对象 `JSON.stringify` 成 `arguments` 字符串
- user 消息里的 `tool_result` -> 独立 `{role:'tool', tool_call_id, content}`（`tool_use_id` -> `tool_call_id`，ID 保持不变）；`is_error` 前缀 `[tool error]`；同一 user content 中普通 text/image parts 先落为 user 消息
- `role=tool` 绝不转成普通 user 消息

### 响应方向（OpenAI -> Claude，`openAiResponseToClaude`）

- 每个 `tool_calls[]` -> `{type:'tool_use', id, name, input}`；`arguments` 字符串 `JSON.parse` 成 `input` 对象；非法 JSON 容错为 `{_raw}` 不崩溃
- 多工具并行：遍历全部 `tool_calls`，不取 `[0]`
- `finish_reason=tool_calls` -> `stop_reason=tool_use`；文本与 tool_use 混合时 content 顺序保留

### 流式（OpenAI SSE -> Anthropic SSE）

- `ClaudeContentStream.appendToolCallDeltas()`：OpenAI `delta.tool_calls` 分片聚合。首片（带 id/name）发 `content_block_start`（tool_use），后续 `arguments` 增量**原样**作为 `input_json_delta.partial_json` 转发（不提前 json.loads），`close()` 时补 `content_block_stop`
- `openAiStreamChunkToClaude` 检测 `delta.tool_calls` 调用上述方法；`emittedToolUse` 置位后 `message_delta.stop_reason=tool_use`
- 与既有 DSML/antArtifact 文本转换共存：标准 `tool_calls` 走分片聚合，文本里的 DSML 标签走标记状态机

### ID 稳定性

`tool_calls[].id` <-> `tool_use.id` <-> `tool_call_id` 全链路原样透传，不重生成。单测验证了 response -> 下一轮 request 往返 ID/名称/参数均稳定。

## 测试

- 新增 `server/.e2e-test/tool-cycle.mjs`（47 项断言）：请求方向（tools/tool_choice/多轮历史/is_error）、非流式响应（含坏 JSON 容错）、流式分片聚合（含并行多工具）、完整往返
- `run-protocol.mjs` 新增 e2e 用例 #16/#17：mock 上游返回标准 `tool_calls`（流式分片/非流式），验证 `/v1/messages` 端到端输出规范 `tool_use` 事件、第二轮 `tool_result` 转成 `role=tool` 且 `tool_call_id` 稳定
- 三套测试全绿：run-protocol / tool-cycle / stream-marker

## 踩坑记录

- e2e mock 重构时流式分支重复 `writeHead` 导致 `ERR_HTTP_HEADERS_SENT`，通过给 mock 加请求序号日志定位（同一请求只处理一次，是 handler 内部双 writeHead）
- mjs 文件手写长 JSON 行括号错位两处（`SyntaxError: Unexpected token ':'`）

## 未决事项

- Responses 协议方向 `tools` 目前是透传（Responses API function tools 与 Chat 格式接近），未做深度规范化
- 透传路径（`anthropic_base_url`）中上游已是标准 Anthropic 协议，无需工具映射；`ClaudePassthroughSse` 仅处理 DSML/antArtifact 文本兜底

---

## 追加修复：上游错误被包装成「400 + SSE」（Claude Code 报 `API Error: 400 event: message_start` 的根因）

### 现象

Claude Code 报 `API Error: 400 event: message_start data: {...}`——HTTP 400 状态码里裹着合法的 Anthropic SSE 正文，错误信息看不出上游真实原因。此前「Cooked for 7s 静默断流」现象同源。

### 根因（proxy.ts 三处同模式）

`res.status(upstreamRes.status)` 无条件透传上游状态码，但**无论状态码是否 200 都继续输出 SSE 流**。上游 400 时：客户端收到 `HTTP 400` + `message_start` SSE（`input_tokens:4000` 是本地 `estimateClaudeTokens` 估算值，佐证出自中继路径），真实上游错误 JSON 被吞。

### 修复

- 三处流式分支（Anthropic 透传 / Chat 中继 / Responses 透传）：上游非 200 时不再进 SSE——客户端要流则返回 `HTTP 200 + event: error`（Anthropic 流式错误的标准承载），否则保留状态码返回规范化 JSON
- 新增 `upstreamErrorToClaude(status, bodyText)`：上游 OpenAI 形状错误 / 纯文本 / HTML 统一收敛为 Anthropic `{type:'error', error:{type,message}}`，type 按 401/403/404/429/5xx 映射
- 中继非流式错误同样规范化（原来直接透传 OpenAI 形状 json）
- `message_start` 补 `stop_sequence: null` 字段

### 验证

e2e 新增用例 #18：mock 上游 400 → 流式断言 `HTTP 200 + error 事件 + 无 message_start 包装`；非流式断言 `保留 400 + Anthropic 错误形状`。全量测试通过。

---

## 追加修复：DeepSeek 官方 400 根因（thinking 参数不兼容）

### 现象

用户贴 DeepSeek 官方 Chat Completions 文档，指出上游 400 的真正嫌疑：DeepSeek 官方 API **严格校验参数**，只认顶层 `thinking:{type, reasoning_effort}`，而此前代码发的是 vLLM 私有参数 `chat_template_kwargs:{enable_thinking}` —— **不在官方清单里，DeepSeek 直接 400 Unrecognized argument**。

### 根因（claude-adapter.ts + admin.ts）

- `claudeRequestToOpenAi`：`body.thinking.type==='enabled'` 时，只要 `model.thinking_enabled` 就无脑塞 `chat_template_kwargs` → 对 DeepSeek 官方 400
- `admin.ts` 连通性探测：chat probe 恒发 `chat_template_kwargs:{enable_thinking:false}` → 对 DeepSeek 官方必 400，误报「上游不支持」

### 修复

1. **新增 `isDeepSeekOfficialUpstream(baseUrl)`**：host 为 `*.deepseek.com` 判定为官方 API
2. **thinking 按上游分派**（`claudeRequestToOpenAi`）：
   - DeepSeek 官方 → 顶层 `payload.thinking = { type: 'enabled' }`（不塞 chat_template_kwargs）
   - 其他上游（vLLM/Qwen）→ 保留 `chat_template_kwargs:{enable_thinking:true}`
   - `budget_tokens` 仍提升 `max_tokens`
3. **admin.ts 探测**：对 DeepSeek 官方不塞 `chat_template_kwargs`
4. **响应侧 $reasoning_content → thinking block**
   - 非流式 `openAiResponseToClaude`：`reasoning_content` → `{type:'thinking', thinking}` 置于 content[0]（文本前）
   - 流式：`ClaudeContentStream.appendThinking()` 发 `content_block_start(thinking) → thinking_delta… → stop`；正文到达时 `appendText` 先 `closeThinking()` 保证顺序
5. **新 finish_reason**：`insufficient_system_resource` → `end_turn`
6. `ClaudeContentBlock` 类型补 `thinking`

### 验证

`tool-cycle.mjs` 新增 4 组用例（DeepSeek/通用上游 thinking 分派、非流式 reasoning_content、流式 thinking 生命周期+顺序、insufficient_system_resource）。三套测试全绿。

---

## 追加修复：历史 assistant 消息丢失 reasoning_content（多轮 400 根因）

### 现象

第二轮/第三轮 Tool 循环时报 `400 request param validation error ... Missing reasoning_content field in the assistant message at index 3`。Claude Code 把历史 assistant 消息发回来时，转换器把 `thinking` block 丢弃了，DeepSeek 严格校验 reasoning 模型历史必须带 `reasoning_content`。

### 根因（claude-adapter.ts：请求方向 assistant 分支）

`claudeRequestToOpenAi` 的 assistant 分支只处理 `text` / `tool_use` 两种 block，**漏了 `thinking`**。上轮只做了响应方向 `reasoning_content → thinking`，没做请求方向 `thinking → reasoning_content`（双向缺失）。

### 修复

1. **assistant 数组分支**：收集 `{type:'thinking'}` 块的 `thinking` 文本，多个拼接后写入 `out.reasoning_content`；**仅当确有 thinking 块时才设置该字段，绝不把普通文本塞进去**（防止 `content` 和 `reasoning_content` 混淆）
2. **assistant 字符串分支**：兼容已是 DeepSeek/OpenAI 形状的消息——顶层带 `reasoning_content` / `tool_calls` 时原样保留（不再只 push `{role, content}`）
3. 响应侧/请求侧闭环：`thinking`(Anthropic) ↔ `reasoning_content`(DeepSeek) 双向稳定

### 验证

`tool-cycle.mjs` 新增 3 组用例：
- 多轮往返：DeepSeek `reasoning_content` → Anthropic `thinking` → 再转回 `reasoning_content`，且 `content !== reasoning_content`
- 字符串 content + 顶层 `reasoning_content`/`tool_calls` 兼容保留
- thinking + text + tool_use 混合 block：thinking→reasoning_content、text→content、tool_use→tool_calls，互不串

三套测试全绿。

---

## 追加修复：Claude Code 剥离 thinking 后 reasoning_content 丢失（关键根因）

### 现象（用户复现）

Claude Code 显示 `Thought for 5s` 并执行 Explore，但下一轮仍报 `400 Missing reasoning_content at index 3`。说明第一轮响应侧 `reasoning_content → thinking` 成功（Claude 显示思考），但**回传历史时 Claude Code 把 thinking 块剥离了**，导致请求侧「thinking→reasoning_content」的转换永远触发不到——历史里根本没有 thinking。

### DeepSeek 强校验规则（web 调研确认）

> 思考模式下，**携带 `tool_calls` 的 assistant 历史消息必须回传 `reasoning_content`**（可为空字符串 `""`）；无 tool_calls 的普通轮忽略该字段。

这解释了为何 hello 纯文本不报错、而工具循环第二轮报 `index 3`。

### 修复：服务端跨轮缓存补挂（不依赖 Claude 是否保留 thinking）

1. **`claude-adapter.ts` 新增模块级 `reasoningCache`**（15 分钟 TTL）+ `rememberReasoning` / `lookupReasoning`；签名 = `modelSlug` + 文本 + tool_call ids（跨轮稳定）
2. **响应侧写缓存**：
   - 非流式 `openAiResponseToClaude`：返回前 `rememberReasoning(...)`
   - 流式：`ClaudeContentStream` 新增累计快照（`snapshot()`），proxy 流式收尾 `rememberReasoning(...)`
3. **请求侧补挂**（`claudeRequestToOpenAi` assistant 分支）：
   - 有 thinking 块 → 转 `reasoning_content`
   - 无 thinking 但带 tool_calls → 查缓存补挂，**miss 用空串 `""` 兜底**（满足 DeepSeek 强校验）
   - 字符串 content 分支同样兼容
4. **关键：`content` 与 `reasoning_content` 严格分离**，绝不把普通正文塞进推理字段

### 验证

`tool-cycle.mjs` 新增用例 #14：完整模拟「DeepSeek 返回 reasoning_content → response 生成 thinking + tool_use → Claude 剥离 thinking 回传（content 只剩 text+tool_use，tool_use.id 不变）→ 请求侧经缓存补挂 reasoning_content 且 content 独立」。三套测试全绿。

---

## 补充：reasoning_content 补挂对其他上游的适用边界

### 决策

用户确认：**`reasoning_content` 补挂 + 空串兜底对所有上游生效，不做 DeepSeek 专属分派**（与 `thinking` 参数的 `isDeepSeekOfficialUpstream` 分派不同）。

### 依据

- **`reasoning_content` 是消息内字段**，OpenAI 兼容层（官方/vLLM/Qwen）对历史消息里的未知字段**静默忽略**——与顶层未知参数 `chat_template_kwargs`（严格校验 400）不同。
- DeepSeek 是**唯一**强校验「带 tool_calls 必须有 reasoning_content」的上游，但补挂它对其他上游**无副作用**（多余字段被忽略）。

### 安全加固（防空值污染）

为避免非 DeepSeek 上游（无 `reasoning_content`）用空串误写缓存，`rememberReasoning` 调用处加了**非空判断**：
- 非流式 `openAiResponseToClaude`：`if (toolUseIds.length && reasoningContent)` 才写
- 流式 proxy 收尾：`if (snap.toolCallIds.length && snap.reasoning)` 才写

空串语义：**只在「确有 tool_calls 且查缓存 miss」时补挂空串 `""`**（满足 DeepSeek 强校验），非 DeepSeek 上游收到空串 reasoning_content 会被忽略，无害。

### 结论

该改动对所有上游安全：DeepSeek 正确补挂，其他 OpenAI 兼容上游静默忽略。无需按上游分派 `reasoning_content`。

### 追加（2026-09-08）：chat 模式 `/v1/chat/completions` 也自动补挂

用户之前要求「chats 模式会不会自动回传 reasoning_content」「都可以自动补挂，先检测是否有，没有再补挂」。此前补挂只覆盖 Claude 中继路径（`/v1/messages`），chat 直连路径（`/v1/chat/completions`）是 `{ ...body, model }` 原样转发，不补挂。本次补齐：

- **`claude-adapter.ts` 新增通用工具**（供 chat 路径复用，key 签名与 claude 路径一致：`slug`=上游模型 ID、`content` 文本、`tool_calls` id）：
  - `applyReasoningToChatMessages(messages, slug)`：请求侧。**先检测**——assistant 消息已带 `reasoning_content`（含空串）→ 跳过不覆盖；带 `tool_calls` 但缺 → `lookupReasoning` 补挂（命中用真实值，miss 用空串兜底）。无 `tool_calls` 的文本消息不动。
  - `rememberOpenAiResponseReasoning(slug, content, toolCallIds, reasoning)`：响应侧。仅当 `toolCallIds` 非空且 `reasoning` 非空才写缓存（防空值污染）。
  - `extractOpenAiResponseReasoning(json)`：从**非流式**响应提取 content/toolCallIds/reasoning。
  - `extractStreamReasoning(parsedChunks)`：从**流式**累计的 chunk 数组聚合 content/reasoning/toolCallIds。
- **`proxy.ts`**：
  - chat 路由 payload 构造后调用 `applyReasoningToChatMessages(payload.messages, upstreamModel)`（注：直接改 payload，转发前生效）。
  - 新增 `parseSseDataChunks(buf)`：把 SSE 文本解析为 chunk JSON 数组。
  - 流式分支收尾 `if (upstreamRes.ok)` 调 `extractStreamReasoning` + `rememberOpenAiResponseReasoning`。
  - 非流式分支 `if (upstreamRes.ok)` 调 `extractOpenAiResponseReasoning` + `rememberOpenAiResponseReasoning`。
- **key 一致性**：chat 路径请求/响应两侧统一用 `upstreamModel`（`model.upstream_model || model.slug`），自洽；claude 路径历史行为不变。
- **测试**：新增 `.e2e-test/chat-reasoning.mjs`，覆盖「已带不覆盖」「剥离后补挂」「无 tool_calls 不补挂」；build + 全量回归（protocol/tool-cycle/stream-marker）通过。
- **打包**：`sseapi-sseinfra.zip`（0.56 MB）已重新生成。
