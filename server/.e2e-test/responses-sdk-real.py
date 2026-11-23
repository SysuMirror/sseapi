#!/usr/bin/env python3
"""对**真实上游**模型跑官方 OpenAI SDK 的 /v1/responses 符合性检查。

与 responses-sdk-conformance.py 的区别：那个脚本对着 mock 上游，断言固定文案
（"PONG"、{"cmd":"echo hello-from-tool"}）。真实模型的回答不可预测，所以这里
只断言**协议形状**（事件顺序、schema、单调 sequence_number、工具调用的可解析性），
不断言内容。协议形状是平台代码负责的，内容才是模型负责的。

环境变量：BASE、KEY、MODEL
"""
import json
import os
import sys

from openai import OpenAI

BASE = os.environ["BASE"]
KEY = os.environ["KEY"]
MODEL = os.environ.get("MODEL", "gpt-5.5")

client = OpenAI(base_url=f"{BASE}/v1", api_key=KEY, max_retries=0)

failures = []


def check(cond, name, detail=""):
    print(f"  {'ok   ' if cond else 'FAIL '} - {name}")
    if not cond:
        print(f"         {detail}")
        failures.append(name)


def text_of(resp) -> str:
    return "".join(
        part.text
        for item in resp.output
        if getattr(item, "type", None) == "message"
        for part in (item.content or [])
        if getattr(part, "type", None) == "output_text"
    )


TOOL = {
    "type": "function",
    "name": "exec_command",
    "description": "Run a shell command and return its output.",
    "parameters": {
        "type": "object",
        "properties": {"cmd": {"type": "string", "description": "the command to run"}},
        "required": ["cmd"],
    },
}

# ── 1. 非流式 ───────────────────────────────────────────────
print(f"[sdk-real] 非流式 responses.create  model={MODEL}")
try:
    r = client.responses.create(model=MODEL, input="Reply with the single word PONG")
    check(r.object == "response" and r.status == "completed", "object/status 合法", f"object={r.object} status={r.status}")
    check(bool(text_of(r).strip()), "output_text 非空", f"got={text_of(r)!r}")
    check(bool(r.id and r.model), "id/model 非空", f"id={r.id} model={r.model}")
    check(r.usage is not None and r.usage.input_tokens > 0, "usage 合法", f"usage={r.usage}")
except Exception as e:  # noqa: BLE001
    check(False, "非流式请求未抛异常", f"{type(e).__name__}: {e}")

# ── 2. 流式：官方 stream() 助手（严格校验事件顺序）───────────
print("[sdk-real] 流式 responses.stream()（严格顺序校验）")
try:
    seqs, types = [], []
    with client.responses.stream(model=MODEL, input="Reply with the single word PONG") as stream:
        for event in stream:
            types.append(event.type)
            sn = getattr(event, "sequence_number", None)
            if sn is not None:
                seqs.append(sn)
        final = stream.get_final_response()

    for required in (
        "response.created",
        "response.output_item.added",
        "response.content_part.added",
        "response.output_text.delta",
        "response.output_item.done",
    ):
        check(required in types, f"含 {required}", f"types={types}")
    check(bool(types) and types[-1] == "response.completed", "以 response.completed 结束", f"last={types[-1] if types else None}")
    check(seqs == sorted(seqs) and len(seqs) == len(types), "sequence_number 单调递增且每个事件都有", f"seqs={seqs}")
    check(bool(text_of(final).strip()), "流式最终文本非空", f"got={text_of(final)!r}")
except Exception as e:  # noqa: BLE001
    check(False, "流式请求未抛异常", f"{type(e).__name__}: {e}")

# ── 3. 非流式 + tools：若模型调用工具，必须是合法 function_call ─
print("[sdk-real] 非流式 + tools")
try:
    r = client.responses.create(
        model=MODEL,
        input="Use the exec_command tool to run `echo hello-from-tool`. Do not answer in prose.",
        tools=[TOOL],
        tool_choice="auto",
    )
    calls = [i for i in r.output if getattr(i, "type", None) == "function_call"]
    check(len(calls) >= 1, "模型确实发起了 function_call（真实模型，允许不调用）", f"output={[i.type for i in r.output]}")
    for c in calls:
        check(c.name == "exec_command", "function_call.name 正确", f"name={c.name}")
        try:
            json.loads(c.arguments)
            check(True, "arguments 是合法 JSON 字符串", "")
        except Exception as e:  # noqa: BLE001
            check(False, "arguments 是合法 JSON 字符串", f"args={c.arguments!r} err={e}")
        check(bool(c.call_id), "call_id 非空", f"call_id={c.call_id}")
except Exception as e:  # noqa: BLE001
    check(False, "带 tools 的非流式请求未抛异常", f"{type(e).__name__}: {e}")

# ── 4. 流式 + tools：function_call 必须经 output_item.done 落地 ─
print("[sdk-real] 流式 + tools")
try:
    with client.responses.stream(
        model=MODEL,
        input="Use the exec_command tool to run `echo hello-from-tool`. Do not answer in prose.",
        tools=[TOOL],
        tool_choice="auto",
    ) as stream:
        done_items = []
        for event in stream:
            if event.type == "response.output_item.done":
                done_items.append(event.item.type)
        final = stream.get_final_response()
    calls = [i for i in final.output if getattr(i, "type", None) == "function_call"]
    check(bool(calls) == ("function_call" in done_items), "function_call 在 output_item.done 里落地", f"items={done_items}")
    check(bool(calls), "最终 output 含 function_call（真实模型，允许不调用）", f"output={[i.type for i in final.output]}")
    for c in calls:
        check(bool(c.call_id), "流式 call_id 非空", f"call_id={c.call_id}")
except Exception as e:  # noqa: BLE001
    check(False, "带 tools 的流式请求未抛异常", f"{type(e).__name__}: {e}")

# ── 5. 工具闭环：把 function_call_output 喂回去，应能续上 ──────
print("[sdk-real] 工具闭环（function_call_output 回灌）")
try:
    r1 = client.responses.create(
        model=MODEL,
        input="Use the exec_command tool to run `echo hello-from-tool`.",
        tools=[TOOL],
        tool_choice="auto",
    )
    calls = [i for i in r1.output if getattr(i, "type", None) == "function_call"]
    if not calls:
        print("  skip  - 模型这一轮没调用工具，闭环检查跳过")
    else:
        inp = [
            {"type": "function_call", "call_id": c.call_id, "name": c.name, "arguments": c.arguments}
            for c in calls
        ] + [{"type": "function_call_output", "call_id": calls[0].call_id, "output": "hello-from-tool"}]
        r2 = client.responses.create(model=MODEL, input=inp, tools=[TOOL], tool_choice="auto")
        check(r2.status == "completed", "回灌后 status=completed", f"status={r2.status}")
        check(bool(text_of(r2).strip()) or any(getattr(i, "type", None) == "function_call" for i in r2.output),
              "回灌后有可渲染输出（文本或新的工具调用）", f"output={[i.type for i in r2.output]} text={text_of(r2)!r}")
except Exception as e:  # noqa: BLE001
    check(False, "工具闭环请求未抛异常", f"{type(e).__name__}: {e}")

print()
if failures:
    print(f"==== SDK REAL-UPSTREAM CONFORMANCE FAILED ({len(failures)}) ====")
    sys.exit(1)
print("==== SDK REAL-UPSTREAM CONFORMANCE PASSED ====")
