#!/usr/bin/env bash
# 一行安装 / 更新（macOS）：
#   curl -fsSL https://raw.githubusercontent.com/leinaldo/bili-obsidian/main/get.sh | bash
# 下载最新代码到 ~/tools/bili-obsidian（可用 BILI_OBSIDIAN_DIR 改位置），再运行 install.sh。
# 重复运行就是更新：config.json、缓存和日志不在代码包里，会原样保留。
# 给 install.sh 传参数：curl … | bash -s -- --vault ~/my-vault
set -euo pipefail

REPO="leinaldo/bili-obsidian"
DEST="${BILI_OBSIDIAN_DIR:-$HOME/tools/bili-obsidian}"

[[ "$(uname)" == "Darwin" ]] || { echo "这个脚本只支持 macOS，Windows 请用 get.ps1"; exit 1; }

if [[ -d "$DEST/.git" ]]; then
  echo "更新 $DEST（git 仓库）"
  git -C "$DEST" pull --ff-only
else
  echo "下载最新代码到 $DEST"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/main" | tar -xz -C "$TMP"
  mkdir -p "$DEST"
  cp -R "$TMP"/*/. "$DEST"/
fi
chmod +x "$DEST"/*.sh

# 通过管道运行时，标准输入是这个脚本本身；安装过程要问你选库、按回车，所以改从终端读
if [[ ! -t 0 ]] && { : </dev/tty; } 2>/dev/null; then
  exec "$DEST/install.sh" "$@" </dev/tty
fi
exec "$DEST/install.sh" "$@"
