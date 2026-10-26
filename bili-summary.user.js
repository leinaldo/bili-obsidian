// ==UserScript==
// @name         B站总结到 Obsidian
// @namespace    local.bili-obsidian
// @version      0.7.0
// @description  在 B 站视频页加一个按钮：拿 AI 字幕（没有就让本地服务转写音频），交给本地服务用 Claude 或 DeepSeek 总结并存进 Obsidian
// @match        https://www.bilibili.com/video/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @run-at       document-start
// @updateURL    http://127.0.0.1:17321/bili-summary.user.js
// @downloadURL  http://127.0.0.1:17321/bili-summary.user.js
// ==/UserScript==

(function () {
  'use strict';
  // 同一个浏览器里装了两个 Tampermonkey（比如 Edge 里同时有 Edge 商店版和 Chrome 商店版）时，
  // 脚本会跑两份、出现两个按钮。先跑的那份占个位，后来的直接退出
  const html = document.documentElement;
  if (html.hasAttribute('data-bili-obsidian')) {
    console.warn('[bili-obsidian] 这个页面上已经有一份脚本在运行，这一份不再启动。浏览器里可能装了两个 Tampermonkey');
    return;
  }
  html.setAttribute('data-bili-obsidian', GM_info.script.version);
  const API = 'http://127.0.0.1:17321';
  const LABEL = '总结到 Obsidian';
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

  const MODELS = [
    ['sonnet', 'Sonnet（推荐，快）'],
    ['opus', 'Opus（更细致，更耗额度）'],
    ['haiku', 'Haiku（最快最省）'],
  ];
  // DeepSeek 的模型名会变（比如 v4-flash 改名成 flash），所以不写死，打开面板时从本机 opencode 读
  const dsLabel = m => /flash/.test(m) ? `DeepSeek ${m.replace(/^deepseek-/, '')}（快、便宜）`
    : /pro/.test(m) ? `DeepSeek ${m.replace(/^deepseek-/, '')}（更强）` : `DeepSeek ${m.replace(/^deepseek-/, '')}`;
  const modelOptions = (ds = []) => [...MODELS, ...ds.map(m => [m, dsLabel(m)]), ['', '自定义…']];

  // 界面放进 Shadow DOM，B 站的样式影响不到它，它也不影响 B 站
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  .dock { position: fixed; z-index: 2147483000; display: flex; gap: 6px; align-items: center; }
  button { border: none; cursor: pointer; font-size: 14px; }
  .main { padding: 10px 16px; border-radius: 20px; background: #7c3aed; color: #fff;
          box-shadow: 0 2px 8px rgba(0,0,0,.25); white-space: nowrap; touch-action: none; }
  .main:disabled { opacity: .75; cursor: progress; }
  .gear { width: 34px; height: 34px; border-radius: 50%; background: #fff; color: #7c3aed;
          box-shadow: 0 2px 8px rgba(0,0,0,.2); font-size: 17px; line-height: 34px; padding: 0; }
  .panel { position: fixed; z-index: 2147483001; width: 340px; padding: 16px; border-radius: 12px;
           background: #fff; color: #18191c; box-shadow: 0 8px 32px rgba(0,0,0,.25); font-size: 13px; }
  .panel[hidden] { display: none; }
  h3 { margin: 0 0 12px; font-size: 15px; }
  label { display: block; margin: 10px 0 4px; color: #61666d; }
  select, input[type=text], textarea { width: 100%; padding: 6px 8px; border: 1px solid #e3e5e7;
           border-radius: 6px; font-size: 13px; color: #18191c; background: #fff; }
  textarea { height: 64px; resize: vertical; }
  .row { display: flex; align-items: center; gap: 6px; margin-top: 12px; color: #18191c; }
  .hint { margin-top: 4px; color: #9499a0; font-size: 12px; word-break: break-all; }
  .actions { display: flex; justify-content: space-between; align-items: center; margin-top: 14px; }
  .actions button { padding: 6px 14px; border-radius: 6px; }
  .save { background: #7c3aed; color: #fff; }
  .cancel { background: #f1f2f3; color: #18191c; margin-right: 6px; }
  .link { background: none; color: #9499a0; padding: 0; font-size: 12px; }
  .msg { min-height: 18px; margin-top: 8px; font-size: 12px; }
  .msg.err { color: #e5484d; } .msg.ok { color: #16a34a; }
</style>
<div class="dock">
  <button class="main" title="点击开始总结；按住可以拖动位置">${LABEL}</button>
  <button class="gear" title="设置">⚙</button>
</div>
<div class="panel" hidden>
  <h3>总结设置</h3>
  <label>模型</label>
  <select class="model"></select>
  <input type="text" class="model-custom" placeholder="如 claude-sonnet-5-5；provider/model 格式交给 opencode" hidden>
  <div class="hint engine"></div>
  <label>Obsidian 库</label>
  <select class="vault"></select>
  <label>库里的文件夹</label>
  <input type="text" class="folder" placeholder="B站总结">
  <div class="hint out"></div>
  <label>附加要求（可选）</label>
  <textarea class="extra" placeholder="例如：主要内容控制在 5 条以内；最后加一节「我的思考」留空"></textarea>
  <div class="row"><input type="checkbox" class="open" id="open"><span>总结完自动在 Obsidian 里打开</span></div>
  <div class="msg"></div>
  <div class="actions">
    <button class="link reset">按钮位置复原</button>
    <span><button class="cancel">取消</button><button class="save">保存</button></span>
  </div>
</div>`;
  const $ = s => root.querySelector(s);
  const dock = $('.dock'), btn = $('.main'), panel = $('.panel');
  const mount = () => document.body.appendChild(host);
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  // ---------- 按钮位置：可拖动，记住位置 ----------
  function place(pos) {
    const p = pos || { right: 24, bottom: 24 };
    Object.assign(dock.style, { right: p.right + 'px', bottom: p.bottom + 'px' });
  }
  place(GM_getValue('pos', null));

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
    const w = dock.offsetWidth, h = dock.offsetHeight;
    place({
      right: Math.min(Math.max(drag.right - dx, 0), innerWidth - w),
      bottom: Math.min(Math.max(drag.bottom - dy, 0), innerHeight - h),
    });
  });
  btn.addEventListener('pointerup', () => {
    if (dragged) GM_setValue('pos', { right: parseFloat(dock.style.right), bottom: parseFloat(dock.style.bottom) });
    drag = null;
  });

  // ---------- 和本地服务通信 ----------
  function call(method, path, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method, url: API + path,
        headers: { 'Content-Type': 'application/json', 'X-Bili-Summary': '1' },
        data: body ? JSON.stringify(body) : undefined,
        onload: r => {
          let d;
          try { d = JSON.parse(r.responseText); } catch (e) { return reject(new Error('本地服务返回异常')); }
          r.status >= 400 ? reject(new Error(d.error || '请求失败')) : resolve(d);
        },
        onerror: () => reject(new Error('连不上本地服务')),
      });
    });
  }

  // 告诉本地服务这个脚本在跑、是哪个版本：安装脚本据此判断要不要再打开脚本安装页
  call('GET', '/hello?v=' + encodeURIComponent(GM_info.script.version)).catch(() => {});

  // ---------- 设置面板 ----------
  let cfg = null;
  const msg = (text, kind) => { const m = $('.msg'); m.textContent = text || ''; m.className = 'msg ' + (kind || ''); };
  const currentModel = () => $('.model').value || $('.model-custom').value.trim();
  // 和服务端 uses_opencode 的规则一致：deepseek 开头或 provider/model 格式走 opencode
  function showEngine() {
    const m = currentModel();
    const oc = m.toLowerCase().startsWith('deepseek') || m.includes('/');
    const ok = oc ? cfg?.has_opencode : cfg?.has_claude;
    const e = $('.engine');
    e.textContent = oc
      ? (ok ? '通过本机 opencode 调用，用它里面已登录的 DeepSeek' : '⚠️ 本机没找到 opencode，选这个会失败')
      : (ok ? '通过本机 claude 命令行调用' : '⚠️ 本机没找到 claude 命令行，选这个会失败');
    e.style.color = ok ? '' : '#e5484d';
  }
  const showOut = () => {
    $('.out').textContent = '保存到：' + $('.vault').value.replace(/[\\/]$/, '') + '/' + ($('.folder').value.trim() || '…');
  };

  function positionPanel() {
    const r = dock.getBoundingClientRect();
    const w = 340, h = panel.offsetHeight || 460;
    panel.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px';
    panel.style.top = (r.top - h - 10 >= 8 ? r.top - h - 10 : Math.min(r.bottom + 10, innerHeight - h - 8)) + 'px';
  }

  async function openPanel() {
    panel.hidden = false;
    positionPanel();
    msg('读取设置…');
    try {
      cfg = await call('GET', '/config');
    } catch (e) {
      return msg(e.message, 'err');
    }
    const opts = modelOptions(cfg.deepseek_models);
    $('.model').innerHTML = opts.map(() => '<option></option>').join('');
    [...$('.model').options].forEach((o, i) => { o.value = opts[i][0]; o.textContent = opts[i][1]; });
    const known = opts.some(([v]) => v && v === cfg.model);
    $('.model').value = known ? cfg.model : '';
    $('.model-custom').hidden = known;
    $('.model-custom').value = known ? '' : cfg.model;
    showEngine();
    $('.vault').innerHTML = cfg.vaults.map(v => `<option></option>`).join('');
    [...$('.vault').options].forEach((o, i) => { o.value = o.textContent = cfg.vaults[i]; });
    $('.vault').value = cfg.vault;
    $('.folder').value = cfg.folder;
    $('.extra').value = cfg.extra_prompt || '';
    $('.open').checked = !!cfg.open_after;
    showOut();
    msg('');
    positionPanel();
  }

  $('.gear').addEventListener('click', () => (panel.hidden ? openPanel() : (panel.hidden = true)));
  $('.cancel').addEventListener('click', () => { panel.hidden = true; });
  $('.model').addEventListener('change', () => {
    $('.model-custom').hidden = !!$('.model').value;
    if (!$('.model').value) $('.model-custom').focus();
    showEngine();
  });
  $('.model-custom').addEventListener('input', showEngine);
  $('.vault').addEventListener('change', showOut);
  $('.folder').addEventListener('input', showOut);
  $('.reset').addEventListener('click', () => { GM_setValue('pos', null); place(null); positionPanel(); });
  root.addEventListener('keydown', e => { if (e.key === 'Escape') panel.hidden = true; e.stopPropagation(); });
  // 不让 B 站的快捷键（空格暂停、方向键快进等）吃掉在面板里的输入
  for (const t of ['keyup', 'keypress']) root.addEventListener(t, e => e.stopPropagation());

  $('.save').addEventListener('click', async () => {
    msg('保存中…');
    try {
      const r = await call('POST', '/config', {
        model: currentModel(), vault: $('.vault').value, folder: $('.folder').value.trim(),
        extra_prompt: $('.extra').value, open_after: $('.open').checked,
      });
      msg('已保存，下次总结生效：' + r.out_dir, 'ok');
      setTimeout(() => { panel.hidden = true; }, 1200);
    } catch (e) {
      msg(e.message, 'err');
    }
  });

  // ---------- 总结 ----------
  function setBtn(text, busy) {
    btn.textContent = text;
    btn.disabled = !!busy;
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
    if (dragged) return;  // 刚拖完不算点击
    try {
      const bvid = location.pathname.match(/BV[0-9A-Za-z]{10}/)?.[0];
      const p = Number(new URLSearchParams(location.search).get('p') || 1);
      if (!bvid) throw new Error('找不到 BV 号');
      setBtn('获取字幕…', true);
      // 拿不到字幕就不带地址，本地服务会下载音频转写
      const url = await subtitleUrl().catch(e => {
        console.warn('[bili-obsidian] 拿不到字幕，改为转写音频：', e.message);
        return '';
      });
      const { key } = await call('POST', '/summarize', { bvid, p, subtitle_url: url });
      for (;;) {
        await sleep(2000);
        const s = await call('GET', '/status?key=' + key);
        if (s.state === 'done') { setBtn('✓ 已存入 Obsidian'); break; }
        if (s.state === 'error') throw new Error(s.msg);
        setBtn((s.msg || '处理中') + '…', true);
      }
    } catch (e) {
      setBtn('✗ ' + e.message);
      console.error('[bili-obsidian]', e);
    }
    setTimeout(() => setBtn(LABEL), 8000);
  });
})();
