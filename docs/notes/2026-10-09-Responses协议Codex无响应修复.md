# 2026-10-09 /v1/responses 在 Codex 端完全无响应：修复与验证

## 背景

用户反馈：用 Codex 接平台（`wire_api = "responses"`，base_url 指向本平台 `/v1`）时**完全没有响应**——不是报错，是界面一直是空的，日志也看不出原因。

关键约束：Codex CLI 0.162.0 已经**删掉 `wire_api = "chat"`**（`WireApi` 枚举只剩 `Responses`，报 `CHAT_WIRE_API_REMOVED_ERROR`）。也就是说，对绝大多数没有配 `responses_base_url` 的模型，Codex 必须走平台的「Responses → Chat Completions 转换反代」，没有别的路可走。

所以这不是小众路径，而是主路径。

## 根因

`responses-adapter.ts` 原来的 `openAiStreamChunkToResponses` 是**无状态**的：吃一个 chat chunk 就吐一个 `response.output_text.delta`，最后吐一个 `response.completed`。

Codex 的客户端（`codex-rs`）不是这么认的：

- `active_item` **只**由 `response.output_item.added` 创建；
- 收到 `response.output_text.delta` 而当前没有 active item 时，直接 `error_or_panic("OutputTextDelta without active item")` 丢掉，**并且不会有任何可见输出**；
- 助手的最终文本来自 `output_item.done`；
- 流必须以 `response.completed` 结束，否则报 "stream closed before response.completed"。

于是：平台发的每一段文本都被 Codex 丢掉，`response.completed` 里也没有 output → **界面全空，且没有有效报错**。这正是用户看到的「完全没有响应」。

同一类 bug 在公开项目里也有：LiteLLM #20975、Hermes #119758。

## 方案

把转发改成**有状态的状态机** `ResponsesStreamBuilder`，完整产出标准生命周期：

```
response.created
response.in_progress
response.output_item.added      (message item)
response.content_part.added
response.output_text.delta * n
response.output_text.done
response.content_part.done
response.output_item.done
[工具调用] response.function_call_arguments.delta * n
           response.function_call_arguments.done
           response.output_item.done (function_call item)
response.completed
```

`sequence_number` 从 0 单调递增；无论上游给不给 `finish_reason`，`finish()` 都保证收尾。

顺带修掉的四个连带问题（都是真上游上暴露出来的）：

1. **上游 200 + SSE 里塞错误体**（不少反代这么干）→ 原来客户端只看到「流在 completed 之前结束」这种零信息量报错。现在识别出来规范成 `response.failed`，错误文案原样带给客户端。
2. **`response.failed` / `finish()` 之前没有 `response.created`** → 官方 OpenAI SDK 的 `stream()` 会抛 `Expected to have received response.created before response.failed`。已改为 `start()` 幂等前置。
3. **`finish_reason` 之后那块「只带 usage」的 chunk 被丢掉** → 原来循环里 `if (chunkDone) break`，而 OpenAI 规范的顺序是 `finish_reason` 先到、usage chunk 后到。结果 `response.completed.usage` 全是 0（Codex 显示 0 token），计费也只能退回估算。现在 finish 之后继续读到流自然结束，但不无限等——再等 3s 就收尾。
4. **纯工具回灌转出来没有 `user` 角色**（只有 `function_call` + `function_call_output`）→ vLLM/SGLang 一类 chat 模板直接 400 `No user query found in messages`。现在检测到没有 user 就补一条占位 user。

另外把 Responses 路由的错误语义从「Anthropic 形状的 `{type:'error',error:{...}}`」改成 Responses 形状的 `{error:{message,type,code}}` + **真实 HTTP 状态码 + `Retry-After`**：Anthropic 形状的错误体塞进 200 SSE 会被 Responses 客户端当普通事件吞掉。

## 关键文件

- `server/src/services/responses-adapter.ts`：重写。新增 `ResponsesStreamBuilder`（`start`/`push`/`finish`/`fail`）、`responsesRequestToOpenAi`、`responsesToolsToOpenAi`（扁平 Responses 工具定义 → Chat `function` 包装，`type:'custom'` 如 `apply_patch` 给宽容 schema）、`responsesToolChoiceToOpenAi`、`responsesInputToMessages`（`function_call` 合并进同一条 assistant 的 `tool_calls`、`function_call_output` → `role:'tool'`、`reasoning` 丢弃、`developer` → `system`）、`openAiResponseToResponses`、`upstreamErrorToResponses`、`sseBlockIsErrorPayload`。删掉无状态的 `openAiStreamChunkToResponses`。
- `server/src/routes/proxy.ts`：`/v1/responses` 两条分支。独立上游透传分支新增「非 200 透传真实状态码 + Responses 形状错误体 + `Retry-After`」「SSE 首块是错误体 → `response.failed`」「`X-Accel-Buffering: no` + `flushHeaders()`」；转换分支改用 `ResponsesStreamBuilder`，并修掉 `finish_reason` 就 break 导致的 usage 丢失。

