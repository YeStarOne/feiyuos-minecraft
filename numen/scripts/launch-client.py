#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""numen 车道 · 无窗拉起 numen 客户端（同伴的大脑所在进程）。

用法（计划任务/脚本拉起一律走 pythonw，铁律=控制台进程零窗口）：
    pythonw launch-client.py            # 读 client.local.json 拉起
    python  launch-client.py --dry-run  # 只打印将执行的命令，不拉

client.local.json（模板 client.local.sample.json）：
    launch_cmd_file : PCL 导出并修好掩码的启动命令文件（一行）
    cwd             : MC 版本目录（PCL 命令的 --gameDir 同款）
    extra_args      : 可选，追加到命令尾部的参数列表；
                      ⭐PCL 命令本身不带连服参数（11-28 实证，标题屏干等），
                      自动连服靠 ["--quickPlayMultiplayer", "127.0.0.1:25566"]

启动命令陷阱（为什么需要"修好的文件"）：
    PCL 导出命令带两类掩码——C:\\Users\\************* 与 uuid 掩码
    00000**********************0A328（带星号）。uuid 残留星号会直接崩
    "Invalid UUID string"。修法=字面量替换成真实用户名/uuid，正则匹配不到星号。
"""
import json
import os
import sys
import time

DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200


def local_config_path():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "client.local.json")


def main():
    cfg_path = local_config_path()
    if not os.path.isfile(cfg_path):
        print("缺 %s（形状见 client.local.sample.json）" % cfg_path)
        return 2
    with open(cfg_path, encoding="utf-8") as f:
        cfg = json.load(f)
    cmd_file = cfg["launch_cmd_file"]
    cwd = cfg["cwd"]
    with open(cmd_file, encoding="utf-8") as f:
        cmd = f.read().strip()
    if "*" in cmd or "${clientid}" in cmd.replace("${clientid}", ""):
        # 掩码残留检查：星号=PCL 掩码没换干净（uuid 或用户名）
        print("启动命令仍有掩码星号，先做字面量替换（见文件头注释）")
        return 3
    if "--dry-run" in sys.argv:
        print(cmd[:300] + ("...(%d chars)" % len(cmd)))
        return 0
    extra = cfg.get("extra_args") or []
    if extra:
        cmd = cmd + " " + " ".join('"%s"' % a if " " in a else a for a in extra)
    import subprocess
    subprocess.Popen(
        cmd,
        cwd=cwd,
        creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
        close_fds=True,
    )
    # 拉起后≈1分钟窗口出；PCL 命令自带连服参数自动连服。
    print("launched at", time.strftime("%H:%M:%S"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
