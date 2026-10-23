"""B站字幕 JSON -> 纯文本。

用法: python3 -I sub2txt.py <字幕URL或本地json> <输出.txt> [--para SECONDS] [--keep-json]

  --para N     每 N 秒合并成一段，段首带 [mm:ss] 时间戳（给知识点提取用，比逐行省 token）
  --keep-json  另存一份原始字幕 json（同名 .json）

只打印统计信息，不打印正文，避免字幕内容进入对话上下文。
"""
import json
import os
import sys
import urllib.request


def load(src):
    if os.path.exists(src):
        with open(src, encoding="utf-8") as f:
            return json.load(f)
    if src.startswith("//"):
        src = "https:" + src
    req = urllib.request.Request(src, headers={
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://www.bilibili.com",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def stamp(sec):
    sec = int(sec)
    if sec >= 3600:
        return f"{sec // 3600}:{sec % 3600 // 60:02d}:{sec % 60:02d}"
    return f"{sec // 60:02d}:{sec % 60:02d}"


def paragraphs(body, span):
    out, cur, start = [], [], None
    for x in body:
        if start is None:
            start = x["from"]
        cur.append(x["content"])
        if x["to"] - start >= span:
            out.append(f"[{stamp(start)}] " + " ".join(cur))
            cur, start = [], None
    if cur:
        out.append(f"[{stamp(start)}] " + " ".join(cur))
    return out


def main():
    argv = sys.argv[1:]
    para = None
    if "--para" in argv:
        i = argv.index("--para")
        para = float(argv[i + 1])
        del argv[i:i + 2]
    keep_json = "--keep-json" in argv
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 2:
        sys.exit(__doc__)
    src, out = args
    data = load(src)
    body = data["body"]
    lines = paragraphs(body, para) if para else [x["content"] for x in body]
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    if keep_json:
        with open(os.path.splitext(out)[0] + ".json", "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
    chars = sum(len(x["content"]) for x in body)
    end = round(body[-1]["to"]) if body else 0
    print(f"{out}: {len(lines)} lines, {chars} chars, ends at {end}s")


if __name__ == "__main__":
    main()