## 验证

四个层次，全部真跑：

1. **mock 上游 + 真实 Codex CLI**：`.e2e-test/codex-responses.mjs`（透传 / 转换 / 工具往返 / 上游 503 / 上游 200+SSE 错误）。
2. **官方 OpenAI Python SDK 符合性**（严格事件顺序 + Pydantic schema）：`.e2e-test/responses-sdk-conformance.py`。用官方 SDK 当 oracle 的意义是：`client.responses.stream()` 内部按官方顺序累积，缺 `content_part.added` 直接 `IndexError`——过了才叫「协议合法」，而不只是「Codex 恰好能跑」。
3. **真实上游 + 真实 Codex CLI**：`.e2e-test/real-upstream-verify.mjs`（从生产 store 只读复制模型行，服务跑在临时 DATA_DIR 且显式关掉 MinIO，不写生产数据、不建生产 key）。
4. **单点 usage 检查**：`.e2e-test/real-usage-check.mjs`。

结果（2026-10-09）：

- mock 全套 `ALL PASSED`；官方 SDK 对 `codex-relay` / `codex-passthrough` 双双 `CONFORMANCE PASSED`。
- 真实上游 `qwen-3.8-flash-fast`（`ssemarket.cn:23034`，走转换反代）：真实 Codex CLI 6/6 通过，含一次完整的工具调用往返（Codex 内置 shell 工具 → `command_execution` item → 最终回复）。
- 真实上游 `text-2.5-flash`（`apihub.agnes-ai.com`）：SDK 符合性全过；usage 检查拿到真实计数 `input_tokens 291 / output_tokens 19`（含 `cached_tokens 256`、`reasoning_tokens 15`），证明第 3 个连带问题已修好。

跑测试的环境依赖：Codex CLI 装在 `/tmp/codex-cli`，OpenAI SDK 在 `/tmp/openai-venv`。harness 里有一处必须记住的坑：驱动 codex 必须用**异步 `spawn`**，用 `spawnSync` 会阻塞 harness 自己的事件循环，同进程的 mock 上游就无法应答，看起来像「被测代码挂了」，其实是测试脚本的问题。

## 部署

生产由 supervisord（`~/deploy/supervisord.conf` → `programs/deploy-AGEHbb2xg6.conf`）拉起 `deploy.sh`。

**坑**：`deploy.sh` 的判断是「`server/dist/index.js` 存在就跳过 `tsc`」。改了 `server/src` 之后必须先手动 `npm run build`，否则重启的还是旧代码。本次流程：

```bash
cd server && npm ci --include=dev && npm run build   # deploy.sh 会 npm ci --omit=dev，devDeps 不常驻
~/.local/bin/supervisorctl -c ~/deploy/supervisord.conf restart deploy-AGEHbb2xg6
```

已确认：重启后 `[sseapi] listening on 0.0.0.0:8080`，`/v1/models` 无 key 返回 401（鉴权正常）。

## 记一笔：上游现状（2026-10-09 探测）

`.e2e-test/probe-upstreams.mjs` 的结果，供后续排查参考：

- `gpt-5.5` 系（`ssemarket.cn:23027`）：**配了 `responses_base_url` → 走原生透传**，但上游侧目前 503 `All API keys are cooling down`（其 key 池在冷却，与平台无关）。以前这种情况客户端什么都看不到，现在能看到真实文案 + `Retry-After`。
- `qwen-3.8-flash` / `qwen-3.8-flash-fast`（`ssemarket.cn:23034`）：chat 200，`/responses` 404 → 走转换反代，**实测可用**。
- `text-2.5-flash`（`apihub.agnes-ai.com`）：chat 与 `/responses` 都是 200（**上游其实原生支持 Responses**，只是模型没配 `responses_base_url`，白走了一层转换）。若给它配上 `responses_base_url`，可省掉转换、也更贴近上游原生行为。
- `spark2.5` 上游 502（nginx）、`ling-3.0-flash` 连接失败、`kimi-k2.6` / `deepseek-v4-flash` 403、`glm-5.3` 401：都是上游侧问题，与本次改动无关。
