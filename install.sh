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
  # 找装了 Tampermonkey 的浏览器（扩展 ID 含 Edge 商店版和测试版），之后的页面都在这个浏览器里打开
  local base="$HOME/Library/Application Support" app="" scheme="" ext="" prof="" e dir name sch id d
  for e in "Google/Chrome|Google Chrome|chrome" "Microsoft Edge|Microsoft Edge|edge" "BraveSoftware/Brave-Browser|Brave Browser|brave"; do
    IFS='|' read -r dir name sch <<<"$e"
    for id in dhdgffkkebhmkfjojejmpbldmpobfkfo iikmkjmpaadaobahmlepeloendndfphd gcalenpjmijncebpfijmoaglllgpjagf; do
      for d in "$base/$dir"/*/Extensions/$id; do
        [[ -d "$d" ]] && { app="$name"; scheme="$sch"; ext="$id"; prof="${d%/Extensions/*}"; break 3; }
      done
    done
  done
  if [[ -z "$app" ]]; then
    echo
    echo "没检测到 Tampermonkey，正在打开扩展商店，装好后回到终端按回车继续"
    open "https://chromewebstore.google.com/detail/dhdgffkkebhmkfjojejmpbldmpobfkfo"
    [[ -t 0 ]] && read -r _
  fi
  # 「允许用户脚本」只能用户自己开；这里只读检查：0 已开，1 没开，2 查不到
  local us=2
  [[ -n "$prof" ]] && { "$PY" -I "$DIR/userscripts_status.py" "$prof" "$ext"; us=$?; } || true

  echo
  if [[ $us == 0 ]]; then
    echo "✓ Tampermonkey 的「允许用户脚本」已开启"
    echo "接下来在 Tampermonkey 安装页上点「安装」，然后刷新 B 站视频页（没弹出的话手动打开 $url）"
    open -a "$app" "$url"
    return
  fi
  echo "接下来在浏览器里做两件事，然后刷新 B 站视频页："
  echo "  1. Tampermonkey 安装页：点「安装」（没弹出的话手动打开 $url）"
  if [[ -z "$app" ]]; then
    echo "  2. 打开浏览器的扩展管理页（Chrome 是 chrome://extensions），进 Tampermonkey 的「详细信息」，打开「允许用户脚本」"
    open "$url"
    return
  fi
  echo "  2. Tampermonkey 扩展详情页：打开「允许用户脚本」开关"
  # 先开详情页、再开安装页：安装页在最前面，点完安装它会自己关掉，露出详情页
  open -a "$app" "$scheme://extensions/?id=$ext"
  open -a "$app" "$url"
  [[ $us == 1 ]] || return  # 查不到状态就不等了

  echo
  echo "等你打开「允许用户脚本」…（最多等 3 分钟，按 Ctrl+C 可跳过）"
  local i
  for i in $(seq 90); do
    sleep 2
    # 浏览器改完设置要过几秒才写进配置文件
    if "$PY" -I "$DIR/userscripts_status.py" "$prof" "$ext"; then
      echo "✓ 「允许用户脚本」已开启"
      return
    fi
  done
  echo "还没检测到开启。装好后如果 B 站页面上没有按钮，回到扩展详情页把「允许用户脚本」打开再刷新"
}

PORT="$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["port"])' "$DIR/config.json")"
for _ in 1 2 3 4 5; do
  sleep 1
  if H="$(curl -sf -H 'X-Bili-Summary: 1' "http://127.0.0.1:$PORT/health")"; then
    SERVED="$("$PY" -c 'import json,sys; print(json.load(sys.stdin).get("dir", ""))' <<<"$H")"
    if [[ -n "$SERVED" && "$SERVED" != "$DIR" ]]; then
      echo "✗ 端口 $PORT 上应答的是另一个目录的服务：$SERVED"
      echo "  用 lsof -i :$PORT 找到它的进程并结束，再重新运行安装脚本"
      exit 1
    fi
    echo "✓ 后台服务已启动（端口 $PORT），开机会自动运行"
    install_userscript
    exit 0
  fi
done
echo "✗ 服务没起来，看看 $DIR/launchd.log 和 $DIR/server.log"
exit 1
