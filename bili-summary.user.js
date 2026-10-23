// ==UserScript==
// @name         B站总结到 Obsidian
// @namespace    local.bili-obsidian
// @version      0.3.0
// @description  在 B 站视频页加一个按钮：拿 AI 字幕，交给本地服务用 Claude 总结并存进 Obsidian
// @match        https://www.bilibili.com/video/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-start
// @updateURL    http://127.0.0.1:17321/bili-summary.user.js
// @downloadURL  http://127.0.0.1:17321/bili-summary.user.js
// ==/UserScript==

(function () {
  'use strict';
  const API = 'http://127.0.0.1:17321';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const videoKey = () => (location.pathname.match(/BV[0-9A-Za-z]{10}/)?.[0] || '') +
    '-' + (new URLSearchParams(location.search).get('p') || 1);

  // B 站页面请求很多，资源记录满了以后新的字幕请求不会被记下来，
  // 所以从页面一开始就监听字幕请求，并记下它属于哪个视频
  let captured = null;
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) {
      if (e.name.includes('aisubtitle.hdslb.com')) captured = { key: videoKey(), url: e.name };
    }
  }).observe({ type: 'resource', buffered: true });

  const btn = document.createElement('button');
  btn.textContent = '总结到 Obsidian';
  Object.assign(btn.style, {
    position: 'fixed', right: '24px', bottom: '24px', zIndex: 99999,
    padding: '10px 16px', borderRadius: '20px', border: 'none',
    background: '#7c3aed', color: '#fff', fontSize: '14px',
    boxShadow: '0 2px 8px rgba(0,0,0,.25)', cursor: 'pointer',
  });
  if (document.body) document.body.appendChild(btn);
  else document.addEventListener('DOMContentLoaded', () => document.body.appendChild(btn));

  function setBtn(text, busy) {
    btn.textContent = text;
    btn.disabled = !!busy;
    btn.style.opacity = busy ? '0.75' : '1';
  }

  function call(method, path, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method, url: API + path,
        headers: { 'Content-Type': 'application/json', 'X-Bili-Summary': '1' },
        data: body ? JSON.stringify(body) : undefined,
        onload: r => { try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(e); } },
        onerror: () => reject(new Error('连不上本地服务')),
      });
    });
  }

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
    throw new Error('字幕没加载出来，刷新后再试');
  }

  btn.addEventListener('click', async () => {
    try {
      const bvid = location.pathname.match(/BV[0-9A-Za-z]{10}/)?.[0];
      const p = Number(new URLSearchParams(location.search).get('p') || 1);
      if (!bvid) throw new Error('找不到 BV 号');
      setBtn('获取字幕…', true);
      const url = await subtitleUrl();
      const { key } = await call('POST', '/summarize', { bvid, p, subtitle_url: url });
      for (;;) {
        await sleep(3000);
        const s = await call('GET', '/status?key=' + key);
        if (s.state === 'done') { setBtn('✓ 已存入 Obsidian'); break; }
        if (s.state === 'error') throw new Error(s.msg);
        setBtn((s.msg || '处理中') + '…', true);
      }
    } catch (e) {
      setBtn('✗ ' + e.message);
      console.error('[bili-obsidian]', e);
    }
    setTimeout(() => setBtn('总结到 Obsidian'), 8000);
  });
})();
