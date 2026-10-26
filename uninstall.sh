#!/usr/bin/env bash
# macOS 卸载：取消各浏览器里的本地服务注册。已生成的笔记不会删除。
set -euo pipefail
NAME="com.leinaldo.bili_obsidian"
find "$HOME/Library/Application Support" -maxdepth 4 -path "*/NativeMessagingHosts/$NAME.json" -delete 2>/dev/null || true
echo "✓ 本地服务已取消注册。最后在浏览器的扩展管理页里移除「B站视频总结」扩展"
echo "  想释放磁盘空间，再删掉这个文件夹：$(cd "$(dirname "$0")" && pwd)"
