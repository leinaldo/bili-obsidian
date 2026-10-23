#!/usr/bin/env bash
# macOS 安装：生成配置，注册开机自启的后台服务（launchd），并检查服务是否起来。
# 用法: ./install.sh [--vault 库路径] [--folder 文件夹名] [--model sonnet] [--port 17321]
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="local.bili-obsidian"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

[[ "$(uname)" == "Darwin" ]] || { echo "这个脚本只支持 macOS，Windows 请用 install.ps1"; exit 1; }

# 优先用系统自带的 python3（装了 Xcode 命令行工具才有），版本要 3.8+
PY=""
for c in /usr/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3 "$(command -v python3 || true)"; do
  if [[ -x "$c" ]] && "$c" -c 'import sys; sys.exit(sys.version_info < (3, 8))' 2>/dev/null; then PY="$c"; break; fi
done
[[ -n "$PY" ]] || { echo "需要 Python 3.8+。可以运行 xcode-select --install 安装"; exit 1; }
echo "Python：$PY"

"$PY" "$DIR/setup_config.py" "$@"

# launchd 后台进程默认读写不了「文稿/桌面/下载」和 iCloud 里的文件
VAULT="$("$PY" -c 'import json,sys,os; c=json.load(open(sys.argv[1])); print(os.path.expanduser(c["vault"]))' "$DIR/config.json")"
for p in "$DIR" "$VAULT"; do
  case "$p" in
    "$HOME/Documents"*|"$HOME/Desktop"*|"$HOME/Downloads"*|"$HOME/Library/Mobile Documents"*)
      echo "⚠️  $p 在受保护目录里，后台服务可能没有权限读写。"
      echo "   如果总结失败，到「系统设置 → 隐私与安全性 → 完全磁盘访问权限」里加上 $PY" ;;
  esac
done

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$PY</string><string>$DIR/server.py</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$DIR/launchd.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

PORT="$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["port"])' "$DIR/config.json")"
for _ in 1 2 3 4 5; do
  sleep 1
  if curl -sf -H 'X-Bili-Summary: 1' "http://127.0.0.1:$PORT/health" >/dev/null; then
    echo "✓ 后台服务已启动（端口 $PORT），开机会自动运行"
    echo
    echo "最后一步：在浏览器装 Tampermonkey，新建脚本，粘贴下面这个文件的内容并保存："
    echo "  $DIR/bili-summary.user.js"
    exit 0
  fi
done
echo "✗ 服务没起来，看看 $DIR/launchd.log 和 $DIR/server.log"
exit 1
