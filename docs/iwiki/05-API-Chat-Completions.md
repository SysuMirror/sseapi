# API：Chat Completions

```
POST /v1/chat/completions
```

根据输入上下文，让模型补全对话内容。接口语义兼容 OpenAI Chat Completions；平台负责鉴权、限流、域名校验、转发上游与计费。

## 鉴权

```
Authorization: Bearer sk-...
Content-Type: application/json
```

## Request Body

### 常用字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `model` | string | 是 | 平台模型 Slug（控制台「模型」页） |
| `messages` | array | 是 | 对话消息列表 |
| `stream` | boolean | 否 | `true` 时以 SSE 流式返回 |
| `stream_options` | object | 否 | 流式选项；平台会确保 `include_usage=true` |
| `max_tokens` | integer | 否 | 最大生成 token 数 |
| `temperature` | number | 否 | 采样温度（透传上游） |
| `top_p` | number | 否 | nucleus sampling（透传上游） |
| `chat_template_kwargs` | object | 否 | 上游扩展；如 `{"enable_thinking": false}` |

### messages

每条消息包含 `role` 与 `content`：

- `role`：`system` / `user` / `assistant`（及上游支持的其它角色）
- `content`：
  - 字符串：纯文本
  - 数组：多模态 parts（需模型开启多模态），例如：

```json
[
  {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}},
  {"type": "text", "text": "描述这张图"}
]
```

详见 [多模态图像理解](./多模态图像理解)。

## 非流式示例

```bash
curl https://api.ssemarket.cn/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${SSEAPI_KEY}" \
  -d '{
    "model": "qwen3.8-27b-awq",
    "messages": [
      {"role": "user", "content": "用三句话介绍软工学院"}
    ],
    "max_tokens": 256,
    "stream": false,
    "chat_template_kwargs": {"enable_thinking": false}
  }'
```

### 响应（摘要）

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1724600000,
  "model": "上游served名或透传值",
  "choices": [
    {
      "index": 0,
      "message": {"role": "assistant", "content": "..."},
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 120,
    "completion_tokens": 80,
    "total_tokens": 200,
    "prompt_tokens_details": {
      "cached_tokens": 40
    }
  }
}
```

平台根据 `usage` 扣费，并在控制台 **用量** 中记录。

## 流式

见 [流式输出](./流式输出)。

## 计费相关字段

请优先关注响应 / SSE 末包中的：

- `usage.prompt_tokens`
- `usage.completion_tokens`
- `usage.prompt_tokens_details.cached_tokens`
- （可选）`image_tokens` 等图片拆分字段

规则见 [计费说明](./计费说明)。

## 错误

| HTTP | type / 说明 |
| --- | --- |
| 400 | 缺 model；未开多模态却传图等 |
| 401 | API Key 无效 |
| 402 | 余额不足 `insufficient_quota` |
| 403 | 域名未授权 `origin_forbidden` |
| 404 | 模型不存在或未启用 |
| 429 | RPM / 并发超限 |
| 502 | 上游连接失败 |
| 503 | 模型上游未配置 |

完整列表见 [错误码](./错误码)。
