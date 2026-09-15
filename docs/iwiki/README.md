# iWiki 文档源（SSE API 开放平台）

本目录为发布到 https://ssemarket.cn/iwiki/space/space-R0M8mXw2 的 Markdown 源稿，结构参考 DeepSeek API Docs。

## 发布

在 iWiki 个人页创建 API Token（`iwk_` 开头）后：

```powershell
$env:IWIKI_TOKEN = "iwk_你的token"
$env:IWIKI_BASE = "https://ssemarket.cn/iwiki-api"
$env:IWIKI_SPACE_ID = "space-R0M8mXw2"
python docs/iwiki/publish.py
```

或把 Token 写入 `iwiki/.env.local` 的 `IWIKI_TOKEN`（勿提交仓库）。

## 文档列表

| 文件 | 标题 |
|------|------|
| 00-首页.md | SSE API 开放平台文档 |
| 01-首次调用API.md | 首次调用 API |
| 02-模型与价格.md | 模型与价格 |
| 03-计费说明.md | 计费说明 |
| 04-API-列出模型.md | API：列出模型 |
| 05-API-Chat-Completions.md | API：Chat Completions |
| 06-流式输出.md | 流式输出 |
| 07-多模态图像理解.md | 多模态（图像理解） |
| 08-错误码.md | 错误码 |
| 09-限流与域名限制.md | 限流与域名限制 |
| 10-控制台使用指南.md | 控制台使用指南 |
