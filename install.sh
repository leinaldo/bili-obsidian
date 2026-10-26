#!/usr/bin/env bash
# macOS 安装：装音频转写组件，记下本机 agent 命令行的路径，给 Chrome / Edge / Brave / Arc 注册本地服务，
# 然后引导你加载浏览器扩展。重复运行就是更新。
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
NAME="com.leinaldo.bili_obsidian"
EXT_ID="kcoaeghgmnflfeonjdpodfeakekcofga"  # 由 extension/manifest.json 里的 key 决定

[[ "$(uname)" == "Darwin" ]] || { echo "这个脚本只支持 macOS，Windows 请用 install.ps1"; exit 1; }

# 优先用系统自带的 python3（装了 Xcode 命令行工具才有），版本要 3.8+
PY=""
for c in /usr/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3 "$(command -v python3 || true)"; do
  if [[ -x "$c" ]] && "$c" -c 'import sys; sys.exit(sys.version_info < (3, 8))' 2>/dev/null; then PY="$c"; break; fi
done
[[ -n "$PY" ]] || { echo "需要 Python 3.8+。可以运行 xcode-select --install 安装"; exit 1; }
echo "Python：$PY"

# 旧版本（油猴脚本 + 后台 HTTP 服务）留下的开机自启服务，新版本不再需要
OLD_PLIST="$HOME/Library/LaunchAgents/local.bili-obsidian.plist"
if [[ -f "$OLD_PLIST" ]]; then
  launchctl bootout "gui/$(id -u)/local.bili-obsidian" 2>/dev/null || true
  rm -f "$OLD_PLIST"
  echo "已移除旧版本的后台服务。记得在 Tampermonkey 里删掉旧的「B站总结到 Obsidian」脚本"
fi

# 视频没有 AI 字幕时要下载音频转写。转写组件 faster-whisper 有几百 MB，装在单独的虚拟环境里
echo "安装音频转写组件（首次要下载几百 MB）…"
if ! { [[ -x "$DIR/asr-venv/bin/python" ]] || "$PY" -m venv "$DIR/asr-venv"; } ||
   ! "$DIR/asr-venv/bin/python" -m pip install -q --upgrade faster-whisper; then
  echo "⚠️  转写组件安装失败：有 AI 字幕的视频不受影响，没有字幕的视频会总结失败。可以稍后重新运行安装"
fi

# 浏览器启动本地服务时 PATH 很短，找不到 nvm、Homebrew 里的命令；这里在你的登录 shell 里查好记下来
echo "查找本机的 agent 命令行…"
"$PY" - "$DIR/clis.json" "${SHELL:-/bin/zsh}" <<'PY'
import json, subprocess, sys
out, shell = sys.argv[1], sys.argv[2]
found = {}
for c in ("claude", "codex", "opencode", "gemini", "qwen"):
    try:
        r = subprocess.run([shell, "-lic", f"command -v {c}"], capture_output=True, text=True, timeout=20,
                           stdin=subprocess.DEVNULL)
        path = next((ln for ln in reversed(r.stdout.splitlines()) if ln.startswith("/")), "")
    except subprocess.TimeoutExpired:
        path = ""
    if path:
        found[c] = path
    print(f"  {c}：{path or '未安装'}")
json.dump(found, open(out, "w"), indent=2)
if not found:
    print("  没找到任何 agent 命令行。也可以在扩展设置里改用 API（DeepSeek、通义千问、Kimi 等）")
PY

# 本地服务的启动脚本：manifest 里的 path 必须是可执行文件
cat > "$DIR/host/run_host.sh" <<SH
#!/bin/bash
exec "$PY" "$DIR/host/bili_host.py" "\$@"
SH
chmod +x "$DIR/host/run_host.sh"

MANIFEST="$(cat <<JSON
{
  "name": "$NAME",
  "description": "B站视频总结的本地服务",
  "path": "$DIR/host/run_host.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON
)"
SUPPORT="$HOME/Library/Application Support"
REGISTERED=()
for b in "Google/Chrome:Chrome" "Google/Chrome Beta:Chrome Beta" "Microsoft Edge:Edge" \
         "BraveSoftware/Brave-Browser:Brave" "Chromium:Chromium" "Arc/User Data:Arc" "Vivaldi:Vivaldi"; do
  sub="${b%%:*}"; label="${b##*:}"
  [[ -d "$SUPPORT/$sub" ]] || continue
  mkdir -p "$SUPPORT/$sub/NativeMessagingHosts"
  printf '%s\n' "$MANIFEST" > "$SUPPORT/$sub/NativeMessagingHosts/$NAME.json"
  REGISTERED+=("$label")
done
if [[ ${#REGISTERED[@]} -eq 0 ]]; then
  echo "✗ 没找到 Chrome、Edge、Brave 等浏览器"
  exit 1
fi
echo "✓ 已给这些浏览器注册本地服务：${REGISTERED[*]}"

# 按浏览器的方式启动一次本地服务，确认它能正常应答
if "$PY" - "$DIR/host/run_host.sh" <<'PY'
import json, struct, subprocess, sys
p = subprocess.Popen([sys.argv[1]], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
msg = json.dumps({"id": 1, "cmd": "hello"}).encode()
out, _ = p.communicate(struct.pack("=I", len(msg)) + msg, timeout=60)
r = json.loads(out[4:4 + struct.unpack("=I", out[:4])[0]])
assert r["type"] == "result", r
print("✓ 本地服务自检通过：命令行 " + ("、".join(c["name"] for c in r["clis"]) or "无") +
      "；音频转写 " + ("可用" if r["asr"] else "不可用"))
PY
then :; else echo "✗ 本地服务自检失败，看 $DIR/host.log"; exit 1; fi

EXT="$DIR/extension"
echo
echo "最后一步：在浏览器里加载扩展（只需一次，以后更新代码后在扩展页点「重新加载」即可）"
echo "  1. 打开扩展管理页（Chrome：chrome://extensions，Edge：edge://extensions），打开右上角「开发者模式」"
echo "  2. 点「加载已解压的扩展程序」，选择这个文件夹："
echo "     $EXT"
echo "     （路径已复制到剪贴板；在选择窗口里按 Cmd+Shift+G 粘贴）"
echo "  3. 如果浏览器之前开着，完全退出再打开一次，让它读到本地服务"
printf '%s' "$EXT" | pbcopy
if [[ -t 0 && -z "${BILI_OBSIDIAN_NO_BROWSER:-}" && -d "/Applications/Google Chrome.app" ]]; then
  open -a "Google Chrome" "chrome://extensions" || true
fi
