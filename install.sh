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

# bootout 是异步的：旧服务没完全卸载时立刻 bootstrap 会报 Input/output error，所以等它卸干净再注册
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
for _ in $(seq 20); do
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
  sleep 0.5
done
for attempt in 1 2 3; do
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null && break
  [[ $attempt == 3 ]] && { echo "✗ 注册后台服务失败，稍等几秒再运行一次安装脚本"; exit 1; }
  sleep 1
done

# 打开油猴脚本的地址，Tampermonkey 会弹出安装页，点「安装」即可；以后脚本更新也会自动拉取。
# 浏览器不允许程序替你点安装，这一下只能你自己点。
install_userscript() {
  local url="http://127.0.0.1:$PORT/bili-summary.user.js"
  # 已经装过油猴脚本时（比如只是更新），设 BILI_OBSIDIAN_NO_BROWSER=1 跳过打开浏览器；脚本会自己从本地服务更新
  if [[ -n "${BILI_OBSIDIAN_NO_BROWSER:-}" ]]; then
    echo "跳过打开浏览器。油猴脚本没装的话，手动打开：$url"
    return
  fi
  # Tampermonkey 在 Chrome / Edge 商店里的扩展 ID（含测试版），任一浏览器的任一配置里有就算装了
  local found="" d
  for d in "$HOME/Library/Application Support/"{Google/Chrome,Microsoft\ Edge,BraveSoftware/Brave-Browser}/*/Extensions/{dhdgffkkebhmkfjojejmpbldmpobfkfo,iikmkjmpaadaobahmlepeloendndfphd,gcalenpjmijncebpfijmoaglllgpjagf}; do
    [[ -d "$d" ]] && { found=1; break; }
  done
  if [[ -z "$found" ]]; then
    echo
    echo "没检测到 Tampermonkey，正在打开扩展商店，装好后回到终端按回车继续"
    open "https://chromewebstore.google.com/detail/dhdgffkkebhmkfjojejmpbldmpobfkfo"
    [[ -t 0 ]] && read -r _
  fi
  echo
  echo "正在打开油猴脚本安装页，在 Tampermonkey 页面上点「安装」即可"
  echo "（没弹出的话手动打开：$url）"
  echo "Chrome 里按钮不出现：到扩展管理页打开 Tampermonkey 的「允许用户脚本」，再刷新 B 站"
  open "$url"
}

PORT="$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["port"])' "$DIR/config.json")"
for _ in 1 2 3 4 5; do
  sleep 1
  if curl -sf -H 'X-Bili-Summary: 1' "http://127.0.0.1:$PORT/health" >/dev/null; then
    echo "✓ 后台服务已启动（端口 $PORT），开机会自动运行"
    install_userscript
    exit 0
  fi
done
echo "✗ 服务没起来，看看 $DIR/launchd.log 和 $DIR/server.log"
exit 1
