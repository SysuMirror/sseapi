#!/usr/bin/env python3
"""Publish or update a single iWiki page by page id."""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
ENV_CANDIDATES = [ROOT / "iwiki" / ".env.local", HERE / ".env.local"]

PAGE_ID = "page-H7W8bNTu"
TITLE = "集市开发者平台 · 开放 API"
CONTENT_FILE = HERE / "开发者平台-开放API.md"


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    for p in ENV_CANDIDATES:
        if not p.is_file():
            continue
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    for k in ("IWIKI_TOKEN", "IWIKI_BASE"):
        if os.environ.get(k):
            env[k] = os.environ[k].strip()
    return env


def api(base: str, token: str, method: str, path: str, body: dict | None = None):
    data = None
    headers = {"Authorization": f"Bearer {token}"}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    req = urllib.request.Request(base.rstrip("/") + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw)
        except Exception:
            payload = {"error": raw}
        raise RuntimeError(f"{method} {path} -> {e.code}: {payload}") from e


def main() -> None:
    env = load_env()
    token = env.get("IWIKI_TOKEN") or ""
    base = (env.get("IWIKI_BASE") or "https://ssemarket.cn/iwiki-api").rstrip("/")
    if not token.startswith("iwk_"):
        raise SystemExit("缺少有效 IWIKI_TOKEN（iwk_ 开头）")

    content = CONTENT_FILE.read_text(encoding="utf-8")
    page_id = sys.argv[1] if len(sys.argv) > 1 else PAGE_ID

    _, spaces_payload = api(base, token, "GET", "/spaces")
    print(f"auth ok, spaces: {len(spaces_payload.get('spaces') or [])}")

    try:
        info = api(base, token, "GET", f"/wiki/page/{page_id}")[1]
        data = info.get("data") or info
        base_rev = data.get("baseRevNo")
        current_title = data.get("title") or TITLE
    except Exception as e:
        print(f"GET /wiki/page failed: {e}")
        base_rev = None
        current_title = TITLE

    title = TITLE
    if base_rev is not None:
        api(
            base,
            token,
            "POST",
            f"/wiki/page/{page_id}/save",
            {"baseRevNo": base_rev, "draftContent": content, "title": title},
        )
        print(f"updated(save) {title} -> {page_id} rev>={base_rev}")
    else:
        api(
            base,
            token,
            "PUT",
            f"/pages/{page_id}",
            {"title": title, "content": content, "visibility": "public"},
        )
        print(f"updated(put) {title} -> {page_id}")

    print(f"URL: https://ssemarket.cn/iwiki/page/{page_id}")


if __name__ == "__main__":
    main()
