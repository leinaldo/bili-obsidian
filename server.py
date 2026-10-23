"""B站视频一键总结到 Obsidian 的本地服务（macOS / Windows）。

油猴脚本在视频页拿到字幕地址后 POST 到这里；本服务下载字幕、调用 `claude -p`
写总结，存进 Obsidian 库里的总结文件夹，完成后弹系统通知。

配置在同目录的 config.json（由安装脚本生成，见 setup_config.py）。

只监听 127.0.0.1。请求必须带 X-Bili-Summary 头（迫使浏览器跨站请求走预检，
本服务不响应预检，所以别的网页无法调用它）。
"""
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
IS_WIN = sys.platform == "win32"
# Windows 下后台运行时不要弹出黑色控制台窗口
NO_WINDOW = {"creationflags": subprocess.CREATE_NO_WINDOW} if IS_WIN else {}


CONFIG = os.path.join(HERE, "config.json")
# 设置面板能改的字段；其余字段（端口、claude 路径）只在安装时决定
EDITABLE = ("model", "vault", "folder", "extra_prompt", "open_after")


def load_config():
    if not os.path.exists(CONFIG):
        sys.exit("缺少 config.json，请先运行安装脚本")
    with open(CONFIG, encoding="utf-8") as f:
        cfg = json.load(f)
    cfg.setdefault("port", 17321)
    cfg.setdefault("folder", "B站总结")
    cfg.setdefault("model", "sonnet")
    cfg.setdefault("extra_prompt", "")
    cfg.setdefault("open_after", False)
    cfg.pop("deepseek_api_key", None)  # 旧版本存过 Key，现在 DeepSeek 走本地 opencode，不再需要
    # claude 和 opencode 装一个就能用，所以这里找不到也不退出
    cfg["claude"] = cfg.get("claude") or shutil.which("claude") or ""
    cfg["opencode"] = cfg.get("opencode") or shutil.which("opencode") or ""
    return cfg


CFG = load_config()
cfg_lock = threading.Lock()


def uses_opencode(model):
    """deepseek 开头，或写成 provider/model 的模型交给 opencode，其余交给 claude。"""
    return model.lower().startswith("deepseek") or "/" in model


def opencode_model(model):
    return model if "/" in model else "deepseek/" + model


def out_dir(cfg):
    return os.path.join(os.path.expanduser(cfg["vault"]), cfg["folder"])


def validate_settings(new):
    """检查设置面板提交的值，返回出错原因；没问题返回 None。"""
    if not re.fullmatch(r"[A-Za-z0-9.\-\[\]/]{1,64}", str(new.get("model", ""))):
        return "模型名不合法"
    vault = os.path.expanduser(str(new.get("vault", "")))
    if not os.path.isabs(vault) or not os.path.isdir(vault):
        return "Obsidian 库目录不存在"
    folder = str(new.get("folder", "")).strip()
    parts = re.split(r"[\\/]", folder)
    if not folder or os.path.isabs(folder) or ".." in parts:
        return "文件夹要写库里的相对路径，比如 B站总结 或 笔记/B站"
    if len(str(new.get("extra_prompt", ""))) > 2000:
        return "附加要求太长（最多 2000 字）"
    if uses_opencode(new["model"]) and not CFG["opencode"]:
        return "找不到 opencode 命令行：用 DeepSeek 要先安装 opencode 并配置 DeepSeek"
    if not uses_opencode(new["model"]) and not CFG["claude"]:
        return "找不到 claude 命令行：先安装 Claude Code，或改选 DeepSeek"
    return None


def save_settings(new):
    with cfg_lock:
        for k in EDITABLE:
            if k in new:
                CFG[k] = new[k]
        CFG["folder"] = CFG["folder"].strip().strip("/\\")
        CFG["open_after"] = bool(CFG["open_after"])
        with open(CONFIG, "w", encoding="utf-8") as f:
            json.dump(CFG, f, ensure_ascii=False, indent=2)


_ds_models = {"at": 0, "list": []}


