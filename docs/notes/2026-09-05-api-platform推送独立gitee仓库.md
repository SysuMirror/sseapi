# 2026-09-05 api-platform 推送到独立 Gitee 仓库

## 背景

需要把 `api-platform` 单独推到新仓库 `https://gitee.com/xindonhub/api-platform.git`（master）。

## 关键事实

- `api-platform` **不是独立 git 仓库**，它是上层仓库 `基础服务`（E:/app/软工学院基建/基础服务，origin → `ruangongjichufuwu.git`）的子目录。
- 因此不能用 `git remote add origin` + `git push`（会与上层仓库 origin 冲突）。

## 采用方案：git subtree push

```powershell
cd E:/app/软工学院基建/基础服务
git add .gitignore api-platform        # 只提交相关文件
git commit -m "..."
git remote add api-platform https://gitee.com/xindonhub/api-platform.git
git subtree push --prefix=api-platform api-platform master
```

- subtree push 会先在本地把 `api-platform` 子目录历史拆分（split）成独立提交序列，再推送，**保留该子目录的提交历史**。
- 上层仓库的 `origin` remote 不受影响。
- 推送前先提交本轮改动（多协议支持、Tool Calling 双向映射、并发面板、打包脚本）。

## ⚠️ 密钥拦截记录

`git add api-platform` 时差点把以下内容提交，已手动排除：

1. **`api-platform/deploy/oauth.env`** —— 含真实 `SSEAPI_OAUTH_APP_SECRET` 与 `JWT_SECRET`，**绝不能入库**。已加入 `api-platform/.gitignore`（`deploy/oauth.env`、`.env.*`）。
2. **`api-platform/dist-packages/*.zip`** —— 历史部署包，已 ignore（`dist-packages/`）。

**教训**：对含 deploy/env 字样目录执行 `git add <目录>` 前必须先 `git status` 逐项确认。

## 当前 remote 布局

```
origin        https://gitee.com/xindonhub/ruangongjichufuwu.git   （上层仓库，含全部子项目）
api-platform  https://gitee.com/xindonhub/api-platform.git        （仅 api-platform 子树）
```

## 后续更新该仓库的方式

以后 api-platform 有改动，同样在 `基础服务` 仓库提交后执行：

```powershell
git subtree push --prefix=api-platform api-platform master
```
