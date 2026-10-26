// B 站数据：视频信息、字幕整理成带时间戳的段落

export async function videoInfo(bvid, p) {
  const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
  const j = await r.json();
  if (j.code !== 0) throw new Error('读取视频信息失败：' + j.message);
  const d = j.data;
  let title = d.title, duration = d.duration;
  if (d.pages.length > 1 && p >= 1 && p <= d.pages.length) {
    const page = d.pages[p - 1];
    title = `${title} P${p} ${page.part}`;
    duration = page.duration;
  }
  return {
    title, duration, up: d.owner.name, desc: (d.desc || '').slice(0, 300),
    cover: (d.pic || '').replace(/^http:/, 'https:'),
    url: `https://www.bilibili.com/video/${bvid}/` + (p > 1 ? `?p=${p}` : ''),
  };
}

export function stamp(sec) {
  sec = Math.floor(sec);
  const two = n => String(n).padStart(2, '0');
  return sec >= 3600 ? `${Math.floor(sec / 3600)}:${two(Math.floor(sec % 3600 / 60))}:${two(sec % 60)}`
    : `${two(Math.floor(sec / 60))}:${two(sec % 60)}`;
}

export const parseStamp = s => s.split(':').map(Number).reduce((a, n) => a * 60 + n, 0);

// 约每 30 秒合并成一段，段首带 [mm:ss]：比逐句省 token，模型也能据此写原片跳转。
// 本地转写（host/asr.py）输出同样的格式
export async function subtitleText(url) {
  const r = await fetch(url.startsWith('//') ? 'https:' + url : url);
  const body = (await r.json()).body || [];
  if (!body.length) throw new Error('字幕是空的');
  const out = [];
  let cur = [], start = null;
  for (const x of body) {
    if (start === null) start = x.from;
    cur.push(x.content);
    if (x.to - start >= 30) {
      out.push(`[${stamp(start)}] ` + cur.join(' '));
      cur = []; start = null;
    }
  }
  if (cur.length) out.push(`[${stamp(start)}] ` + cur.join(' '));
  return out.join('\n');
}