def deepseek_models():
    """本机 opencode 里当前可用的 DeepSeek 模型名（不带 deepseek/ 前缀），缓存 10 分钟。"""
    if not CFG["opencode"]:
        return []
    if time.time() - _ds_models["at"] < 600 and _ds_models["list"]:
        return _ds_models["list"]
    try:
        r = subprocess.run([CFG["opencode"], "models", "deepseek"], stdin=subprocess.DEVNULL,
                           capture_output=True, text=True, encoding="utf-8", timeout=30, **NO_WINDOW)
        found = [ln.strip()[len("deepseek/"):] for ln in r.stdout.splitlines()
                 if ln.strip().startswith("deepseek/")]
    except Exception as e:  # noqa: BLE001 — 读不到列表就让面板只显示 Claude 模型和自定义
        log(f"读取 opencode 模型列表失败：{e}")
        found = []
    _ds_models.update(at=time.time(), list=found)
    return found


def summarize_claude(cfg, prompt):
    if not cfg["claude"]:
        raise RuntimeError("找不到 claude 命令行，先安装 Claude Code 或改用 DeepSeek")
    r = subprocess.run(
        [cfg["claude"], "-p", "--model", cfg["model"], "--output-format", "text"],
        input=prompt, capture_output=True, text=True, encoding="utf-8", timeout=900, **NO_WINDOW,
    )
    if r.returncode != 0 or not r.stdout.strip():
        raise RuntimeError("claude 失败：" + (r.stderr or r.stdout)[-300:])
    return r.stdout.strip()


