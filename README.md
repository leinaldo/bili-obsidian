# bili-obsidian

在 B 站视频页点一下按钮，用 Claude 或 DeepSeek 把视频总结成笔记，存进 Obsidian。视频没有 AI 字幕时，自动下载音频，在本机转成文字再总结。支持 macOS 和 Windows。

**Bilibili video summary to Obsidian in one click.**

![点击按钮后的流程：获取字幕 → Claude 正在总结 → 已存入 Obsidian](docs/demo.gif)

## 功能清单

**总结**
- [x] 视频页右下角一个按钮，点一下完成：取字幕 → 总结 → 写入 Obsidian → 弹系统通知
- [x] 优先用 B 站 AI 字幕，十几到二十秒出结果
- [x] 没有 AI 字幕时，下载音频在本机转写（faster-whisper），再总结。音频不上传
- [x] 按钮实时显示进度，转写时显示百分比
- [x] 分P视频每一P单独总结，标题带「P几」
- [x] 同一个视频再点一次，覆盖原来的笔记

**模型**
- [x] Claude：Sonnet / Opus / Haiku，走本机 `claude` 命令行，用你已登录的 Claude Code 账号
- [x] DeepSeek：走本机 `opencode`，模型列表实时读取，不用在本工具里填 API Key
- [x] 自定义模型名；`provider/model` 格式交给 opencode

**笔记**
- [x] 固定结构：一句话概括、主要内容（3–8 条）、结论 / 观点
- [x] frontmatter 带标签、UP 主、链接、时长、日期，可直接用 Dataview 检索
- [x] 自动生成 3–6 个中文标签
- [x] 附加要求：在设置里写给模型的额外指令，比如「主要内容控制在 5 条以内」

**设置和界面**
- [x] ⚙ 设置面板：改模型、Obsidian 库、文件夹、附加要求，保存后立即生效
- [x] 列出本机所有 Obsidian 库，实时显示完整保存路径
- [x] 总结完可自动在 Obsidian 里打开笔记
- [x] 按钮可拖动，位置会记住
- [x] 界面放在 Shadow DOM 里，和 B 站页面样式互不影响；在面板里打字不会触发 B 站快捷键

**安装和维护**
- [x] 一行命令安装和更新，设置保留
- [x] 开机自启（macOS 用 launchd，Windows 用启动文件夹）
- [x] 自动找 Obsidian 库、Chrome / Edge / Brave 里的 Tampermonkey
- [x] 油猴脚本从本地服务自动更新
- [x] 检测「允许用户脚本」开关和重复安装的 Tampermonkey，并给出提示

**暂不支持**
- [ ] 番剧、电影、课程页（只支持 `bilibili.com/video/` 页面）
- [ ] 大会员专享或付费视频的音频转写（下载音频不带登录状态）
- [ ] 收藏夹、合集批量总结
- [ ] Linux；安装脚本自动配置 Firefox、Safari
- [ ] 用 GPU 加速转写

## 生成的笔记

节选：

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

## 工作原理

```
B 站视频页（油猴按钮）
   │  有 AI 字幕：发字幕地址；没有：只发 BV 号
   ▼
本地服务 127.0.0.1:17321（server.py）
   ├─ 有字幕：下载字幕（sub2txt.py）
   └─ 没字幕：下载音频 → faster-whisper 转写（asr.py）
   ▼
claude -p 或 opencode（DeepSeek）写总结
   ▼
Obsidian 库/B站总结/<标题>.md  + 系统通知
```

- **油猴脚本**（`bili-summary.user.js`）：借你已登录的页面加载 AI 字幕，把字幕地址发给本地服务。不读 cookie。
- **本地服务**（`server.py`）：只监听本机。请求必须带专用请求头，别的网页调用不了它。
- **音频转写**（`asr.py`）：在本机运行，音频不上传，转写完就删除。
- **隐私**：字幕或转写出的文字稿会发给你选的模型（Claude 或 DeepSeek）去总结。

## 准备

