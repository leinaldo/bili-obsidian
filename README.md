# bili-obsidian

在 B 站视频页点一下按钮，就能用 Claude 把视频总结成笔记，存进 Obsidian。支持 macOS 和 Windows。

![点击按钮后的流程：获取字幕 → Claude 正在总结 → 已存入 Obsidian](docs/demo.gif)

生成的笔记长这样（节选）：

```markdown
---
tags: [B站总结, 人口, 生育率, 韩国, 日本, 生育补贴, 跨国婚姻]
up: "CLS同学"
url: https://www.bilibili.com/video/BV1NvJ66gEMn/
duration: "12:16"
date: 2026-10-23
---

# 【深度】一个让韩国生育率飙升的野路子，中国该学吗？

UP 主：CLS同学 ｜ 时长：12:16 ｜ 链接：https://www.bilibili.com/video/BV1NvJ66gEMn/

**一句话**：解析2026年日韩出生人口反弹的原因，并探讨我国能借鉴哪些做法。

## 主要内容
1. **日韩出生人口双双回升**：韩国2026年6月出生2.31万人，同比增15.6%……
2. **加大生育补贴**：……
（共 7 条）

## 结论 / 观点
- ……
```

```
B 站视频页（油猴按钮）──字幕地址──▶ 本地服务 127.0.0.1:17321 ──▶ claude -p ──▶ Obsidian/B站总结/<标题>.md
```

- **油猴脚本**（`bili-summary.user.js`）：借你已登录的页面加载 AI 字幕，把字幕地址发给本地服务。不读 cookie。
- **本地服务**（`server.py`）：下载字幕，调用 Claude Code 命令行写总结，写进 Obsidian，完成后弹系统通知。只监听本机。

## 准备

- [Claude Code](https://docs.claude.com/claude-code)，并在终端里运行过一次 `claude` 完成登录
- Python 3.8+（macOS 装了 Xcode 命令行工具就有；Windows 到 python.org 下载，安装时勾选 Add to PATH）
- 浏览器里装好 [Tampermonkey](https://www.tampermonkey.net/)
- B 站账号已登录（AI 字幕只对登录用户可见）

## 安装

**macOS**

```bash
./install.sh
```

**Windows**：双击 `install.cmd`。

安装脚本会从 Obsidian 的配置里找库：只有一个就直接用，多个会让你选。也可以直接指定：

```bash
./install.sh --vault ~/my-vault --folder B站总结 --model sonnet
```

服务起来后，安装脚本会接着处理油猴脚本：

1. 检查 Chrome / Edge / Brave 里有没有装 Tampermonkey，没有就打开扩展商店，装好后回终端按回车。
2. 在浏览器里打开 `http://127.0.0.1:17321/bili-summary.user.js`，Tampermonkey 会弹出安装页，**点「安装」**。浏览器不允许程序替你点，这是唯一要手动点的一下。
3. **刷新** B 站视频页，右下角会出现紫色按钮「总结到 Obsidian」。

之后油猴脚本有更新（比如 `git pull` 之后），Tampermonkey 会按 `@updateURL` 从本地服务自动拉新版，不用再手动装。

Chrome 里按钮不出现的话：打开 `chrome://extensions`，进 Tampermonkey 的「详细信息」，打开「允许用户脚本」，再刷新 B 站。

## 使用

点按钮后，按钮上会依次显示：获取字幕 → 下载字幕 → Claude 正在总结 → ✓ 已存入 Obsidian。用 Sonnet 一般十几秒。

- 分P视频每一P单独点，笔记标题后面带「P几」。
- 同一个视频再点一次，会覆盖原来那篇笔记。
- 视频没有 AI 字幕时，按钮会提示，不会去下音频。

## 配置

`config.json`（安装脚本生成，可以手动改，改完重新运行安装脚本让服务重启）：

| 字段 | 说明 | 默认 |
|---|---|---|
| `vault` | Obsidian 库路径 | 从 Obsidian 配置里读 |
| `folder` | 库里存总结的文件夹 | `B站总结` |
| `model` | 传给 `claude --model` | `sonnet` |
| `port` | 本地服务端口。改了之后要重新安装一次油猴脚本 | `17321` |
| `claude` | claude 命令行的完整路径 | 自动查找 |

## 常见问题

| 按钮显示 | 原因 / 解决 |
|---|---|
| 连不上本地服务 | 服务没在跑。重新运行安装脚本，或看 `server.log` |
| claude 失败：…OAuth… | 命令行版 claude 的登录过期了。终端里运行 `claude`，输入 `/login` |
| 播放器未登录 | 在这个浏览器里登录 B 站 |
| 这个视频没有 AI 字幕 | B 站没给这个视频生成字幕，暂不支持 |
| 字幕没加载出来 | 刷新视频页再点。确认油猴脚本是最新版：浏览器打开 `http://127.0.0.1:17321/bili-summary.user.js` 重新安装 |

macOS 上，如果仓库或 Obsidian 库放在「文稿 / 桌面 / 下载」或 iCloud 里，后台服务可能没有读写权限。安装脚本会提示；需要时到「系统设置 → 隐私与安全性 → 完全磁盘访问权限」里加上安装时显示的那个 python3。

## 卸载

macOS 运行 `./uninstall.sh`，Windows 双击 `uninstall.cmd`。只移除后台服务，笔记和配置都会保留。最后在 Tampermonkey 里删掉脚本。
