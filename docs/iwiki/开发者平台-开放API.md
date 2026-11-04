# 集市开发者平台 · 开放 API

> 控制台：`https://platform.ssemarket.cn`  
> API 根地址：`https://api.ssemarket.cn`  
> 更新：2026-08-27（含开发者申请）

面向集市内部服务与开发者，提供**开发者身份查询**、**开发者中心**、**模块注册**等 HTTP JSON 接口。OpenAI 兼容推理接口见同空间「SSE API 开放平台文档」。

---

## 通用约定

| 项 | 说明 |
| --- | --- |
| 协议 | HTTPS |
| 格式 | `Content-Type: application/json` |
| 成功响应 | `{ "code": 0, "message": "ok", "data": ... }` |
| 失败响应 | `{ "code": <HTTP状态>, "message": "..." }` |
| 控制台 JWT | `Authorization: Bearer <登录后 token>`（OAuth 登录 `/api/auth/oauth/*` 获得） |
| API Key | `Authorization: Bearer sk-...`（仅 `/v1/*` 代理） |
| 分页参数 | `page`（默认 1）、`page_size`（默认 20，最大 100） |

### 开发者身份说明

| 概念 | 含义 |
| --- | --- |
| `isDeveloper` | 用户被管理员标记为开发者，**或**为平台管理员 |
| `markedDeveloper` | 仅表示是否被显式标记（不含管理员继承） |
| `canAccessDeveloperHub` | 是否可访问开发者中心（`isDeveloper` 为真） |

---

## 一、开发者身份 API

基础路径：`/api/developers`

### 1.1 接口总览

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/developers` | JWT | 开发者名单（分页） |
| GET | `/api/developers/check` | 可选 JWT | 判断指定/当前用户是否为开发者 |
| GET | `/api/developers/me` | JWT | 当前用户开发者状态详情 |
| GET | `/api/developers/application` | JWT | 我的最新开发者申请 |
| POST | `/api/developers/apply` | JWT | 提交成为开发者申请 |
| POST | `/api/developers/check-batch` | JWT | 批量检查 oauthId（最多 50） |

### 1.2 开发者名单

```
GET /api/developers?page=1&page_size=20&q=
Authorization: Bearer <JWT>
```

**Query**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| page | integer | 否 | 页码，默认 1 |
| page_size | integer | 否 | 每页条数，默认 20，最大 100 |
| q | string | 否 | 搜索姓名 / oauthId / 平台用户 ID |

**响应 `data`**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| page | integer | 当前页 |
| pageSize | integer | 每页条数 |
| total | integer | 总条数 |
| items | array | 开发者列表 |

**items[] 元素**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | integer | 平台用户 ID |
| oauthId | string | 集市 OAuth user_id |
| name | string | 显示名 |
| isDeveloper | boolean | 是否为开发者（含管理员） |
| isAdmin | boolean | 是否为管理员 |

**示例**

```bash
curl -s "https://api.ssemarket.cn/api/developers?page=1" \
  -H "Authorization: Bearer $JWT"
```

---

### 1.3 判断是否为开发者

```
GET /api/developers/check
```

支持三种用法：

| 用法 | Query / Header | 鉴权 |
| --- | --- | --- |
| 按集市 ID | `?oauthId=327` | **可不登录** |
| 按平台用户 ID | `?userId=1` | **可不登录** |
| 当前登录用户 | 无 Query，带 JWT | 必须 JWT |

**响应 `data`**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| found | boolean | 是否在平台存在对应用户 |
| isDeveloper | boolean | 是否为开发者（含管理员） |
| isAdmin | boolean | 是否为管理员 |
| userId | integer \| null | 平台用户 ID |
| oauthId | string \| null | 集市 oauthId |
| name | string | 用户存在时返回显示名 |

**示例：其他服务校验 db 访问权限**

```bash
curl -s "https://api.ssemarket.cn/api/developers/check?oauthId=327"
```

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "found": true,
    "isDeveloper": true,
    "isAdmin": false,
    "userId": 1,
    "oauthId": "327",
    "name": "张三"
  }
}
```

