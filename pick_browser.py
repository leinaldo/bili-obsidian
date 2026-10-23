"""选出你平时看 B 站用的浏览器（装了 Tampermonkey 的那个），安装脚本在它里面打开页面。

用法: python3 pick_browser.py
输出一行 JSON：{"key", "name", "scheme", "id", "profile", "app", "exe"}；没找到装了 Tampermonkey 的浏览器时输出 {}。

怎么选：
1. 环境变量 BILI_OBSIDIAN_BROWSER（chrome / edge / brave）指定了就用它
2. config.json 里记过上次的选择，就沿用
3. 只有一个浏览器装了 Tampermonkey，就用它
4. 有多个时问你选，默认是系统默认浏览器；不在终端里运行时直接用默认
选好后记进 config.json，下次不再问。
"""
import json
import os
import plistlib
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, "config.json")
IS_WIN = sys.platform == "win32"
# Tampermonkey 的扩展 ID：Chrome 商店正式版、Edge 商店版、Chrome 商店测试版
TM_IDS = ("dhdgffkkebhmkfjojejmpbldmpobfkfo", "iikmkjmpaadaobahmlepeloendndfphd", "gcalenpjmijncebpfijmoaglllgpjagf")

if IS_WIN:
    _base = os.environ.get("LOCALAPPDATA", "")
    BROWSERS = [
        {"key": "chrome", "name": "Chrome", "scheme": "chrome", "exe": "chrome",
         "root": os.path.join(_base, "Google", "Chrome", "User Data")},
        {"key": "edge", "name": "Edge", "scheme": "edge", "exe": "msedge",
         "root": os.path.join(_base, "Microsoft", "Edge", "User Data")},
        {"key": "brave", "name": "Brave", "scheme": "brave", "exe": "brave",
         "root": os.path.join(_base, "BraveSoftware", "Brave-Browser", "User Data")},
    ]
else:
    _base = os.path.expanduser("~/Library/Application Support")
    BROWSERS = [
        {"key": "chrome", "name": "Chrome", "scheme": "chrome", "app": "Google Chrome",
         "root": os.path.join(_base, "Google", "Chrome")},
        {"key": "edge", "name": "Edge", "scheme": "edge", "app": "Microsoft Edge",
         "root": os.path.join(_base, "Microsoft Edge")},
        {"key": "brave", "name": "Brave", "scheme": "brave", "app": "Brave Browser",
         "root": os.path.join(_base, "BraveSoftware", "Brave-Browser")},
    ]


def find_installed():
    """每个装了 Tampermonkey 的浏览器取一条：哪个配置目录、哪个扩展 ID。"""
    hits = []
    for b in BROWSERS:
        if not os.path.isdir(b["root"]):
            continue
        # Default 排前面，其次 Profile 1、Profile 2……
        profiles = sorted(os.listdir(b["root"]), key=lambda p: (p != "Default", p))
        for prof in profiles:
            ids = [i for i in TM_IDS if os.path.isdir(os.path.join(b["root"], prof, "Extensions", i))]
            if ids:
                hits.append(dict(b, id=ids[0], profile=os.path.join(b["root"], prof)))
                break
    return hits


def default_browser():
    """系统默认浏览器的 key，认不出来返回空串。"""
    try:
        if IS_WIN:
            import winreg
            path = r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice"
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as k:
                prog = winreg.QueryValueEx(k, "ProgId")[0].lower()
            for key, mark in (("edge", "msedge"), ("chrome", "chrome"), ("brave", "brave")):
                if mark in prog:
                    return key
        elif sys.platform == "darwin":
            path = os.path.expanduser(
                "~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist")
            with open(path, "rb") as f:
                handlers = plistlib.load(f).get("LSHandlers", [])
            for h in handlers:
                if h.get("LSHandlerURLScheme") == "https":
                    bundle = (h.get("LSHandlerRoleAll") or "").lower()
                    for key, mark in (("edge", "edgemac"), ("chrome", "com.google.chrome"), ("brave", "brave")):
                        if mark in bundle:
                            return key
    except Exception:  # noqa: BLE001 — 认不出默认浏览器就按顺序取第一个
        pass
    return ""


def load_config():
    try:
        with open(CONFIG, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def remember(key):
    cfg = load_config()
    if cfg and cfg.get("browser") != key:
        cfg["browser"] = key
        with open(CONFIG, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)


def choose(hits):
    by_key = {h["key"]: h for h in hits}
    forced = os.environ.get("BILI_OBSIDIAN_BROWSER", "").strip().lower()
    if forced in by_key:
        return by_key[forced]
    saved = load_config().get("browser", "")
    if saved in by_key:
        return by_key[saved]
    if len(hits) == 1:
        return hits[0]
    default = by_key.get(default_browser(), hits[0])
    if not sys.stdin.isatty():
        return default
    # 提示写到 stderr，stdout 只留给结果 JSON
    print("这几个浏览器都装了 Tampermonkey，你平时在哪个里面看 B 站（要在那里登录 B 站）？", file=sys.stderr)
    for i, h in enumerate(hits, 1):
        print(f"  {i}. {h['name']}" + ("（系统默认）" if h is default else ""), file=sys.stderr)
    n = hits.index(default) + 1
    while True:
        print(f"选一个 [1-{len(hits)}，默认 {n}]：", end="", file=sys.stderr, flush=True)
        s = sys.stdin.readline().strip() or str(n)
        if s.isdigit() and 1 <= int(s) <= len(hits):
            return hits[int(s) - 1]


def main():
    hits = find_installed()
    if not hits:
        print("{}")
        return
    pick = choose(hits)
    remember(pick["key"])
    print(json.dumps({k: pick.get(k, "") for k in ("key", "name", "scheme", "id", "profile", "app", "exe")},
                     ensure_ascii=False))


if __name__ == "__main__":
    main()
