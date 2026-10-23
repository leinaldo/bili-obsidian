"""生成 config.json：找到 Obsidian 库和 claude 命令行。安装脚本会调用它。

用法: python3 setup_config.py [--vault 库路径] [--folder 文件夹名] [--model sonnet] [--port 17321]

不传 --vault 时从 Obsidian 的配置里读库列表：只有一个就直接用，多个就让你选。
已有 config.json 时，没传的参数保留原值。
"""
import argparse
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, "config.json")


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


def pick_vault():
    vaults = obsidian_vaults()
    if len(vaults) == 1:
        return vaults[0]
    if vaults:
        print("找到这些 Obsidian 库：")
        for i, v in enumerate(vaults, 1):
            print(f"  {i}. {v}")
        while True:
            s = input(f"选一个 [1-{len(vaults)}，默认 1]：").strip() or "1"
            if s.isdigit() and 1 <= int(s) <= len(vaults):
                return vaults[int(s) - 1]
    s = input("没找到 Obsidian 库，请输入库的完整路径：").strip().strip('"')
    if not os.path.isdir(os.path.expanduser(s)):
        sys.exit(f"目录不存在：{s}")
    return s


def find_claude():
    found = shutil.which("claude")
    if found:
        return found
    exe = "claude.exe" if sys.platform == "win32" else "claude"
    for p in (os.path.join(os.path.expanduser("~"), ".local", "bin", exe),
              os.path.join(os.environ.get("APPDATA", ""), "npm", "claude.cmd")):
        if os.path.exists(p):
            return p
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vault")
    ap.add_argument("--folder")
    ap.add_argument("--model")
    ap.add_argument("--port", type=int)
    args = ap.parse_args()

    cfg = {}
    if os.path.exists(CONFIG):
        with open(CONFIG, encoding="utf-8") as f:
            cfg = json.load(f)
    for k in ("vault", "folder", "model", "port"):
        if getattr(args, k) is not None:
            cfg[k] = getattr(args, k)
    if not cfg.get("vault"):
        cfg["vault"] = pick_vault()
    cfg.setdefault("folder", "B站总结")
    cfg.setdefault("model", "sonnet")
    cfg.setdefault("port", 17321)

    claude = find_claude()
    if not claude:
        sys.exit("找不到 claude 命令行。先安装 Claude Code：https://docs.claude.com/claude-code")
    cfg["claude"] = claude

    with open(CONFIG, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    print(f"笔记位置：{os.path.join(cfg['vault'], cfg['folder'])}")
    print(f"claude：{claude}（模型 {cfg['model']}）")
    print(f"端口：{cfg['port']}")


if __name__ == "__main__":
    main()
