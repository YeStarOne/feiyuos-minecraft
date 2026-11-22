#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""numen 车道 · RCON 小工具（丢怪/送物资/查世界状态）。

用法：
    python mc-rcon.py "summon minecraft:sheep ~3 ~1 ~"
    python mc-rcon.py --host 127.0.0.1 --port 25576 "list"

密码来源（按序）：
    --password 参数 > 环境变量 NUMEN_RCON_PASSWORD > MC 服务器 server.properties 的 rcon.password

坑（真机实证）：
    - 响应 echo 不可靠：短包切片会 IndexError，成功与否以服务器日志为准
      （如 [Feiyu: Summoned new Sheep]）。
    - Summon 怪落点用 ~3 ~1 ~（y+1）；~4 ~ 贴地会卡进不平方块里自己憋死。
    - 对 numen 同伴说话走这里无效——她的耳朵只接 G 面板聊天框。
"""
import argparse
import socket
import struct
import sys


def read_packet(sock):
    raw = b""
    while len(raw) < 4:
        chunk = sock.recv(4096)
        if not chunk:
            return None
        raw += chunk
    (length,) = struct.unpack("<i", raw[:4])
    body = raw[4:]
    while len(body) < length:
        chunk = sock.recv(4096)
        if not chunk:
            break
        body += chunk
    if len(body) < 10:
        return None  # 短包：别切片，交给上层用日志对账
    rid, ptype = struct.unpack("<ii", body[:8])
    payload = body[8:-2]
    return rid, ptype, payload


def send(sock, rid, ptype, body: bytes):
    data = struct.pack("<ii", rid, ptype) + body + b"\x00\x00"
    sock.sendall(struct.pack("<i", len(data)) + data)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("command")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=25576)
    ap.add_argument("--password", default=None)
    args = ap.parse_args()

    password = args.password or os_environ_password() or read_server_properties(args.port)
    if not password:
        print("没有密码：--password / NUMEN_RCON_PASSWORD / server.properties 都没找到")
        return 2

    sock = socket.create_connection((args.host, args.port), timeout=5)
    send(sock, 1, 3, password.encode("utf-8"))
    pkt = read_packet(sock)
    if not pkt or pkt[0] != 1:
        print("认证失败")
        return 3
    send(sock, 2, 2, args.command.encode("utf-8"))
    pkt = read_packet(sock)
    if pkt and pkt[2]:
        print(pkt[2].decode("utf-8", "replace"))
    else:
        print("(空响应——以服务器日志为准)")
    sock.close()
    return 0


def os_environ_password():
    import os
    return os.environ.get("NUMEN_RCON_PASSWORD")


def read_server_properties(port):
    # 默认按本机部署路径找 server.properties 的 rcon.password；找不到返回 None
    import os
    for cand in (r"G:\minecraft-ai\neoforge-server\server.properties",):
        if os.path.isfile(cand):
            with open(cand, encoding="utf-8", errors="replace") as f:
                for line in f:
                    if line.strip().startswith("rcon.password="):
                        return line.split("=", 1)[1].strip()
    return None


if __name__ == "__main__":
    sys.exit(main())
