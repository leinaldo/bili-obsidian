"""bili-obsidian 的本地服务（Chrome Native Messaging host）。

浏览器扩展通过 chrome.runtime.connectNative 启动它。每条消息是 4 字节本机字节序长度
+ UTF-8 JSON。扩展断开连接时浏览器会关掉它，
所以它不常驻后台、不监听端口。只有 manifest 里 allowed_origins 列出的扩展能启动它。

请求：{"id": ..., "cmd": ..., ...}
回复：{"id": ..., "type": "progress", "msg": ...}（可多条）
      {"id": ..., "type": "result", ...} 或 {"id": ..., "type": "error", "error": ...}
"""
import glob
import json
import os
import re
import shlex
import shutil
import struct
import subprocess
import sys
import tempfile
import traceback
import urllib.parse

VERSION = "1.0.0"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
IS_WIN = sys.platform == "win32"
NO_WINDOW = {"creationflags": subprocess.CREATE_NO_WINDOW} if IS_WIN else {}
ASR_PY = os.path.join(ROOT, "asr-venv", "Scripts" if IS_WIN else "bin", "python.exe" if IS_WIN else "python")
WORK = os.path.join(ROOT, "cache")
LOG = os.path.join(ROOT, "host.log")
# 安装脚本在登录 shell 里查到的命令行路径；浏览器启动本服务时 PATH 很短，查不到 nvm、Homebrew 里的命令
CLI_PATHS = os.path.join(ROOT, "clis.json")
MODEL_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/\-\[\]]{0,99}")
INSTRUCT = "按标准输入里的要求完成任务，只输出要求的内容"


def log(msg):
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(msg.rstrip() + "\n")
    except OSError:
        pass


# ---------- Native Messaging 收发 ----------

if IS_WIN:
    import msvcrt
    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)


def read_msg():
    head = sys.stdin.buffer.read(4)
    if len(head) < 4:
        return None
    size = struct.unpack("=I", head)[0]
    return json.loads(sys.stdin.buffer.read(size).decode("utf-8"))


def send(obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(data)) + data)
    sys.stdout.buffer.flush()


# ---------- 找命令行 ----------