def summarize_opencode(cfg, prompt, work):
    if not cfg["opencode"]:
        raise RuntimeError("找不到 opencode 命令行，先安装 opencode 并配置 DeepSeek")
    # 文字稿走附件而不是命令行参数：Windows 命令行最长只有 3 万多字
    path = os.path.join(work, "prompt.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write(prompt)
    r = subprocess.run(
        [cfg["opencode"], "run", "按附件里的要求写总结，只输出要求的内容",
         "--pure", "-m", opencode_model(cfg["model"]), "--format", "json", "--dir", work, "-f", path],
        stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding="utf-8",
        timeout=900, **NO_WINDOW,
    )
    texts, errors = [], []
    for line in r.stdout.splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        part = ev.get("part") or {}
        if part.get("type") == "text" and part.get("text"):
            texts.append(part["text"])
        if ev.get("type") == "error":
            errors.append(json.dumps(ev.get("error", ev), ensure_ascii=False))
    body = "".join(texts).strip()
    if r.returncode != 0 or errors or not body:
        detail = re.sub(r"\x1b\[[0-9;]*m", "", "; ".join(errors) or r.stderr or r.stdout)
        raise RuntimeError("opencode 失败：" + detail[-300:])
    return body

# macOS 后台进程没有 ~/Downloads 的访问权限，字幕缓存放在本目录
CACHE_DIR = os.path.join(HERE, "cache")
USERSCRIPT = "bili-summary.user.js"
LOG = open(os.path.join(HERE, "server.log"), "a", encoding="utf-8", buffering=1)

jobs = {}  # key -> {"state": queued|running|done|error, "msg": str, "file": str}
lock = threading.Lock()

PROMPT = """下面是一条 B 站视频的 AI 字幕文字稿（有错字和同音字，按上下文理解）。
请用中文写总结，严格按下面的格式输出，只输出这些内容，不要任何前言或解释：

TAGS: <3-6 个中文标签，逗号分隔>

**一句话**：<这条视频在讲什么，30 字以内>

## 主要内容
1. **<小标题>**：<2–3 句概括>
（按视频顺序，3–8 条）

## 结论 / 观点
- <作者的核心判断或结论，1–3 条>

要求：
- 用自己的话概括，不大段照抄原文；保留关键数字。
- 口播广告、"一键三连"之类不进总结。
- 吐槽、评测类视频保留作者的态度和评价，不要写成中性的百科介绍。
- 人名、术语拿不准就照写并标"（字幕原文）"。

{extra}
视频标题：{title}
UP 主：{up}

文字稿：
{text}
"""

WIN_TOAST = r"""
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$x = $t.GetElementsByTagName('text')
$x.Item(0).AppendChild($t.CreateTextNode($env:BILI_TITLE)) > $null
$x.Item(1).AppendChild($t.CreateTextNode($env:BILI_MSG)) > $null
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($t))
"""


def log(msg):
    LOG.write(f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S} {msg}\n")


def notify(title, msg):
    try:
        if IS_WIN:
            # 文字走环境变量，避免拼进脚本时的转义问题
            env = dict(os.environ, BILI_TITLE=title, BILI_MSG=msg)
            subprocess.run(["powershell", "-NoProfile", "-Command", WIN_TOAST],
                           env=env, capture_output=True, timeout=20, **NO_WINDOW)
        elif sys.platform == "darwin":
            q = lambda x: json.dumps(x, ensure_ascii=False)
            script = f"display notification {q(msg)} with title {q(title)}"
            subprocess.run(["osascript", "-e", script], capture_output=True, timeout=20)
    except Exception as e:  # noqa: BLE001 — 通知失败不影响主流程
        log(f"通知失败：{e}")


def open_in_obsidian(path):
    uri = "obsidian://open?path=" + urllib.parse.quote(path)
    try:
        if IS_WIN:
            os.startfile(uri)
        elif sys.platform == "darwin":
            subprocess.run(["open", uri], capture_output=True, timeout=20)
    except Exception as e:  # noqa: BLE001 — 打不开 Obsidian 不影响笔记已保存
        log(f"打开 Obsidian 失败：{e}")


def safe_name(s):
    # Windows 文件名不能含这些字符，也不能以点或空格结尾
    return re.sub(r'[\\/:*?"<>|\n\r\t]', "_", s).strip().rstrip(". ")[:120]


def video_info(bvid, p):
    req = urllib.request.Request(
        f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}",
        headers={"User-Agent": "Mozilla/5.0"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        d = json.loads(r.read().decode("utf-8"))["data"]
    title = d["title"]
    duration = d["duration"]
    if len(d["pages"]) > 1 and 1 <= p <= len(d["pages"]):
        page = d["pages"][p - 1]
        title = f"{title} P{p} {page['part']}"
        duration = page["duration"]
    return title, d["owner"]["name"], duration


def set_job(key, **kw):
    with lock:
        jobs.setdefault(key, {}).update(kw)


def run_job(key, bvid, p, url, sub_url):
    with cfg_lock:
        cfg = dict(CFG)  # 用点击那一刻的设置，任务进行中改设置不影响它
    try:
        set_job(key, state="running", msg="下载字幕")
        title, up, duration = video_info(bvid, p)
        name = safe_name(title)
        txt = os.path.join(CACHE_DIR, name + ".txt")
        r = subprocess.run(
            [sys.executable, "-I", os.path.join(HERE, "sub2txt.py"), sub_url, txt],
            capture_output=True, text=True, encoding="utf-8", timeout=60, **NO_WINDOW,
        )
        if r.returncode != 0:
            raise RuntimeError("字幕下载失败：" + r.stderr[-300:])
        with open(txt, encoding="utf-8") as f:
            text = f.read().replace("\n", " ")

        prompt = PROMPT.format(title=title, up=up, text=text,
                               extra="补充要求（优先遵守）：" + cfg["extra_prompt"].strip() + "\n"
                               if cfg["extra_prompt"].strip() else "")
        if uses_opencode(cfg["model"]):
            set_job(key, msg="DeepSeek 正在总结")
            work = os.path.join(CACHE_DIR, "opencode", key)
            os.makedirs(work, exist_ok=True)
            body = summarize_opencode(cfg, prompt, work)
        else:
            set_job(key, msg="Claude 正在总结")
            body = summarize_claude(cfg, prompt)

        tags = ["B站总结"]
        m = re.match(r"\s*TAGS[:：]\s*(.+)", body)
        if m:
            tags += [t.strip() for t in re.split(r"[,，、]", m.group(1)) if t.strip()]
            body = body[m.end():].strip()

        dur = f"{duration // 60}:{duration % 60:02d}"
        today = datetime.date.today().isoformat()
        note = (
            "---\n"
            f"tags: [{', '.join(tags)}]\n"
            f"up: {json.dumps(up, ensure_ascii=False)}\n"
            f"url: {url}\n"
            f'duration: "{dur}"\n'
            f"date: {today}\n"
            "---\n\n"
            f"# {title}\n\n"
            f"UP 主：{up} ｜ 时长：{dur} ｜ 链接：{url}\n\n"
            f"{body}\n"
        )
        os.makedirs(out_dir(cfg), exist_ok=True)
        out = os.path.join(out_dir(cfg), name + ".md")
        with open(out, "w", encoding="utf-8") as f:
            f.write(note)
        set_job(key, state="done", msg="已保存", file=out)
        log(f"完成 {key} -> {out}")
        notify("B站总结完成", title)
        if cfg["open_after"]:
            open_in_obsidian(out)
    except Exception as e:  # noqa: BLE001 — 任何失败都要回报给按钮
        set_job(key, state="error", msg=str(e)[:300])
        log(f"失败 {key}：{e}")
        notify("B站总结失败", str(e)[:200])


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _allowed(self):
        return self.headers.get("X-Bili-Summary") == "1"

    def do_GET(self):
        # 油猴脚本本身是公开代码，不需要校验头；浏览器打开这个地址时 Tampermonkey
        # 会弹出安装页，之后也按脚本里的 @updateURL 从这里自动更新
        if self.path == "/" + USERSCRIPT:
            with open(os.path.join(HERE, USERSCRIPT), encoding="utf-8") as f:
                data = f.read().replace("127.0.0.1:17321", f"127.0.0.1:{CFG['port']}").encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if not self._allowed():
            return self._send(403, {"error": "forbidden"})
        if self.path == "/health":
            # dir 让安装脚本确认应答的是刚装好的这一份，而不是别的目录里没停掉的旧服务
            return self._send(200, {"ok": True, "dir": HERE, "out_dir": out_dir(CFG), "model": CFG["model"]})
        if self.path == "/config":
            from setup_config import obsidian_vaults
            with cfg_lock:
                cur = {k: CFG[k] for k in EDITABLE}
            vaults = obsidian_vaults()
            if cur["vault"] not in vaults:
                vaults.insert(0, cur["vault"])
            return self._send(200, dict(cur, vaults=vaults, has_claude=bool(CFG["claude"]),
                                        has_opencode=bool(CFG["opencode"]),
                                        deepseek_models=deepseek_models()))
        if self.path.startswith("/hello"):
            # 油猴脚本每次在 B 站页面运行时报到一次版本，安装脚本据此决定要不要再打开安装页
            v = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("v", [""])[0]
            if re.fullmatch(r"\d+(\.\d+){0,3}", v):
                os.makedirs(CACHE_DIR, exist_ok=True)
                with open(os.path.join(CACHE_DIR, "userscript_seen.json"), "w", encoding="utf-8") as f:
                    json.dump({"version": v, "at": datetime.datetime.now().isoformat(timespec="seconds")}, f)
            return self._send(200, {"ok": True})
        if self.path.startswith("/status"):
            key = self.path.partition("key=")[2]
            with lock:
                job = dict(jobs.get(key, {"state": "none"}))
            return self._send(200, job)
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._allowed() or self.path not in ("/summarize", "/config"):
            return self._send(403, {"error": "forbidden"})
        req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path == "/config":
            with cfg_lock:
                new = dict({k: CFG[k] for k in EDITABLE}, **{k: req[k] for k in EDITABLE if k in req})
            err = validate_settings(new)
            if err:
                return self._send(400, {"error": err})
            save_settings(new)
            log(f"设置已更新：模型 {CFG['model']}，输出到 {out_dir(CFG)}")
            return self._send(200, {"ok": True, "out_dir": out_dir(CFG)})
        bvid, p = req["bvid"], int(req.get("p", 1))
        sub_url = req["subtitle_url"]
        if not re.fullmatch(r"BV[0-9A-Za-z]{10}", bvid) or "aisubtitle.hdslb.com" not in sub_url:
            return self._send(400, {"error": "bad request"})
        key = f"{bvid}-{p}"
        with lock:
            if jobs.get(key, {}).get("state") in ("queued", "running"):
                return self._send(200, {"key": key, "state": "running"})
            jobs[key] = {"state": "queued", "msg": "排队中"}
        url = f"https://www.bilibili.com/video/{bvid}/" + (f"?p={p}" if p > 1 else "")
        threading.Thread(target=run_job, args=(key, bvid, p, url, sub_url), daemon=True).start()
        log(f"收到 {key}")
        self._send(202, {"key": key, "state": "queued"})

    def log_message(self, fmt, *args):
        pass  # 轮询状态的请求太多，不记访问日志


if __name__ == "__main__":
    log(f"启动，端口 {CFG['port']}，输出到 {out_dir(CFG)}")
    ThreadingHTTPServer(("127.0.0.1", CFG["port"]), Handler).serve_forever()
