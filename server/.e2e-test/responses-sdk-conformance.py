#!/usr/bin/env python3
"""用**官方 OpenAI Python SDK** 对平台的 /v1/responses 做协议符合性测试。

为什么用官方 SDK 而不是自己写解析：`client.responses.stream()` 内部按官方事件顺序
累积（openai/lib/streaming/responses/_responses.py），
  - 缺 `response.content_part.added` 就在 `content = output.content[event.content_index]`
    处抛 IndexError；
  - 缺 `response.output_item.added` 则 delta 无处归属；
  - 响应对象由 Pydantic 严格校验，字段缺失/类型不对会直接 ValidationError。

也就是说：只要这个脚本通过，产出的事件流就是对标准 Responses 协议合法的
（不只是「Codex 恰好能跑」）。

环境变量：BASE（形如 http://127.0.0.1:8100）、KEY（sk-...）、MODEL
"""
import json
import os
import sys

from openai import OpenAI

BASE = os.environ["BASE"]
KEY = os.environ["KEY"]
MODEL = os.environ.get("MODEL", "codex-relay")

client = OpenAI(base_url=f"{BASE}/v1", api_key=KEY, max_retries=0)

failures = []


def check(cond, name, detail=""):
    if cond:
        print(f"  ok   - {name}")
    else:
        print(f"  FAIL - {name}\n         {detail}")
        failures.append(name)


def text_of(resp) -> str:
    return "".join(
        part.text
        for item in resp.output
        if getattr(item, "type", None) == "message"
        for part in (item.content or [])
        if getattr(part, "type", None) == "output_text"
    )


# ── 1. 非流式 ───────────────────────────────────────────────
print("[sdk] 非流式 responses.create")
try:
    r = client.responses.create(model=MODEL, input="say PONG")
    check(r.object == "response" and r.status == "completed", "object/status 合法", f"object={r.object} status={r.status}")
    check(text_of(r) == "PONG", "output_text == PONG", f"got={text_of(r)!r}")
    check(r.id and r.model, "id/model 非空", f"id={r.id} model={r.model}")
    check(r.usage is not None and r.usage.input_tokens > 0, "usage 合法", f"usage={r.usage}")
except Exception as e:  # noqa: BLE001
    check(False, "非流式请求未抛异常", f"{type(e).__name__}: {e}")


# ── 2. 流式：官方 stream() 助手（严格校验事件顺序）───────────
print("[sdk] 流式 responses.stream()（严格顺序校验）")
try:
    seqs = []
    types = []
    with client.responses.stream(model=MODEL, input="say PONG") as stream:
        for event in stream:
            types.append(event.type)
            if hasattr(event, "sequence_number") and event.sequence_number is not None:
                seqs.append(event.sequence_number)
        final = stream.get_final_response()

    check("response.created" in types, "含 response.created", f"types={types}")
    check("response.output_item.added" in types, "含 response.output_item.added", f"types={types}")
    check("response.content_part.added" in types, "含 response.content_part.added", f"types={types}")
    check("response.output_text.delta" in types, "含 response.output_text.delta", f"types={types}")
    check("response.output_item.done" in types, "含 response.output_item.done", f"types={types}")
    check(types and types[-1] == "response.completed", "以 response.completed 结束", f"last={types[-1] if types else None}")
    check(seqs == sorted(seqs), "sequence_number 单调递增", f"seqs={seqs}")
    check(text_of(final) == "PONG", "流式最终文本 == PONG", f"got={text_of(final)!r}")
except Exception as e:  # noqa: BLE001
    check(False, "流式请求未抛异常", f"{type(e).__name__}: {e}")


# ── 3. 非流式 + tools：应产出可解析的 function_call item ─────
TOOL = {
    "type": "function",
    "name": "exec_command",
    "description": "run a command",
    "strict": False,
    "parameters": {"type": "object", "properties": {"cmd": {"type": "string"}}, "required": ["cmd"]},
}
print("[sdk] 非流式 + tools → function_call item")
try:
    r = client.responses.create(model=MODEL, input="run it", tools=[TOOL], tool_choice="auto")
    calls = [i for i in r.output if getattr(i, "type", None) == "function_call"]
    check(len(calls) == 1, "output 含 1 个 function_call", f"output={[i.type for i in r.output]}")
    if calls:
        c = calls[0]
        check(c.name == "exec_command", "function_call.name 正确", f"name={c.name}")
        check(json.loads(c.arguments) == {"cmd": "echo hello-from-tool"}, "arguments 是合法 JSON 字符串", f"args={c.arguments}")
        check(bool(c.call_id), "call_id 非空", f"call_id={c.call_id}")
except Exception as e:  # noqa: BLE001
    check(False, "带 tools 的非流式请求未抛异常", f"{type(e).__name__}: {e}")


# ── 4. 流式 + tools：function_call 必须经 output_item.done 落地 ─
print("[sdk] 流式 + tools → function_call item")
try:
    with client.responses.stream(model=MODEL, input="run it", tools=[TOOL], tool_choice="auto") as stream:
        done_items = []
        for event in stream:
            if event.type == "response.output_item.done":
                done_items.append(event.item.type)
        final = stream.get_final_response()
    calls = [i for i in final.output if getattr(i, "type", None) == "function_call"]
    check("function_call" in done_items, "output_item.done 里含 function_call", f"items={done_items}")
    check(len(calls) == 1, "最终 output 含 1 个 function_call", f"output={[i.type for i in final.output]}")
except Exception as e:  # noqa: BLE001
    check(False, "带 tools 的流式请求未抛异常", f"{type(e).__name__}: {e}")


print()
if failures:
    print(f"==== SDK CONFORMANCE FAILED ({len(failures)}) ====")
    sys.exit(1)
print("==== SDK CONFORMANCE PASSED ====")
