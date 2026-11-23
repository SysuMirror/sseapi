# 用量统计修复：流式 completion/cached 恒为 0 + 用量趋势图空白

2026-09-05 · api-platform

## 背景

用户反馈两个问题：
1. `usage_logs` 里 `completion_tokens` 恒为 0、`cached_tokens` 恒为 0，`total_tokens == prompt_tokens`（疑似没统计到输出）。
2. 概览页「用量趋势」折线图空白，但「近 30 日请求 / Tokens / 消费」数字都正常。

## 根因

### 问题 1：流式结算把 completion/cached 硬编码为 0

所有**流式**路径在构造最终 `usage` 对象时，只取了 `prompt`，把 `completion` 和 `cached` 写死为 `0`：

- `/v1/messages` 回退 OpenAI stream（`proxy.ts`）
- `/v1/responses` stream（`proxy.ts`）

```typescript
// 修复前（流式循环虽读到 usage.completion/cached，但只用了 prompt）
let usage = { prompt: 0, completion: 0, cached: 0, imageTokens: 0, found: false }
if (usageFound) {
  usage = { prompt: inputTokens, completion: 0, cached: 0, imageTokens: 0, found: true }  // ← completion 恒 0
}
```

于是 `settleBilling` 收到的 `completionTokens=0`，`appendUsage` 写入 `completion_tokens: 0`，且 `total = prompt + 0`。

`/v1/chat/completions` 原生流式和非流式路径正确（用 `extractUsageFromSse`/`readUsage` 读完整对象），不受影响。

### 问题 2：用量图 C柱状图空白（CSS 百分比高度失效）—— 实际是「用量」页

两类图的空白根因一致：`OverviewView.vue`（概览页「用量趋势」）和 `UsageView.vue`（用量页「按日 Tokens」）的柱状图，`.bar` 用 `height: ${h}%`，但父级 `.bar-col`（`flex:1`，`.chart` 用 `align-items:flex-end` 不拉伸子项）**没有确定高度**，导致 `.bar` 的 **百分比高度相对 auto 高度无法解析 → 高度为 0**，柱子不可见。

关键区分：`UsageView.vue` 的「按日 Tokens」是柱状图（非折线图），x 轴日期标签（`b.day.slice(5)`）来自 `byDay`，所以刻度仍显示，唯独柱子高度为 0。`byModel`、`最近调用` 有数据，说明 summary API 正常、`byDay` 有数据。

## 修复

### proxy.ts（流式结算保留真实 completion/cached）

在流式循环里新增 `completionTokens`/`cachedTokens`，`readUsage().found` 时捕获真实值；最终构造 `usage` 时：

- 有 usage：`completion = completionTokens > 0 ? completionTokens : Math.ceil(collectedText.length / 4)`（上游末细报时按文本估算兜底）
- 无 usage：`completion = Math.ceil(collectedText.length / 4)`

`/v1/responses` stream 用 `collectedOutput` 同理。

### OverviewView.vue / UsageView.vue（柱状图可渲染）

给两处 `.bar-col` 加 `height:100%` + `justify-content:flex-end`，`.bar` 加 `min-height:0; flex-shrink:0`，使百分比高度有确定参照。

### usage.ts（时区：当日归属改用本地日期）

原 `l.created_at.slice(0,10)` 取的是 **UTC 日期**，北京时间凌晨（如 UTC 前一天 23:xx）的记录会归到前一天。改为 `localDay()`（按本地时区偏移换算到 `YYYY-MM-DD`），避免最新一天记录被错分导致趋势图偏移。

## 验证

- 新增 `usage-summary.mjs` 单测：验证时区归属（UTC 前一天 23:xx → 本地当天）+ 柱子高度计算。全绿。
- 新增 `usage-chart.mjs` e2e：启动完整后端（带 30 天历史 usage_logs）+ 调 `/api/usage/summary`，断言 `byDay` 有 30 条、`request_count>0`、存在高度>4% 的柱子。全绿。
- `run-protocol.mjs` 新增用例 11b：流式请求后读 store JSON，断言 `usage_logs.completion_tokens > 0` 且 `total = prompt + completion`。通过。
- **浏览器实测**（本地完整环境，注入带数据的 store + 真实 dist）：`UsageView`「按日 Tokens」渲染出 7 根柱子，高度 `59/160/139/120/99/80/59`，全部非零；`.bar-col` 高度 = 160 撑满容器。确认修复生效。
- 后端 `tsc --noEmit` 通过；前端 `vite build` 通过，产物 `UsageView`/`OverviewView` CSS 含 `height:100%`。

## 说明

- 「上游未返回 usage 时自行统计」：流式路径现已按文本长度估算 `completion`（`length/4`），非流式路径原本就有 `estimateTokens` 兜底。`cached_tokens` 仅在上游返回时读取；上游不返回则记 0（这是合理的，缓存是上游行为）。
