#!/usr/bin/env bash
# sseinfra 部署入口：监听 0.0.0.0:$PORT，前台常驻
set -euo pipefail

PORT="${PORT:-8080}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

DATA_DIR="${SDPY_DATA_DIR:-${DATA_DIR:-$ROOT/data}}"
mkdir -p "$DATA_DIR"
export DATA_DIR
export PORT

# 构建阶段禁止 production，否则 npm 跳过 devDependencies（tsc/vite）
# 若平台注入了 NODE_ENV=production，这里先清掉
unset NODE_ENV || true

# 双域：控制台 platform.* / OpenAI 兼容 API api.*
export PUBLIC_BASE="${PUBLIC_BASE:-${SDPY_PUBLIC_URL:-https://platform.ssemarket.cn}}"
export SSEAPI_API_PUBLIC_URL="${SSEAPI_API_PUBLIC_URL:-${SDPY_API_PUBLIC_URL:-https://api.ssemarket.cn}}"
export SSEAPI_CORS_ORIGINS="${SSEAPI_CORS_ORIGINS:-https://platform.ssemarket.cn,https://platform.ssemarket.cn/}"
export PLATFORM_ADMIN_OAUTH_IDS="${PLATFORM_ADMIN_OAUTH_IDS:-327}"
export JWT_SECRET="${JWT_SECRET:-change-me}"

# 集市 OAuth（与 oauth2_apps.app_id=sseapi 对齐；模块 env 可覆盖）
export SSEAPI_OAUTH_BASE_URL="${SSEAPI_OAUTH_BASE_URL:-https://ssemarket.cn/new}"
export SSEAPI_OAUTH_API_BASE_URL="${SSEAPI_OAUTH_API_BASE_URL:-https://ssemarket.cn}"
export SSEAPI_OAUTH_APP_ID="${SSEAPI_OAUTH_APP_ID:-${OAUTH_APP_ID:-sseapi}}"
export SSEAPI_OAUTH_APP_SECRET="${SSEAPI_OAUTH_APP_SECRET:-${OAUTH_APP_SECRET:-change-me}}"
export SSEAPI_OAUTH_REDIRECT_URI="${SSEAPI_OAUTH_REDIRECT_URI:-${OAUTH_REDIRECT_URI:-https://platform.ssemarket.cn/oauth/callback}}"
export SSEAPI_OAUTH_AUTHORIZE_PATH="${SSEAPI_OAUTH_AUTHORIZE_PATH:-/connect}"
export SSEAPI_OAUTH_SCOPE="${SSEAPI_OAUTH_SCOPE:-read_basic}"

echo "[deploy] PORT=$PORT DATA_DIR=$DATA_DIR"
echo "[deploy] PUBLIC_BASE=$PUBLIC_BASE (console)"
echo "[deploy] SSEAPI_API_PUBLIC_URL=$SSEAPI_API_PUBLIC_URL (OpenAI /v1)"
echo "[deploy] SDPY_API_PUBLIC_URL=${SDPY_API_PUBLIC_URL:-}"
echo "[deploy] OAuth app_id=$SSEAPI_OAUTH_APP_ID redirect=$SSEAPI_OAUTH_REDIRECT_URI"
if [ -n "${MINIO_ENDPOINT:-}" ] && [ -n "${MINIO_BUCKET:-}" ]; then
  echo "[deploy] store=minio:${MINIO_BUCKET} (local backup under DATA_DIR)"
else
  echo "[deploy] store=local (未注入 MINIO_*，仅写 DATA_DIR)"
fi

# 若包内有 server/.env，补缺（不覆盖已 export / 平台注入的键）
if [ -f "$ROOT/server/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/server/.env" || true
  set +a
fi
npm_ci_or_install() {
  # 强制带上 devDependencies，避免 NODE_ENV/omit=dev 干扰
  if [ -f package-lock.json ]; then
    npm ci --include=dev
  else
    npm install --include=dev
  fi
}

# —— server ——
if [ -f server/package.json ]; then
  if [ ! -f server/dist/index.js ]; then
    echo "[deploy] building server (dist missing)…"
    cd server
    npm_ci_or_install
    npm run build
    cd "$ROOT"
  else
    echo "[deploy] server/dist 已存在，跳过 tsc；仅安装生产依赖"
    cd server
    npm ci --omit=dev 2>/dev/null || npm install --omit=dev
    cd "$ROOT"
  fi
  if [ ! -f server/dist/index.js ]; then
    echo "[deploy] FATAL: server/dist/index.js 不存在（tsc 未产出）。请检查 zip 是否含 server/src" >&2
    ls -la server/src 2>&1 | head -20 >&2 || true
    ls -la server/dist 2>&1 | head -20 >&2 || true
    exit 1
  fi
  echo "[deploy] server OK: server/dist/index.js"
fi

# —— web ——
if [ -f web/package.json ]; then
  export VITE_BASE_PATH="/"
  export VITE_API_BASE="${SDPY_API_PUBLIC_URL:-https://api.ssemarket.cn}"
  if [ ! -f web/dist/index.html ]; then
    echo "[deploy] building web…"
    cd web
    npm_ci_or_install
    npm run build
    cd "$ROOT"
  else
    echo "[deploy] web/dist 已存在，跳过 vite build"
  fi
  if [ ! -f web/dist/index.html ]; then
    echo "[deploy] FATAL: web/dist/index.html 不存在" >&2
    exit 1
  fi
  echo "[deploy] web OK: web/dist/index.html"
fi

export SSEAPI_FRONTEND_DIST="${SSEAPI_FRONTEND_DIST:-$ROOT/web/dist}"

export NODE_ENV=production
cd server
echo "[deploy] starting node dist/index.js"
exec node dist/index.js
