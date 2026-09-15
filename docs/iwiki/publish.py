#!/usr/bin/env python3
"""Publish docs/iwiki/*.md to an iWiki space (tree under root page)."""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]  # 软工学院基建
ENV_CANDIDATES = [
    ROOT / "iwiki" / ".env.local",
    HERE / ".env.local",
]

PAGES = [
    ("00-首页.md", "SSE API 开放平台文档", None),
    ("01-首次调用API.md", "首次调用 API", "SSE API 开放平台文档"),
    ("02-模型与价格.md", "模型与价格", "SSE API 开放平台文档"),
    ("03-计费说明.md", "计费说明", "SSE API 开放平台文档"),
    ("04-API-列出模型.md", "API：列出模型", "SSE API 开放平台文档"),
    ("05-API-Chat-Completions.md", "API：Chat Completions", "SSE API 开放平台文档"),
    ("06-流式输出.md", "流式输出", "SSE API 开放平台文档"),
    ("07-多模态图像理解.md", "多模态（图像理解）", "SSE API 开放平台文档"),
    ("08-错误码.md", "错误码", "SSE API 开放平台文档"),
    ("09-限流与域名限制.md", "限流与域名限制", "SSE API 开放平台文档"),
    ("10-控制台使用指南.md", "控制台使用指南", "SSE API 开放平台文档"),
]


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
    # process env overrides
    for k in ("IWIKI_TOKEN", "IWIKI_BASE", "IWIKI_SPACE_ID"):
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
    space = env.get("IWIKI_SPACE_ID") or "space-R0M8mXw2"
    if not token.startswith("iwk_"):
        raise SystemExit(
            "缺少有效 IWIKI_TOKEN（iwk_ 开头）。请在 iWiki 个人页创建 Token，"
            "并设置环境变量或写入 iwiki/.env.local"
        )

    # /auth/me 只认会话用户 id，不认 iwk_ API Token；用 /spaces 探测鉴权
    _, spacesPayload = api(base, token, "GET", "/spaces")
    spaces = spacesPayload.get("spaces") or []
    print(f"auth ok via API token, spaces visible: {len(spaces)}")
    if not any(s.get("id") == space for s in spaces):
        print(f"WARN: space {space} not in /spaces list (may still create if public)")

    _, listed = api(base, token, "GET", "/pages")
    existing = {
        p["title"]: p
        for p in (listed.get("pages") or [])
        if p.get("spaceId") == space
    }
    print(f"space {space}: {len(existing)} existing pages")

    title_to_id: dict[str, str] = {t: p["id"] for t, p in existing.items()}

    for filename, title, parent_title in PAGES:
        content = (HERE / filename).read_text(encoding="utf-8")
        parent_id = title_to_id.get(parent_title) if parent_title else None

        if title in title_to_id:
            page_id = title_to_id[title]
            try:
                info = api(base, token, "GET", f"/wiki/page/{page_id}")[1]
                data = info.get("data") or info
                base_rev = data.get("baseRevNo")
            except Exception as e:
                print(f"collab get failed for {title}: {e}; fallback PUT")
                base_rev = None
            if base_rev is None:
                api(
                    base,
                    token,
                    "PUT",
                    f"/pages/{page_id}",
                    {"title": title, "content": content, "visibility": "public"},
                )
                print(f"updated(put) {title} -> {page_id}")
            else:
                api(
                    base,
                    token,
                    "POST",
                    f"/wiki/page/{page_id}/save",
                    {"baseRevNo": base_rev, "draftContent": content, "title": title},
                )
                print(f"updated {title} -> {page_id} rev>={base_rev}")
        else:
            body = {
                "spaceId": space,
                "title": title,
                "content": content,
                "visibility": "public",
                "editorMode": "markdown",
            }
            if parent_id:
                body["parentId"] = parent_id
            _, created = api(base, token, "POST", "/pages", body)
            page = created.get("page") or created
            page_id = page["id"]
            title_to_id[title] = page_id
            print(f"created {title} -> {page_id}")

    home_id = title_to_id.get("SSE API 开放平台文档")
    if home_id:
        home_path = HERE / "00-首页.md"
        text = home_path.read_text(encoding="utf-8")

        def repl(m: re.Match[str]) -> str:
            label = m.group(1)
            for _fn, t, _p in PAGES:
                if t == label or label in t:
                    pid = title_to_id.get(t)
                    if pid:
                        return f"[{label}](/iwiki/page/{pid})"
            return m.group(0)

        new_text = re.sub(r"\[([^\]]+)\]\(\./[^)]+\)", repl, text)
        try:
            info = api(base, token, "GET", f"/wiki/page/{home_id}")[1]
            data = info.get("data") or info
            base_rev = data.get("baseRevNo")
            if base_rev is not None:
                api(
                    base,
                    token,
                    "POST",
                    f"/wiki/page/{home_id}/save",
                    {
                        "baseRevNo": base_rev,
                        "draftContent": new_text,
                        "title": "SSE API 开放平台文档",
                    },
                )
                print(f"rewrote homepage links -> {home_id}")
            else:
                api(
                    base,
                    token,
                    "PUT",
                    f"/pages/{home_id}",
                    {"title": "SSE API 开放平台文档", "content": new_text, "visibility": "public"},
                )
                print(f"rewrote homepage links(put) -> {home_id}")
        except Exception as e:
            print(f"homepage link rewrite skipped: {e}")

    print("DONE")
    print(f"Space: https://ssemarket.cn/iwiki/space/{space}")
    if home_id:
        print(f"Home:  https://ssemarket.cn/iwiki/page/{home_id}")


if __name__ == "__main__":
    main()
