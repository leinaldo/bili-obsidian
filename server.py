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
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
IS_WIN = sys.platform == "win32"
# Windows 下后台运行时不要弹出黑色控制台窗口
NO_WINDOW = {"creationflags": subprocess.CREATE_NO_WINDOW} if IS_WIN else {}


def load_config():
    path = os.path.join(HERE, "config.json")
    if not os.path.exists(path):
        sys.exit("缺少 config.json，请先运行安装脚本")
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    cfg.setdefault("port", 17321)
    cfg.setdefault("folder", "B站总结")
    cfg.setdefault("model", "sonnet")
    cfg["claude"] = cfg.get("claude") or shutil.which("claude")
    if not cfg["claude"]:
        sys.exit("找不到 claude 命令行，请在 config.json 里填写 claude 的完整路径")
    return cfg


CFG = load_config()
OUT_DIR = os.path.join(os.path.expanduser(CFG["vault"]), CFG["folder"])
# macOS 后台进程没有 ~/Downloads 的访问权限，字幕缓存放在本目录
CACHE_DIR = os.path.join(HERE, "cache")
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

        set_job(key, msg="Claude 正在总结")
        r = subprocess.run(
            [CFG["claude"], "-p", "--model", CFG["model"], "--output-format", "text"],
            input=PROMPT.format(title=title, up=up, text=text),
            capture_output=True, text=True, encoding="utf-8", timeout=900, **NO_WINDOW,
        )
        if r.returncode != 0 or not r.stdout.strip():
            raise RuntimeError("claude 失败：" + (r.stderr or r.stdout)[-300:])
        body = r.stdout.strip()

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
        os.makedirs(OUT_DIR, exist_ok=True)
        out = os.path.join(OUT_DIR, name + ".md")
        with open(out, "w", encoding="utf-8") as f:
            f.write(note)
        set_job(key, state="done", msg="已保存", file=out)
        log(f"完成 {key} -> {out}")
        notify("B站总结完成", title)
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
        if not self._allowed():
            return self._send(403, {"error": "forbidden"})
        if self.path == "/health":
            return self._send(200, {"ok": True, "out_dir": OUT_DIR, "model": CFG["model"]})
        if self.path.startswith("/status"):
            key = self.path.partition("key=")[2]
            with lock:
                job = dict(jobs.get(key, {"state": "none"}))
            return self._send(200, job)
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._allowed() or self.path != "/summarize":
            return self._send(403, {"error": "forbidden"})
        req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
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
    log(f"启动，端口 {CFG['port']}，输出到 {OUT_DIR}")
    ThreadingHTTPServer(("127.0.0.1", CFG["port"]), Handler).serve_forever()