- 下面两个至少装一个，用来写总结：
  - [Claude Code](https://docs.claude.com/claude-code)：在终端里运行一次 `claude`，完成登录
  - [opencode](https://opencode.ai)（用 DeepSeek）：运行 `opencode auth login`，选 DeepSeek 并登录
- Python 3.8+：macOS 装了 Xcode 命令行工具就有；Windows 到 python.org 下载，安装时勾选 Add to PATH
- 浏览器里装好 [Tampermonkey](https://www.tampermonkey.net/)
- 浏览器里登录 B 站：AI 字幕只对登录用户可见。没登录也能用，但每个视频都要走更慢的音频转写
- 约 1GB 磁盘空间，给音频转写用：
  - 安装脚本把 faster-whisper 装进 `asr-venv/`，约 200MB
  - 第一次转写时下载模型到 `models/`，small 约 500MB。先从 ModelScope 下载，连不上再试 Hugging Face

## 安装

### 一行命令（推荐）

不用克隆仓库。命令会把代码下载到 `~/tools/bili-obsidian`，再运行安装脚本。

**macOS**（终端里运行）：

```bash
curl -fsSL https://raw.githubusercontent.com/leinaldo/bili-obsidian/main/get.sh | bash
```

**Windows**（PowerShell 里运行）：

```powershell
irm https://raw.githubusercontent.com/leinaldo/bili-obsidian/main/get.ps1 | iex
```

可选的环境变量和参数：

| 用途 | 写法 |
|---|---|
| 换安装位置 | 环境变量 `BILI_OBSIDIAN_DIR` |
| 指定 Obsidian 库（macOS） | `curl … \| bash -s -- --vault ~/my-vault` |
| 换浏览器 | 环境变量 `BILI_OBSIDIAN_BROWSER=chrome`（或 `edge`、`brave`） |
| 更新时不打开浏览器 | 环境变量 `BILI_OBSIDIAN_NO_BROWSER=1` |

### 安装脚本做什么

1. 从 Obsidian 的配置里找库：只有一个就直接用，有多个就让你选。
2. 安装音频转写组件，注册开机自启的后台服务，并确认服务已启动。
3. 找装了 Tampermonkey 的浏览器。没找到就打开扩展商店，等你装好后按回车。好几个浏览器都装了的话，会问你用哪个，并记住你的选择。
4. 在这个浏览器里打开两个页面，**要你自己点两下**（浏览器不允许程序替你点）：
   - **Tampermonkey 安装页**：点「安装」。没弹出的话，手动打开 `http://127.0.0.1:17321/bili-summary.user.js`。
   - **Tampermonkey 扩展详情页**：打开「**允许用户脚本**」开关。新版 Chrome 默认关闭这个开关；不打开，脚本装上了也不会运行。安装脚本检测到开关已打开就跳过这一步；没打开就在终端里等你打开，最多等 3 分钟。Windows 上浏览器不允许外部程序打开 `chrome://` 地址，安装脚本会把地址复制到剪贴板，你粘贴到地址栏回车即可。
5. **刷新** B 站视频页，右下角会出现紫色按钮「总结到 Obsidian」。

### 更新

再运行一次同样的一行命令。你的设置（`config.json`）、转写组件和模型都会保留。油猴脚本已是最新版时，安装脚本不会再打开安装页；以后它会从本地服务自动更新。

### 让 AI 帮你装

把下面这段话贴到 Claude Code、opencode 这类能在你电脑上执行命令的 AI 对话框里：

```text
帮我安装 https://github.com/leinaldo/bili-obsidian 。
先按 README 的「准备」检查环境，缺什么告诉我；
然后用 README 里「一行命令」的方式安装，
最后告诉我还需要我手动点哪里。
```

### 手动安装

先把仓库克隆或下载到本地。macOS 运行 `./install.sh`，Windows 双击 `install.cmd`。也可以直接指定参数：

```bash
./install.sh --vault ~/my-vault --folder B站总结 --model sonnet
```

## 使用

点按钮，按钮上依次显示进度：

| 情况 | 按钮显示 | 耗时 |
|---|---|---|
| 有 AI 字幕 | 获取字幕 → 下载字幕 → Claude 正在总结 → ✓ 已存入 Obsidian | 十几到二十秒（Sonnet 或 DeepSeek Flash） |
| 没有 AI 字幕 | 无字幕，下载音频 → 无字幕，转写音频 42% → Claude 正在总结 → ✓ 已存入 Obsidian | 转写约占视频时长的 1/5（M4 Pro 实测：12 分钟视频约 2.5 分钟）；第一次还要下载模型 |

- **拖动按钮**：按住拖到任意位置，位置会记住。按钮被别的扩展挡住时可以挪开。
- **设置面板**：点按钮旁的 ⚙。保存后，下次总结就生效，不用重启服务。

  <img src="docs/settings.png" alt="设置面板：模型、Obsidian 库和文件夹、附加要求、总结完自动打开" width="360">

## 配置

日常用设置面板改。`config.json` 由安装脚本生成，也可以手动改；改完重新运行安装脚本，让服务重启。

| 字段 | 说明 | 默认 |
|---|---|---|
| `vault` | Obsidian 库路径 | 从 Obsidian 配置里读 |
| `folder` | 库里存总结的文件夹 | `B站总结` |
| `model` | 模型名。`deepseek` 开头或 `provider/model` 格式的交给 opencode，其余交给 claude | `sonnet` |
| `extra_prompt` | 附加要求 | 空 |
| `open_after` | 总结完自动在 Obsidian 里打开 | `false` |
| `asr_model` | 没有字幕时用的 Whisper 模型：`small`、`medium`、`large-v3-turbo`。模型越大越准，也越慢、越占磁盘 | `small` |
| `port` | 本地服务端口。改了之后要重新安装一次油猴脚本 | `17321` |
| `claude` / `opencode` | 两个命令行的完整路径 | 安装时自动查找 |
| `browser` | 你看 B 站用的浏览器（`chrome` / `edge` / `brave`） | 安装时选 |

## 常见问题

| 按钮显示 | 原因 / 解决 |
|---|---|
| 没有按钮 | 多半是「允许用户脚本」没开。打开 `chrome://extensions`（Edge 是 `edge://extensions`），进 Tampermonkey 的「详细信息」打开它，再刷新 B 站 |
| 连不上本地服务 | 服务没在运行。重新运行安装脚本，或看 `server.log` |
| claude 失败：…OAuth… | 命令行版 claude 的登录过期了。在终端里运行 `claude`，输入 `/login` |
| opencode 失败：… | 运行 `opencode models deepseek` 查看模型名，再运行 `opencode run -m deepseek/<模型名> "你好"` 测试。报 Model not found 就在 ⚙ 里重新选模型；没有回答就运行 `opencode auth login` 重新登录 DeepSeek |
| 设置面板提示没找到 claude / opencode | 装好对应的命令行后，重新运行安装脚本，让它记下路径 |
| 有字幕的视频也显示「无字幕，…」 | 脚本没拿到字幕，改走了音频转写。确认这个浏览器登录了 B 站，刷新视频页再点 |
| 转写组件没装好 | 重新运行安装脚本，它会安装 `asr-venv/` |
| 音频转写失败：… | 看 `server.log`。模型下载失败多半是网络问题，再点一次会重新下载 |
| （不在按钮上）浏览器时不时自己弹出脚本安装页或更新页 | 同一个浏览器里装了两个 Tampermonkey（Edge 里常见：Edge 商店版和 Chrome 商店版各一个），旧的那个一直要你确认更新。到扩展管理页只留一个。安装脚本检测到这种情况也会提醒 |

macOS 上，仓库或 Obsidian 库放在「文稿 / 桌面 / 下载」或 iCloud 里时，后台服务可能没有读写权限。安装脚本会提示。需要时，到「系统设置 → 隐私与安全性 → 完全磁盘访问权限」里加上安装时显示的那个 python3。

## 卸载

macOS 运行 `./uninstall.sh`，Windows 双击 `uninstall.cmd`。卸载只移除后台服务，笔记和配置都会保留。然后：

- 在 Tampermonkey 里删掉「B站总结到 Obsidian」脚本。
- 想释放磁盘空间，删掉安装目录（默认 `~/tools/bili-obsidian`）。转写组件和模型都在里面，约 700MB。
