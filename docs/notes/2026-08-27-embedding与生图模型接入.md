# 多模型类型：Embedding 与生图

## 背景

API Platform 原先仅代理 `POST /v1/chat/completions`。需支持 OpenAI 兼容的 **Embeddings**、**Images Generations**，并在模型目录中暴露类型与端点信息。

## 实现

### 数据层

- `ModelRow.model_type`：`chat` | `embedding` | `image_generation`（存量数据 migrate 默认 `chat`）

### 目录服务 `model-catalog.ts`

- `modelType` / `modelTypeLabel` / `apiPath` / `endpoints`
- `capabilities` 按类型区分（embedding、image_output 等）
- 思考/多模态字段仅对 `chat` 有意义

### 代理 `routes/proxy.ts` + `services/proxy-common.ts`

| 路由 | 类型校验 | 响应 | 计费 |
|------|----------|------|------|
| `GET /v1/models` | — | **拉取上游 `/models` 后合并**（OpenAI 字段原样 + 平台定价/能力）；剔除 api_key 等敏感键 | — |
| `GET /v1/models/:id` | — | 单模型同上 | — |
| `POST /v1/chat/completions` | `chat` | **原样转发** upstream body | 原逻辑 |
| `POST /v1/embeddings` | `embedding` | **OpenAI 入 → 按上游协议转 → OpenAI 出** | 输入 token |

### Embedding 上游协议（2026-08-27）

平台对外始终 **OpenAI 标准** `POST /v1/embeddings`，body `{ "model": "<slug>", "input": "..." }`（`input` 可为字符串或字符串数组）。

管理台注册 embedding 时需选 **上游协议**：

| 协议 | 上游路径 | 请求体 | Base URL 示例 |
|------|----------|--------|---------------|
| `openai` | `/embeddings` | `{ model, input }` | `http://host:8080/v1` |
| `tei_inputs` | `/embed` | `{ inputs: "..." \| [...] }` | `http://host:23011`（**不含** `/v1`） |
| `tei_texts` | `/embed` | `{ texts: [...] }` | `http://host:23011` |

可选 **上游路径覆盖**（如 `/embeddings` 改 `/v1/embeddings`）。

实现：`server/src/services/embedding-adapter.ts`；探测与管理台测试同样走 adapter。

**示例（ssemarket 向量服务）**

```json
// 管理台
{
  "modelType": "embedding",
  "upstreamApiFormat": "tei_texts",
  "upstreamBaseUrl": "http://ssemarket.cn:23011",
  "upstreamPathOverride": ""
}
```

```bash
# 客户端（OpenAI 标准）
curl -X POST https://api.ssemarket.cn/v1/embeddings \
  -H "Authorization: Bearer sk-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"<slug>","input":["你好世界","hello world"]}'
```

```bash
# 上游原生（平台内部转发等价于）
curl -X POST http://ssemarket.cn:23011/embed \
  -H "Content-Type: application/json" \
  -d '{"texts":["你好世界","hello world"]}'
```
| `POST /v1/images/generations` | `image_generation` | 原样转发 | 按张或 output token |

合并规则：`{ ...upstream, ...platformCatalog, id: slug }`，保留上游 `permission` 等扩展字段；`upstream_model_id` 保留上游 id。

上游列表缓存默认 60s（`SSEAPI_UPSTREAM_MODELS_CACHE_MS`）。

### 管理台

- 注册/编辑模型时选择类型
- 连通性测试按类型调用 `/embeddings` 或 `/images/generations`
- 用户模型页展示类型标签与 `apiPath`

### 密钥配置 `GET /api/keys/config`

- 新增 `embeddings`、`imagesGenerations` 端点 URL

## 验证

```powershell
# 本地 build
cd 基础服务/api-platform/server; npm run build
cd ../web; npm run build

# 部署后（示例）
Invoke-RestMethod https://api.ssemarket.cn/v1/models -Headers @{ Authorization = "Bearer sk-..." }
# 应含 modelType、apiPath、capabilities.embedding 等

Invoke-RestMethod https://api.ssemarket.cn/v1/embeddings -Method POST `
  -Headers @{ Authorization = "Bearer sk-..."; "Content-Type" = "application/json" } `
  -Body '{"model":"<embedding-slug>","input":"hello"}'
```

## 部署

需 **rebuild/restart ai-platform**（api-platform 模块），管理台 Ctrl+F5。线上 `/v1/models` 完整字段需部署本改动后在管理台配置模型类型。

## 未决

- 生图上游若非标 OpenAI（如 SD WebUI 非 `/v1/images/generations`）需单独适配或网关转换
- Embedding 批量 dimensions 差异未在目录单独字段展示
