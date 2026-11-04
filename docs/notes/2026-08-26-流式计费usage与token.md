# 流式调用用量计费：优先上游 usage token

## 背景

用户流式调用 `/v1/chat/completions` 时，vLLM 默认 SSE 片段**不含** `usage`（示例流只有 delta content，以 `[DONE]` 结束）。非流式响应则有准确字段，例如：

`prompt_tokens: 54, completion_tokens: 800, total_tokens: 854`

## 原问题

`proxy.ts` 流式路径：

1. 用单 chunk 正则抓 `prompt_tokens` / `completion_tokens`（半包易丢）
2. 抓不到时用 `JSON.stringify(messages).length/4` + **整段 SSE `buf.length/4`** 估算 → 把 `data:`、JSON 外壳也算进 completion，**严重多计费**

## 修复

1. `stream: true` 时强制注入 `stream_options.include_usage: true`，让 vLLM 在结束前下发真实 usage
2. 流结束后解析整段 SSE，取**最后一次** `usage`
3. 仍无 usage 时：只按 messages 体积 + **实际 delta.content 文本** `/4` 粗估，并在 usage_log `error_message` 标 `usage_estimated`
4. 非流式同样：有 `usage` 用上游；否则按 message.content 粗估（避免成功却 0 token 白嫖）

计费公式不变：`calcCostCents(prompt, completion, input¥/1M, output¥/1M)`，分进/出单价。

## 验证

- 流式请求后，用量日志 `prompt_tokens` / `completion_tokens` 应与上游末包 usage 一致（或接近）
- 不应再出现 completion 远大于实际输出字数的情况
- 重新打包部署：`deploy/pack-sseinfra.ps1` → 上传 zip 部署 ai-platform
