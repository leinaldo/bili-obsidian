"""视频没有 AI 字幕时，下载音频并用 faster-whisper 转成文字稿。

用法: asr-venv/bin/python -I asr.py <BV号> <分P> <输出.txt> [--model small]

由 bili_host.py 用 asr-venv 里的 Python 调用。进度按行打印到标准输出：
  STAGE <说明>   PROGRESS <0-100>
其余输出都当日志。

输出和扩展里整理字幕的格式一致：约每 30 秒一段，段首带 [mm:ss]，模型据此写原片跳转。
"""
import json
import os
import sys
import urllib.request

H = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com"}


def say(*a):
    print(*a, flush=True)


def get_json(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=H), timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))


def audio_urls(bvid, p):
    pages = get_json(f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}")["data"]["pages"]
    cid = pages[min(max(p, 1), len(pages)) - 1]["cid"]
    d = get_json(f"https://api.bilibili.com/x/player/playurl?bvid={bvid}&cid={cid}&fnval=16")
    audios = ((d.get("data") or {}).get("dash") or {}).get("audio") or []
    if not audios:
        raise RuntimeError("拿不到音频流：" + str(d.get("message")))
    # 转写只需要最低码率；同一条流的主地址偶尔连不上，备用地址都试一遍
    a = min(audios, key=lambda x: x["bandwidth"])
    return [a["baseUrl"], *(a.get("backupUrl") or [])]


def fetch(url, path, progress=False):
    with urllib.request.urlopen(urllib.request.Request(url, headers=H), timeout=30) as r, \
            open(path, "wb") as f:
        total, done, shown = int(r.headers.get("Content-Length") or 0), 0, -1
        while chunk := r.read(1 << 16):
            f.write(chunk)
            done += len(chunk)
            if progress and total and done * 100 // total != shown:
                shown = done * 100 // total
                say(f"PROGRESS {shown}")


def download(urls, path):
    last = None
    for u in urls:
        try:
            return fetch(u, path)
        except OSError as e:
            last = e
    raise RuntimeError(f"音频下载失败：{last}")


def model_path(name, root):
    """返回本地模型目录；本地没有就从 ModelScope 下载。

    国内基本连不上 huggingface.co，所以先走 ModelScope（pengzhendong 的仓库是 Systran 原版的镜像）。
    ModelScope 上没有这个模型时返回模型名，交给 faster-whisper 自己从 Hugging Face 下载。
    """
    local = os.path.join(root, name)
    if os.path.exists(os.path.join(local, "model.bin")):
        return local
    repo = f"https://www.modelscope.cn/api/v1/models/pengzhendong/faster-whisper-{name}"
    try:
        files = get_json(repo + "/repo/files?Revision=master")["Data"]["Files"]
    except (OSError, KeyError, TypeError, ValueError):
        return name
    os.makedirs(local, exist_ok=True)
    # model.bin 最后下载：它存在就说明整个目录下完了
    names = sorted((f["Path"] for f in files if f["Path"].endswith((".json", ".txt", ".bin"))
                    and f["Path"] != "configuration.json"), key=lambda n: n == "model.bin")
    for n in names:
        if n == "model.bin":
            say(f"STAGE 下载转写模型 {name}（只需一次）")
        tmp = os.path.join(local, n + ".part")
        fetch(f"https://www.modelscope.cn/models/pengzhendong/faster-whisper-{name}/resolve/master/{n}",
              tmp, progress=n == "model.bin")
        os.replace(tmp, os.path.join(local, n))
    return local


def main():
    argv = sys.argv[1:]
    model = "small"
    if "--model" in argv:
        i = argv.index("--model")
        model = argv[i + 1]
        del argv[i:i + 2]
    bvid, p, out = argv[0], int(argv[1]), argv[2]
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    audio = os.path.splitext(out)[0] + ".m4a"

    say("STAGE 下载音频")
    download(audio_urls(bvid, p), audio)
    try:
        say("STAGE 加载转写模型")
        root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
        path = model_path(model, root)
        from faster_whisper import WhisperModel
        # 线程数用默认值：实测 M4 Pro 上开满核心反而慢好几倍（大小核混用、线程争抢）
        wm = WhisperModel(path, device="cpu", compute_type="int8", download_root=root)
        # initial_prompt 让 Whisper 输出简体中文并带标点，否则常出繁体、整段无标点
        segs, info = wm.transcribe(audio, language="zh", vad_filter=True,
                                   initial_prompt="以下是普通话的句子，使用简体中文。")
        say("STAGE 转写音频")
        lines, cur, start = [], [], None
        for s in segs:
            if start is None:
                start = s.start
            cur.append(s.text.strip())
            if s.end - start >= 30:
                lines.append(f"[{stamp(start)}] " + " ".join(cur))
                cur, start = [], None
            say(f"PROGRESS {min(99, int(s.end * 100 / max(info.duration, 1)))}")
        if cur:
            lines.append(f"[{stamp(start)}] " + " ".join(cur))
    finally:
        os.remove(audio)
    if not lines:
        raise RuntimeError("没识别出语音")
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    say(f"DONE {len(lines)} lines, {sum(map(len, lines))} chars")


def stamp(sec):
    sec = int(sec)
    if sec >= 3600:
        return f"{sec // 3600}:{sec % 3600 // 60:02d}:{sec % 60:02d}"
    return f"{sec // 60:02d}:{sec % 60:02d}"


if __name__ == "__main__":
    main()
