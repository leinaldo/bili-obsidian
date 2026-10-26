// B 站视频页上的悬浮按钮：拿 AI 字幕地址，交给后台总结，显示进度
(() => {
  'use strict';
  const LABEL = '总结视频';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const bvid = () => location.pathname.match(/BV[0-9A-Za-z]{10}/)?.[0] || '';
  const page = () => Number(new URLSearchParams(location.search).get('p') || 1);
  const videoKey = () => `${bvid()}-${page()}`;

  // B 站页面请求很多，资源记录满了以后新的字幕请求不会被记下来，
  // 所以从页面一开始就监听字幕请求，并记下它属于哪个视频
  let captured = null;
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) {
      if (e.name.includes('aisubtitle.hdslb.com')) captured = { key: videoKey(), url: e.name };
    }
  }).observe({ type: 'resource', buffered: true });

  // 界面放进 Shadow DOM，B 站的样式影响不到它，它也不影响 B 站
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  .dock { position: fixed; z-index: 2147483000; display: flex; gap: 6px; align-items: center; }
  button { border: none; cursor: pointer; font-size: 14px; }
  .main { padding: 10px 16px; border-radius: 20px; background: #7c3aed; color: #fff; max-width: 340px;
          overflow: hidden; text-overflow: ellipsis; box-shadow: 0 2px 8px rgba(0,0,0,.25); white-space: nowrap; touch-action: none; }
  .main.busy { opacity: .8; cursor: progress; }
  .main.err { background: #e5484d; }
  .main.ok { background: #16a34a; }
  .gear { width: 34px; height: 34px; border-radius: 50%; background: #fff; color: #7c3aed;
          box-shadow: 0 2px 8px rgba(0,0,0,.2); font-size: 17px; line-height: 34px; padding: 0; }
</style>
<div class="dock">
  <button class="main" title="点击开始总结；按住可以拖动位置">${LABEL}</button>
  <button class="gear" title="设置">⚙</button>
</div>`;
  const $ = s => root.querySelector(s);
  const dock = $('.dock'), btn = $('.main');
  const mount = () => document.body.appendChild(host);
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  // ---------- 按钮位置：可拖动，记住位置 ----------
  function place(pos) {
    const p = pos || { right: 24, bottom: 24 };
    Object.assign(dock.style, { right: p.right + 'px', bottom: p.bottom + 'px' });
  }
  chrome.storage.local.get('buttonPos').then(r => place(r.buttonPos));

  let drag = null, dragged = false;
  btn.addEventListener('pointerdown', e => {
    const r = dock.getBoundingClientRect();
    drag = { x: e.clientX, y: e.clientY, right: innerWidth - r.right, bottom: innerHeight - r.bottom };
    dragged = false;
    btn.setPointerCapture(e.pointerId);
  });
  btn.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!dragged && Math.hypot(dx, dy) < 5) return;
    dragged = true;
    place({
      right: Math.min(Math.max(drag.right - dx, 0), innerWidth - dock.offsetWidth),
      bottom: Math.min(Math.max(drag.bottom - dy, 0), innerHeight - dock.offsetHeight),
    });
  });
  btn.addEventListener('pointerup', () => {
    if (dragged) chrome.storage.local.set({ buttonPos: { right: parseFloat(dock.style.right), bottom: parseFloat(dock.style.bottom) } });
    drag = null;
  });
  $('.gear').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openOptions' }));

  // ---------- 按钮状态 ----------
  let state = 'idle', resetTimer = null;
  function show(job) {
    clearTimeout(resetTimer);
    state = job?.state || 'idle';
    btn.className = 'main' + ({ running: ' busy', error: ' err', done: ' ok' }[state] || '');
    if (state === 'running') btn.textContent = job.msg + '…';
    else if (state === 'error') btn.textContent = '✗ ' + job.msg;
    else if (state === 'done') {
      const failed = (job.exports || []).filter(x => !x.ok);
      btn.textContent = failed.length ? `✓ 已生成，${failed.map(x => x.name).join('、')}导出失败 · 查看` : '✓ 已完成 · 查看笔记';
    } else btn.textContent = LABEL;
    btn.title = state === 'error' ? job.msg : '点击开始总结；按住可以拖动位置';
    if (state === 'error') resetTimer = setTimeout(() => show(null), 10000);
  }
  chrome.runtime.onMessage.addListener((m, _, reply) => {
    if (m.type === 'job' && m.key === videoKey()) show(m.job);
    if (m.type === 'start') {
      start().then(reply, e => reply({ error: e.message }));
      return true;
    }
  });
  // 换了视频（B 站切换视频不刷新页面）按钮回到初始状态，或者显示那个视频正在进行的任务
  let lastKey = videoKey();
  setInterval(() => {
    if (videoKey() === lastKey) return;
    lastKey = videoKey();
    chrome.runtime.sendMessage({ type: 'job', key: lastKey }).then(show);
  }, 1000);
  chrome.runtime.sendMessage({ type: 'job', key: lastKey }).then(show);

  // ---------- 拿字幕 ----------
  // 让播放器自己加载 AI 字幕（页面已登录，请求会带 cookie），再从资源记录里取地址
  async function subtitleUrl() {
    const key = videoKey();
    const find = () => captured?.key === key ? captured.url : null;
    if (find()) return find();
    let items = [], unlogin = false;
    for (let i = 0; i < 10 && !items.length; i++) {
      const b = document.querySelector('.bpx-player-ctrl-subtitle');
      for (const t of ['mouseenter', 'mouseover']) b?.dispatchEvent(new MouseEvent(t, { bubbles: true }));
      await sleep(800);
      unlogin = !!b?.innerText.includes('登录可享');
      items = [...document.querySelectorAll('.bpx-player-ctrl-subtitle-language-item')];
    }
    if (unlogin) throw new Error('播放器未登录');
    if (!items.length) throw new Error('这个视频没有 AI 字幕');
    (items.find(e => e.textContent.includes('中文')) ?? items[0]).click();
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      const u = find();
      if (u) return u;
    }
    throw new Error('字幕没加载出来');
  }

  async function start() {
    if (!bvid()) throw new Error('找不到 BV 号');
    show({ state: 'running', msg: '获取字幕' });
    // 拿不到字幕就不带地址，后台会让本地服务下载音频转写
    const url = await subtitleUrl().catch(e => {
      console.warn('[bili-obsidian] 拿不到字幕，改为转写音频：', e.message);
      return '';
    });
    return chrome.runtime.sendMessage({ type: 'summarize', bvid: bvid(), p: page(), subtitleUrl: url });
  }

  btn.addEventListener('click', async () => {
    if (dragged) return;  // 刚拖完不算点击
    if (state === 'running') return;
    if (state === 'done') {
      const r = await chrome.runtime.sendMessage({ type: 'openPanel' });
      if (r?.error) btn.textContent = '点浏览器工具栏上的扩展图标查看笔记';
      return;
    }
    start().catch(e => show({ state: 'error', msg: e.message }));
  });
})();
