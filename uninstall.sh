#!/usr/bin/env bash
# macOS 卸载：停掉并移除后台服务。已生成的笔记和配置不会删除。
set -euo pipefail
LABEL="local.bili-obsidian"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "✓ 后台服务已移除。记得在 Tampermonkey 里删掉「B站总结到 Obsidian」脚本"