用户不存在：

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "found": false,
    "isDeveloper": false,
    "isAdmin": false,
    "userId": null,
    "oauthId": "99999"
  }
}
```

---

### 1.4 当前用户开发者状态

```
GET /api/developers/me
Authorization: Bearer <JWT>
```

在 §1.3 响应字段基础上，额外返回：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| markedDeveloper | boolean | 是否被管理员显式标记 |
| canAccessDeveloperHub | boolean | 是否可进开发者中心 |
| application | object \| null | 最新申请记录（见 §1.6） |

> 前端也可使用 `GET /api/auth/me`，响应 `user.isDeveloper` 字段（仅显式标记，不含管理员）。

---

### 1.6 申请成为开发者

非开发者用户在控制台可点击「**加入开发者**」提交申请；管理员在管理台「开发者申请」Tab 审核。

#### 查询我的申请

```
GET /api/developers/application
Authorization: Bearer <JWT>
```

无申请时 `data` 为 `null`。

#### 提交申请

```
POST /api/developers/apply
Authorization: Bearer <JWT>
Content-Type: application/json
```

**Body**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| reason | string | 是 | 申请理由（最多 2000 字） |
| intendedUse | string | 否 | 预期用途 / 计划模块 |
| contact | string | 否 | 联系方式，默认用户邮箱 |

**响应 `data`（申请记录）**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | integer | 申请 ID |
| status | string | `pending` / `approved` / `rejected` |
| reason | string | 申请理由 |
| intendedUse | string | 预期用途 |
| contact | string | 联系方式 |
| adminNote | string | 审核备注（待审核时为空） |
| createdAt | string | 提交时间 |
| reviewedAt | string \| null | 审核时间 |

**错误**

| 场景 | HTTP | message |
| --- | --- | --- |
| 已是开发者 | 400 | 您已是开发者，无需重复申请 |
| 已有待审申请 | 400 | 您已有待审核的申请，请耐心等待 |
| 理由为空 | 400 | 请填写申请理由 |

**示例**

```bash
curl -s -X POST "https://api.ssemarket.cn/api/developers/apply" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "计划注册课程模块，需要数据库与 API 能力",
    "intendedUse": "course-module / https://course.ssemarket.cn/",
    "contact": "dev@example.com"
  }'
```

审核通过后用户 `is_developer=1`，刷新登录态或重新调用 `/api/developers/me` 即可见开发者中心入口。

---

### 1.5 批量检查

```
POST /api/developers/check-batch
Authorization: Bearer <JWT>
Content-Type: application/json
```

**Body**

```json
{
  "oauthIds": ["327", "1001", "2002"]
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| oauthIds | string[] | 是 | 最多 50 个集市 oauthId |

**响应 `data`**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| count | integer | 结果条数 |
| results | array | 与 §1.3 相同结构，每项含 oauthId |

---

## 二、开发者中心 API

基础路径：`/api/developer`  
**鉴权**：JWT + **开发者权限**（`isDeveloper` 或管理员）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/developer/hub` | 开发者中心聚合（分类入口 + 最近模块） |
| GET | `/api/developer/entries` | 平台入口列表 |

### 2.1 开发者中心 Hub

```
GET /api/developer/hub
Authorization: Bearer <JWT>
```

**响应 `data` 摘要**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| categories | array | 按分类分组的入口 `{ name, items[] }` |
| recentModules | array | 最近已发布模块（最多 6 条） |
| moduleCount | integer | 已发布模块总数 |

**入口 item 字段**

| 字段 | 说明 |
| --- | --- |
| slug | 入口标识 |
| title | 标题 |
| description | 描述 |
| url | 外链（可空） |
| internalRoute | 站内路由（可空，如 `/developer/modules`） |
| category | 分类名 |
| icon | 图标 emoji |
| openInNewTab | 是否新窗口打开 |

内置 seed 入口含：**数据库管理**（`https://db.ssemarket.cn/`）、**模块注册**、**API 开放平台**。

---

## 三、模块注册 API

基础路径：`/api/dev-modules`  
**鉴权**：JWT + **开发者权限**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dev-modules` | 已注册模块列表（分页） |
| GET | `/api/dev-modules/:slug` | 模块详情 |
| POST | `/api/dev-modules` | 提交模块注册（草稿） |

### 3.1 模块列表

```
GET /api/dev-modules?page=1&page_size=20&q=&status=
Authorization: Bearer <JWT>
```

| Query | 说明 |
| --- | --- |
| q | 搜索名称 / slug / 用途 / URL |
| status | 过滤：`active` / `draft` / `disabled` |

**响应 `data`**：`{ page, pageSize, total, items[] }`

### 3.2 模块详情

```
GET /api/dev-modules/{slug}
Authorization: Bearer <JWT>
```

**响应 `data` 字段**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | integer | 模块 ID |
| slug | string | 唯一标识 |
| name | string | 模块名称 |
| purpose | string | 用途说明 |
| expectedUrl | string | 预期访问 URL |
| docsUrl | string | 文档链接 |
| healthUrl | string | 健康检查 URL |
| ownerOauthId | string | 负责人 oauthId |
| contact | string | 联系方式 |
| extra | object | 扩展 JSON 字段 |
| status | string | `active` / `draft` / `disabled` |
| sortOrder | integer | 排序 |
| updatedAt | string | ISO 时间 |

### 3.3 提交注册

```
POST /api/dev-modules
Authorization: Bearer <JWT>
Content-Type: application/json
```

**Body**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| slug | string | 是 | 小写字母、数字、`.` `_` `-` |
| name | string | 是 | 模块名称 |
| purpose | string | 是 | 用途说明 |
| expectedUrl | string | 否 | 预期 URL |
| docsUrl | string | 否 | 文档 URL |
| healthUrl | string | 否 | 健康检查 URL |
| contact | string | 否 | 默认取用户邮箱 |
| extra | object | 否 | 扩展字段（JSON 对象） |

提交后默认 `status=draft`，管理员审核改为 `active` 后对外列表可见。

**示例**

```bash
curl -s -X POST "https://api.ssemarket.cn/api/dev-modules" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "my-service",
    "name": "我的服务",
    "purpose": "提供某某能力",
    "expectedUrl": "https://my.ssemarket.cn/",
    "extra": { "repo": "gitee.com/org/my-service", "team": "软工学院" }
  }'
