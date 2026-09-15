# SSE API Platform（sseapi）

软工集市 API 开放平台：对接 **vLLM**（OpenAI 兼容）上游，统一密钥、用量、计费与文档。管理员配置模型、定价、域名限制，并手动操作用户额度。

| 入口 | 域名 |
|------|------|
| 控制台 | https://platform.ssemarket.cn |
| API | https://api.ssemarket.cn |

## 能力

| 角色 | 功能 |
|------|------|
| 用户 | OAuth 登录、API Key（可限域名）、看模型卡片/用量/余额流水、文档 |
| 调用方 | `GET /v1/models`、`POST /v1/chat/completions`（Bearer `sk-…`），平台转发 vLLM 并扣费 |
| 管理员 | 注册模型（上游 URL / served-model-name / 可选上游 Key）、入出单价、域名白名单、**RPM/并发**、增减/设定余额、文档 |

## 技术栈

Vue 3 + Express + JSON 文件存储（`DATA_DIR/sseapi-store.json`）+ 集市 OAuth。

## 本地开发

```powershell
cd server
copy .env.example .env   # 填 OAuth 与 JWT
npm install
npm run dev

cd ../web
npm install
npm run dev
```

## 部署（sdpy）

模块名建议 `sseapi`。绑定：

| 用途 | 标签 | 域名 |
|------|------|------|
| 前端 · 主 | `platform` | platform.ssemarket.cn |
| 后端 API | `api` | api.ssemarket.cn |

环境变量见 `server/.env.example`。管理员种子：`PLATFORM_ADMIN_OAUTH_IDS`（集市 user_id）。

### 注册一个 vLLM 模型（管理台）

1. 上游 Base URL：`http://<vllm-host>:8000/v1`
2. 上游模型名：与 `--served-model-name` 一致
3. 上游 API Key：多数 vLLM 可空；有鉴权则填
4. 定价：输入/输出 ¥/1M tokens
5. 允许域名（可选）：限制浏览器 `Origin`/`Referer`
6. 启用后，用户用 **Slug** 作为 `model` 字段调用

### 调用示例

```bash
curl https://api.ssemarket.cn/v1/chat/completions \
  -H "Authorization: Bearer sk-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen2-7b","messages":[{"role":"user","content":"hi"}]}'
```

<!-- auto-deploy test 1789473180 -->
