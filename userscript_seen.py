"""判断浏览器里的油猴脚本是不是已经装好且是最新版。安装脚本用它决定要不要打开脚本安装页。

用法: python3 userscript_seen.py
退出码: 0 已装最新版（打印版本号），1 没装或不是最新版

依据是油猴脚本运行时向本地服务报到的版本（cache/userscript_seen.json），
和本目录 bili-summary.user.js 里的 @version 比较。
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def version_tuple(v):
    return tuple(int(x) for x in v.split("."))


def main():
    with open(os.path.join(HERE, "bili-summary.user.js"), encoding="utf-8") as f:
        m = re.search(r"@version\s+([\d.]+)", f.read())
    current = m.group(1) if m else ""
    try:
        with open(os.path.join(HERE, "cache", "userscript_seen.json"), encoding="utf-8") as f:
            seen = json.load(f).get("version", "")
    except (OSError, ValueError):
        seen = ""
    if current and seen and version_tuple(seen) >= version_tuple(current):
        print(seen)
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
