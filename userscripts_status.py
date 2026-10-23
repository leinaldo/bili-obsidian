"""只读检查 Chromium 系浏览器（Chrome / Edge / Brave）里某个扩展的「允许用户脚本」开关。

用法: python3 userscripts_status.py <浏览器配置目录，如 .../Chrome/Default> <扩展 ID>
退出码: 0 已开启，1 未开启，2 查不到（老版本浏览器没有这个开关，或配置文件读不了）

开关存在配置目录的 Secure Preferences（有时是 Preferences）里，字段是
extensions.settings.<ID>.user_scripts_enabled。这些文件带签名，只能读不能改，
改了浏览器会当成被篡改而重置设置。
"""
import json
import os
import sys


def status(profile, ext_id):
    for name in ("Secure Preferences", "Preferences"):
        try:
            with open(os.path.join(profile, name), encoding="utf-8") as f:
                settings = json.load(f).get("extensions", {}).get("settings", {})
        except (OSError, ValueError):
            continue
        ext = settings.get(ext_id)
        if ext and "user_scripts_enabled" in ext:
            return 0 if ext["user_scripts_enabled"] else 1
    return 2


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    sys.exit(status(sys.argv[1], sys.argv[2]))
