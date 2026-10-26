"""读取本机 Obsidian 的库列表。"""
import json
import os
import sys


def obsidian_vaults():
    if sys.platform == "win32":
        path = os.path.join(os.environ.get("APPDATA", ""), "obsidian", "obsidian.json")
    elif sys.platform == "darwin":
        path = os.path.expanduser("~/Library/Application Support/obsidian/obsidian.json")
    else:
        path = os.path.expanduser("~/.config/obsidian/obsidian.json")
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        vaults = json.load(f).get("vaults", {}).values()
    # 最近打开的排前面
    return [v["path"] for v in sorted(vaults, key=lambda v: -v.get("ts", 0)) if os.path.isdir(v["path"])]