```

---

## 四、登录与用户（相关）

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/auth/oauth/login-url` | 无 | 获取 OAuth 登录 URL |
| POST | `/api/auth/oauth/token` | 无 | code 换 session |
| POST | `/api/auth/oauth/userinfo` | 无 | session 换 JWT + user |
| GET | `/api/auth/me` | JWT | 当前用户（含 `isDeveloper`） |

---

## 五、健康检查

```
GET /api/health
```

无需鉴权。响应示例：

```json
{ "code": 0, "message": "ok", "data": { "service": "sseapi", "time": "..." } }
```

---

## 六、OpenAI 兼容 API（摘要）

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/v1/models` | API Key | 列出可用模型 |
| POST | `/v1/chat/completions` | API Key | Chat Completions |

API 根地址：`https://api.ssemarket.cn`（非控制台域名）。  
详细参数、流式、计费见同空间 **SSE API 开放平台文档**。

---

## 七、管理端 API（摘要）

路径前缀 `/api/admin`，需 **JWT + 管理员**。

| 分组 | 主要路径 | 说明 |
| --- | --- | --- |
| 开发者 | `GET/POST/DELETE /api/admin/developers` | 标记/取消开发者（分页） |
| 开发者申请 | `GET /api/admin/developer-applications` | 申请列表（分页） |
| | `POST /api/admin/developer-applications/:id/approve` | 通过（自动标记开发者） |
| | `POST /api/admin/developer-applications/:id/reject` | 拒绝 |
| 平台入口 | `GET/POST/PUT/DELETE /api/admin/platform-entries` | 开发者中心入口 CRUD |
| 模块 | `GET/POST/PUT/DELETE /api/admin/dev-modules` | 模块审核与管理 |
| 用户 | `GET/PATCH /api/admin/users` | 用户与额度 |
| 模型 | `GET/POST/PUT/DELETE /api/admin/models` | vLLM 上游配置 |

---

## 错误码

| HTTP | 常见原因 |
| --- | --- |
| 400 | 参数缺失或格式错误 |
| 401 | 未登录 / Token 无效 |
| 403 | 非开发者或非管理员 |
| 404 | 资源不存在 |
| 402 | API 调用余额不足 |
| 429 | 限流 |
| 502 | 上游 vLLM 不可达 |
