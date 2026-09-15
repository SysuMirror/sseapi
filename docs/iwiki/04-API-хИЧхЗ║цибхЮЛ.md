# API：列出模型



```

GET /v1/models

```



列出当前 API Key 可见、且已启用并配置上游的模型。



**响应与控制台 `GET /api/models` 同构**（字段名、定价、多模态、思考档位等一致），并追加 OpenAI 列表所需的 `object` / `created` / `owned_by`；其中 `id` 为调用 Chat Completions 时使用的 **slug**。



## 鉴权



```

Authorization: Bearer sk-...

```



## 请求示例



```bash

curl https://api.ssemarket.cn/v1/models \

  -H "Authorization: Bearer ${SSEAPI_KEY}"

```



## 响应示例



```json

{

  "object": "list",

  "data": [

    {

      "id": "qwen3.8-27b-awq",

      "object": "model",

      "created": 1724600000,

      "owned_by": "sseapi",

      "slug": "qwen3.8-27b-awq",

      "displayName": "Qwen3.8 27B AWQ",

      "description": "…",

      "badge": "vLLM",

      "inputPricePer1m": 1,

      "outputPricePer1m": 2,

      "cachePricePer1m": 0.1,

      "multimodalEnabled": true,

      "imageBillingMode": "token",

      "thinkingEnabled": true,

      "thinkingLevels": ["off", "low", "medium", "high"],

      "defaultThinking": "off",

      "capabilities": {

        "vision": true,

        "image_input": true,

        "thinking": true,

        "reasoning": true

      },

      "thinking": {

        "supported": true,

        "levels": ["off", "low", "medium", "high"],

        "default": "off",

        "request_key": "chat_template_kwargs.enable_thinking"

      },

      "multimodal": {

        "enabled": true,

        "image_input": true,

        "billing_mode": "token"

      },

      "pricing": {

        "currency": "CNY",

        "input_per_1m": 1,

        "output_per_1m": 2,

        "cache_per_1m": 0.1

      }

    }

  ]

}

```



## 字段说明



| 字段 | 说明 |

| --- | --- |

| `id` | 调用 `POST /v1/chat/completions` 时的 `model`（slug） |

| `multimodalEnabled` / `multimodal` | 是否支持 `image_url` 图片输入 |

| `thinkingEnabled` / `thinking` | 是否支持思考/推理；档位见 `thinkingLevels` |

| `inputPricePer1m` 等 | 与控制台模型卡片一致的定价（CNY / 1M tokens） |

| `capabilities` | 能力摘要（vision / thinking / reasoning 等） |



- 若模型配置了域名白名单，带 `Origin` / `Referer` 的浏览器请求可能被过滤；服务端调用通常无 Origin，不受影响

- 不含上游 URL、上游密钥等管理字段



## 错误



| HTTP | 说明 |

| --- | --- |

| 401 | API Key 无效或已吊销 |

| 429 | 触发 RPM / 并发限流 |



更多见 [错误码](./08-错误码)、[限流与域名限制](./限流与域名限制)。

