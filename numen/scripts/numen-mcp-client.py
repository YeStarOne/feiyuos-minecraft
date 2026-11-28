#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""numen 外接大脑 · 参考 MCP 客户端（调试/应急通道）。

定位：**调试与兜底用**。正轨是引擎内 MCP 客户端（dsh-mcp-client，见 docs/部署手册.md §10）——
引擎原生工具、带超时与审计；本脚本只在「引擎侧没接好/临时验一下」时顶上。

用法：
    python numen-mcp-client.py init              # 握手探针
    python numen-mcp-client.py tools             # 列工具
    python numen-mcp-client.py list              # list_companions
    python numen-mcp-client.py call say '{"companion":"Paopao","text":"嗨"}'
    python numen-mcp-client.py call lua 'return 1+1'
    python numen-mcp-client.py events            # 单次长轮询（最长 50s）
    python numen-mcp-client.py watch             # 断线重连循环（骨架）

配置（全走环境变量，token 不落盘、不打印）：
    NUMEN_MCP_TOKEN  Bearer token（必需；兼容读 MC_MCP_TOKEN）
    NUMEN_MCP_URL    默认 http://127.0.0.1:8765/mcp（PC 本机）；
                     服务器侧走隧道填 http://127.0.0.1:47856/mcp

坑（0.1.4.1 实机，详见 docs/实机格式与坑.md §20）：
    - Accept 必须双列 "application/json, text/event-stream"，单列会被拒。
    - 响应可能是 SSE（data: 行）或裸 JSON，两种都要会解。
    - lua 的 move API 实机是 numen.move.to（没有 move.walk）。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

DEFAULT_URL = os.environ.get("NUMEN_MCP_URL", "http://127.0.0.1:8765/mcp")
RPC_TIMEOUT = 60          # 普通调用超时（秒）
EVENTS_TIMEOUT = 55       # get_events 长轮询上限 50s，留 5s 余量
RETRY = 3                 # initialize 重试次数（重连骨架）
RETRY_WAIT = 2            # 重试间隔（秒）


def token():
    t = os.environ.get("NUMEN_MCP_TOKEN") or os.environ.get("MC_MCP_TOKEN")
    if not t:
        sys.stderr.write("env NUMEN_MCP_TOKEN (或 MC_MCP_TOKEN) 没设——token 只从环境读，不写进脚本\n")
        sys.exit(2)
    return t.strip()


def rpc(payload, session_id=None, url=DEFAULT_URL, timeout=RPC_TIMEOUT):
    """发一条 JSON-RPC；返回 (session_id, 解析后的响应 dict)。永不打印 token。"""
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",   # 双列缺一不可
        "Authorization": "Bearer " + token(),
    }
    if session_id:
        headers["mcp-session-id"] = session_id
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"),
                                 headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            sid = r.headers.get("mcp-session-id") or session_id
            body = r.read().decode("utf-8", "replace")
            return sid, parse_sse_or_json(body)
    except urllib.error.HTTPError as e:
        return None, {"error": "HTTP %d: %s" % (e.code, e.read().decode("utf-8", "replace")[:300])}
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return None, {"error": "conn: %s" % e}


def parse_sse_or_json(body):
    """MCP over Streamable HTTP 两种响应形态都接。"""
    body = body.strip()
    if body.startswith("{") or body.startswith("["):
        try:
            return json.loads(body)
        except ValueError:
            pass
    for line in body.splitlines():
        if line.startswith("data:"):
            try:
                return json.loads(line[5:].strip())
            except ValueError:
                continue
    return {"raw": body[:400]}


def session(url=DEFAULT_URL):
    """initialize 拿会话 id；失败重试 RETRY 次——重连骨架的最外层。
    0.1.4.1 实机服务端无状态、不发 mcp-session-id，返回 None 也算成功。"""
    last = None
    for i in range(RETRY):
        sid, resp = rpc({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                       "clientInfo": {"name": "numen-ref-client", "version": "0.1"}},
        }, url=url)
        if "result" in resp:
            # initialized 通知（MCP 规范要求，缺了有的实现不认后续调用）
            rpc({"jsonrpc": "2.0", "method": "notifications/initialized"}, session_id=sid, url=url)
            return sid
        last = resp
        time.sleep(RETRY_WAIT)
    sys.stderr.write("initialize 失败（重试 %d 次）: %s\n" % (RETRY, json.dumps(last, ensure_ascii=False)[:300]))
    sys.exit(3)


def call_tool(name, args, url=DEFAULT_URL):
    """tools/call；返回 result.content[0].text 或错误文本。"""
    sid = session(url)
    _, resp = rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                   "params": {"name": name, "arguments": args}}, session_id=sid, url=url)
    if "result" not in resp:
        return "ERR: " + json.dumps(resp.get("error", resp), ensure_ascii=False)[:400]
    content = resp["result"].get("content") or []
    return content[0].get("text", "") if content else ""


def main():
    argv = sys.argv[1:]
    if not argv:
        print(__doc__)
        return 0
    cmd = argv[0]
    if cmd == "init":
        sid = session()
        print("ok, session", (sid[:8] + "…") if sid else "(无状态,无 mcp-session-id)")
    elif cmd == "tools":
        sid = session()
        _, resp = rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, session_id=sid)
        for t in resp.get("result", {}).get("tools", []):
            print(t["name"])
    elif cmd == "list":
        print(call_tool("list_companions", {}))
    elif cmd == "call":
        name, raw = argv[1], argv[2] if len(argv) > 2 else "{}"
        try:
            args = json.loads(raw)
        except ValueError:
            args = {"code": raw}          # lua 一类的裸文本参数
        print(call_tool(name, args))
    elif cmd == "events":
        sid = session()
        _, resp = rpc({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                       "params": {"name": "get_events", "arguments": {}}},
                      session_id=sid, timeout=EVENTS_TIMEOUT)
        print(json.dumps(resp, ensure_ascii=False)[:2000])
    elif cmd == "watch":
        url = DEFAULT_URL
        while True:
            try:
                sid = session(url)
                while True:
                    _, resp = rpc({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                                   "params": {"name": "get_events", "arguments": {}}},
                                  session_id=sid, timeout=EVENTS_TIMEOUT)
                    if "error" in resp:      # 会话失效 → 重新握手
                        break
                    print(json.dumps(resp.get("result", {}), ensure_ascii=False)[:1500], flush=True)
            except KeyboardInterrupt:
                return 0
            except SystemExit:
                pass
            time.sleep(RETRY_WAIT * 5)       # 骨架：退避后重连
    else:
        sys.stderr.write("未知子命令 %r\n" % cmd)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