def extra_dirs():
    home = os.path.expanduser("~")
    dirs = [os.path.join(home, ".local", "bin"), os.path.join(home, ".opencode", "bin"),
            os.path.join(home, ".bun", "bin"), os.path.join(home, ".npm-global", "bin"),
            os.path.join(home, ".volta", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]
    if IS_WIN:
        dirs += [os.path.join(os.environ.get("APPDATA", ""), "npm"),
                 os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs")]
    # nvm 装的 node 命令行：新版本排前面
    dirs += sorted(glob.glob(os.path.join(home, ".nvm", "versions", "node", "*", "bin")), reverse=True)
    return [d for d in dirs if os.path.isdir(d)]


def search_path():
    return os.pathsep.join(extra_dirs() + [os.environ.get("PATH", "")])


def find_bin(name):
    try:
        with open(CLI_PATHS, encoding="utf-8") as f:
            p = json.load(f).get(name)
        if p and os.path.exists(p):
            return p
    except (OSError, ValueError):
        pass
    return shutil.which(name, path=search_path())


def cli_env(binary):
    # node 写的命令行用 #!/usr/bin/env node，要让它找得到同目录下的 node
    return dict(os.environ, PATH=os.path.dirname(binary) + os.pathsep + search_path(), NO_COLOR="1")


# ---------- 各家 agent 命令行 ----------
# 每个命令行的调用方式写死在这里，扩展只传命令行名、模型名和提示词，不能传任意参数。
# 提示词一律走标准输入：Windows 命令行最长只有 3 万多字，放不下字幕全文。
# 字幕和简介由视频作者控制，可能藏着针对 agent 的指令，所以能关掉工具的命令行都关掉工具。

def run(cmd, prompt, cwd, timeout=900, env=None):
    r = subprocess.run(cmd, input=prompt, capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=timeout, cwd=cwd, env=dict(cli_env(cmd[0]), **(env or {})),
                       **NO_WINDOW)
    if r.returncode != 0:
        detail = re.sub(r"\x1b\[[0-9;]*m", "", r.stderr or r.stdout).strip()
        raise RuntimeError(f"{os.path.basename(cmd[0])} 失败：{detail[-400:]}")
    return r.stdout


def cli_claude(b, model, prompt, work):
    # --tools "" 关掉全部内置工具；--strict-mcp-config 且不给 --mcp-config，就不加载任何 MCP 工具
    return run([b, "-p", "--output-format", "text", "--tools", "", "--strict-mcp-config"]
               + (["--model", model] if model else []), prompt, work)


def cli_codex(b, model, prompt, work):
    out = os.path.join(work, "last.txt")
    # codex 没有关掉 shell 的开关。read-only 沙盒禁止写文件和联网，但仍能读本机文件，只能靠提示词约束。
    # --ignore-user-config：不跑用户配置里的 hooks，也不受配置里失效的默认模型影响
    run([b, "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "-s", "read-only",
         "--color", "never", "-o", out] + (["-m", model] if model else []) + ["-"], prompt, work)
    with open(out, encoding="utf-8") as f:
        return f.read()


def cli_opencode(b, model, prompt, work):
    # opencode run 不读标准输入，提示词作为附件传；v2 去掉了 --dir，工作目录就是 cwd
    path = os.path.join(work, "prompt.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write(prompt)
    # opencode 默认允许执行命令。拒绝全部权限的配置只对 --standalone 生效：
    # 不加它时任务交给后台常驻服务，那个服务用的是它启动时读到的配置
    cfg = os.path.join(work, "opencode.json")
    with open(cfg, "w", encoding="utf-8") as f:
        json.dump({"permission": {"*": "deny"}}, f)
    out = run([b, "run", "--standalone", "按附件里的要求完成任务，只输出要求的内容", "--format", "json", "-f", path]
              + (["-m", model] if model else []), "", work, env={"OPENCODE_CONFIG": cfg})
    texts, errors = [], []
    for line in out.splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        part = ev.get("part") or {}
        if part.get("type") == "text" and part.get("text"):
            texts.append(part["text"])
        if ev.get("type") == "error":
            errors.append(json.dumps(ev.get("error", ev), ensure_ascii=False))
    if errors:
        raise RuntimeError("opencode 失败：" + "; ".join(errors)[-400:])
    return "".join(texts)


def cli_gemini_like(b, model, prompt, work):
    # gemini 和 qwen（gemini-cli 的分支）的无头模式：-p 给指令，标准输入的内容会接在后面
    return run([b, "-p", INSTRUCT] + (["-m", model] if model else []), prompt, work)


CLIS = {
    "claude": ("Claude Code", cli_claude),
    "codex": ("Codex", cli_codex),
    "opencode": ("opencode", cli_opencode),
    "gemini": ("Gemini CLI", cli_gemini_like),
    "qwen": ("Qwen Code", cli_gemini_like),
}


def cli_models(cli, binary):
    """能读到的模型列表，读不到返回空，扩展里可以手填。"""
    try:
        if cli == "opencode":
            r = subprocess.run([binary, "models"], capture_output=True, text=True, encoding="utf-8",
                               timeout=30, stdin=subprocess.DEVNULL, env=cli_env(binary), **NO_WINDOW)
            return [ln.strip() for ln in r.stdout.splitlines() if "/" in ln.strip()][:200]
        if cli == "codex":
            with open(os.path.expanduser("~/.codex/models_cache.json"), encoding="utf-8") as f:
                d = json.load(f)
            return [m.get("slug") or m.get("id") for m in d.get("models", []) if m.get("slug") or m.get("id")]
        if cli == "claude":
            return ["sonnet", "opus", "haiku"]
    except Exception as e:  # noqa: BLE001 — 列表只是方便选择
        log(f"读取 {cli} 模型列表失败：{e}")
    return []


# ---------- 命令 ----------

def cmd_hello(req, progress):
    from vaults import obsidian_vaults
    clis = []
    for cid, (name, _) in CLIS.items():
        b = find_bin(cid)
        if b:
            clis.append({"id": cid, "name": name, "path": b, "models": cli_models(cid, b)})
    asr_models = sorted(d for d in os.listdir(os.path.join(HERE, "models"))
                        if os.path.exists(os.path.join(HERE, "models", d, "model.bin"))) \
        if os.path.isdir(os.path.join(HERE, "models")) else []
    return {"version": VERSION, "platform": sys.platform, "clis": clis,
            "asr": os.path.exists(ASR_PY), "asr_models": asr_models, "vaults": obsidian_vaults()}


def cmd_run_cli(req, progress):
    cli, model, prompt = req["cli"], str(req.get("model") or ""), req["prompt"]
    if model and not MODEL_RE.fullmatch(model):
        raise ValueError("模型名不合法")
    os.makedirs(WORK, exist_ok=True)
    work = tempfile.mkdtemp(prefix="cli-", dir=WORK)
    try:
        if cli == "custom":
            # 设置页里填的自定义命令：提示词走标准输入，标准输出就是笔记
            cmd = shlex.split(req["command"], posix=not IS_WIN)
            if not cmd:
                raise ValueError("自定义命令是空的")
            b = cmd[0] if os.path.isabs(cmd[0]) else find_bin(cmd[0])
            if not b:
                raise RuntimeError(f"找不到命令 {cmd[0]}")
            text = run([b] + cmd[1:], prompt, work)
        else:
            if cli not in CLIS:
                raise ValueError(f"不支持的命令行：{cli}")
            b = find_bin(cli)
            if not b:
                raise RuntimeError(f"本机没找到 {cli}。装好后重新运行安装脚本")
            progress(f"{CLIS[cli][0]} 正在总结")
            text = CLIS[cli][1](b, model, prompt, work)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    if not text.strip():
        raise RuntimeError(f"{cli} 没有输出内容")
    return {"text": text.strip()}


def cmd_transcribe(req, progress):
    bvid, p, model = req["bvid"], int(req.get("p") or 1), str(req.get("model") or "small")
    if not re.fullmatch(r"BV[0-9A-Za-z]{10}", bvid) or not MODEL_RE.fullmatch(model):
        raise ValueError("参数不合法")
    if not os.path.exists(ASR_PY):
        raise RuntimeError("这个视频没有字幕，转写组件没装好：重新运行安装脚本")
    os.makedirs(WORK, exist_ok=True)
    out = os.path.join(WORK, f"{bvid}-{p}.txt")
    proc = subprocess.Popen([ASR_PY, "-I", os.path.join(HERE, "asr.py"), bvid, str(p), out, "--model", model],
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace", **NO_WINDOW)
    stage, tail = "转写音频", []
    for line in proc.stdout:
        line = line.rstrip()
        if line.startswith("STAGE "):
            stage = line[6:]
            progress(stage)
        elif line.startswith("PROGRESS "):
            progress(f"{stage} {line[9:]}%")
        elif line:
            tail = (tail + [line])[-5:]
    if proc.wait() != 0:
        raise RuntimeError("音频转写失败：" + "\n".join(tail)[-400:])
    with open(out, encoding="utf-8") as f:
        text = f.read()
    os.remove(out)
    return {"text": text}


def safe_name(s):
    # Windows 文件名不能含这些字符，也不能以点或空格结尾
    return re.sub(r'[\\/:*?"<>|\n\r\t]', "_", s).strip().rstrip(". ")[:120] or "untitled"


def cmd_save_file(req, progress):
    folder = os.path.expanduser(str(req["dir"]))
    if not os.path.isabs(folder):
        raise ValueError("保存目录要写完整路径")
    if not os.path.isdir(folder):
        # 只补建最后一层，比如库里的「B站总结」；库本身不存在多半是路径填错了
        if not os.path.isdir(os.path.dirname(folder.rstrip("/\\"))):
            raise ValueError(f"目录不存在：{folder}")
        os.makedirs(folder)
    ext = req.get("ext", "md") if req.get("ext") in ("md", "html") else "md"
    path = os.path.join(folder, safe_name(req["name"]) + "." + ext)
    with open(path, "w", encoding="utf-8") as f:
        f.write(req["content"])
    if req.get("open_obsidian"):
        open_uri("obsidian://open?path=" + urllib.parse.quote(path))
    return {"path": path}


def open_uri(uri):
    if IS_WIN:
        os.startfile(uri)
    elif sys.platform == "darwin":
        subprocess.run(["open", uri], capture_output=True, timeout=20)
    else:
        subprocess.run(["xdg-open", uri], capture_output=True, timeout=20)


def cmd_pick_folder(req, progress):
    if sys.platform == "darwin":
        r = subprocess.run(["osascript", "-e", 'POSIX path of (choose folder with prompt "选择保存笔记的文件夹")'],
                           capture_output=True, text=True, timeout=300)
    elif IS_WIN:
        ps = ("Add-Type -AssemblyName System.Windows.Forms;"
              "$d = New-Object System.Windows.Forms.FolderBrowserDialog;"
              "if ($d.ShowDialog() -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; $d.SelectedPath }")
        r = subprocess.run(["powershell", "-NoProfile", "-STA", "-Command", ps],
                           capture_output=True, text=True, encoding="utf-8", timeout=300, **NO_WINDOW)
    else:
        raise RuntimeError("这个系统不支持选择文件夹，请手动填写路径")
    return {"path": r.stdout.strip().rstrip("/\\") or None}


COMMANDS = {"hello": cmd_hello, "run_cli": cmd_run_cli, "transcribe": cmd_transcribe,
            "save_file": cmd_save_file, "pick_folder": cmd_pick_folder}


def main():
    sys.path.insert(0, HERE)
    while True:
        req = read_msg()
        if req is None:
            return
        rid = req.get("id")
        try:
            fn = COMMANDS.get(req.get("cmd"))
            if not fn:
                raise ValueError(f"未知命令：{req.get('cmd')}")
            res = fn(req, lambda msg: send({"id": rid, "type": "progress", "msg": msg}))
            send(dict(res, id=rid, type="result"))
        except Exception as e:  # noqa: BLE001 — 任何失败都要回给扩展，否则扩展那边会一直等
            log(traceback.format_exc())
            send({"id": rid, "type": "error", "error": str(e)[:500]})


if __name__ == "__main__":
    main()
