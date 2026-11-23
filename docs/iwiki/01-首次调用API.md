# 首次调用 API

本平台 API 使用与 **OpenAI** 兼容的格式。你可以使用官方 OpenAI SDK，或任意兼容 OpenAI Chat Completions 的工具 / Agent，只需改 `base_url`、`api_key` 与 `model`。

## 接入参数

| PARAM | VALUE |
| --- | --- |
| `base_url`（OpenAI） | `https://api.ssemarket.cn/v1` |
| `api_key` | 控制台创建的 API Key（`sk-` 开头） |
| `model` | 控制台「模型」页的 **Slug** |

获取 Key：登录 [控制台](https://platform.ssemarket.cn) → **API 密钥** → **创建密钥**。明文仅展示一次，请妥善保存。

## 调用对话 API（非流式）

### curl

```bash
curl https://api.ssemarket.cn/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${SSEAPI_KEY}" \
  -d '{
    "model": "qwen3.8-27b-awq",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello!"}
    ],
    "max_tokens": 256,
    "stream": false,
    "chat_template_kwargs": {"enable_thinking": false}
  }'
```

### Python（OpenAI SDK）

```bash
pip install openai
```

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-你的密钥",
    base_url="https://api.ssemarket.cn/v1",
)

resp = client.chat.completions.create(
    model="qwen3.8-27b-awq",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Hello!"},
    ],
    max_tokens=256,
    extra_body={"chat_template_kwargs": {"enable_thinking": False}},
)
print(resp.choices[0].message.content)
```

### Node.js（OpenAI SDK）

```bash
npm i openai
```

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.SSEAPI_KEY,
  baseURL: "https://api.ssemarket.cn/v1",
});

const resp = await client.chat.completions.create({
  model: "qwen3.8-27b-awq",
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello!" },
  ],
  max_tokens: 256,
  // @ts-expect-error vendor extension
  chat_template_kwargs: { enable_thinking: false },
});
console.log(resp.choices[0].message.content);
```

## 流式输出

将 `stream` 设为 `true`。平台会强制要求上游回传 usage（`stream_options.include_usage=true`），以便按实计 token 扣费。详见 [流式输出](./流式输出)。

## 下一步

- 查看 [模型与价格](./模型与价格)
- 了解 [计费说明](./计费说明)
- 完整字段见 [Chat Completions](./API-Chat-Completions)
- 图片输入见 [多模态图像理解](./多模态图像理解)
