import { hostCall } from './lib/host.js';
import { chat, listModels } from './lib/llm.js';
import { databaseId } from './lib/notion.js';
import { STYLES } from './lib/prompt.js';
import { loadSettings, PROVIDER_PRESETS, saveSettings } from './lib/settings.js';

const $ = s => document.querySelector(s);
function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

const s = await loadSettings();
s.engineModels ||= {};  // 每个模型来源上次填的模型名，切换回来时恢复
let hello = null;

// ---------- 自动保存 ----------
let timer;
function save() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await saveSettings(s);
    $('#saved').classList.add('show');
    setTimeout(() => $('#saved').classList.remove('show'), 1200);
  }, 300);
}

// ---------- 本地服务 ----------
async function checkHost() {
  try {
    hello = await hostCall('hello');
    const clis = hello.clis.map(c => c.name).join('、') || '没找到';
    $('#hostStatus').replaceChildren(
      el('span', { className: 'ok', textContent: `✓ 已连接（v${hello.version}）` }),
      el('div', { className: 'faint', textContent: `本机命令行：${clis}；音频转写：${hello.asr ? '已安装' : '未安装'}` }),
    );
    $('#asrStatus').textContent = hello.asr
      ? `已下载的模型：${hello.asr_models.join('、') || '无（第一次转写时自动下载）'}` : '转写组件没装好：重新运行安装脚本';
  } catch (e) {
    $('#hostStatus').replaceChildren(
      el('div', { className: 'err', textContent: '✗ ' + e.message }),
      el('div', { className: 'faint', textContent: '没有本地服务也能用 API 模型总结有字幕的视频。本地命令行、音频转写、保存到文件夹需要本地服务。安装方法见 README。' }),
    );
  }
  renderEngines();
  renderVaults();
}

// ---------- 模型 ----------
const engineKey = e => `${e.kind}:${e.id}`;

function engineOptions() {
  const opts = (hello?.clis || []).map(c => ({ kind: 'cli', id: c.id, name: c.name, desc: '本机命令行 · 用它已登录的账号', models: c.models }));
  // 本地服务连不上时，仍显示当前选中的命令行，避免设置被悄悄改掉
  if (s.engine.kind === 'cli' && s.engine.id !== 'custom' && !opts.some(o => o.id === s.engine.id)) {
    opts.push({ kind: 'cli', id: s.engine.id, name: s.engine.id, desc: '本机没检测到', models: [] });
  }
  opts.push({ kind: 'cli', id: 'custom', name: '自定义命令', desc: '其他 agent 命令行', models: [] });
  for (const p of s.providers) opts.push({ kind: 'api', id: p.id, name: p.name, desc: 'API · ' + (p.baseUrl || '未填地址'), models: p.models || [] });
  return opts;
}

function renderEngines() {
  const opts = engineOptions();
  $('#engines').replaceChildren(...opts.map(o => {
    const input = el('input', { type: 'radio', name: 'engine', checked: engineKey(o) === engineKey(s.engine) });
    input.addEventListener('change', () => {
      s.engineModels[engineKey(s.engine)] = s.engine.model;
      s.engine = { kind: o.kind, id: o.id, model: s.engineModels[engineKey(o)] ?? (o.kind === 'api' ? s.providers.find(p => p.id === o.id)?.model : o.models[0]) ?? '' };
      save();
      renderEngineDetail();
    });
    return el('label', { className: 'choice' }, input, el('div', {}, el('b', { textContent: o.name }), el('span', { textContent: o.desc })));
  }));
  renderEngineDetail();
}

function renderEngineDetail() {
  const o = engineOptions().find(x => engineKey(x) === engineKey(s.engine));
  $('#model').value = s.engine.model || '';
  $('#modelList').replaceChildren(...(o?.models || []).map(m => el('option', { value: m })));
  $('#customBox').hidden = s.engine.id !== 'custom';
  $('#model').disabled = s.engine.id === 'custom';
  $('#engineHint').textContent = {
    codex: 'Codex 要填模型名：用 ChatGPT 账号登录时，部分模型不可用。Codex 关不掉读文件的能力（只读沙盒禁止写文件和联网），总结来路不明的视频时优先用 Claude Code 或 opencode。',
    opencode: '格式 provider/model，例如 deepseek/deepseek-flash。',
    gemini: 'Gemini CLI 按官方文档的无头模式调用，本工具作者没有实测，也没有关掉它的工具。',
    qwen: 'Qwen Code 按官方文档的无头模式调用，本工具作者没有实测，也没有关掉它的工具。',
    custom: '自定义命令照原样运行，本工具不限制它的权限。',
  }[s.engine.id] || '';
}

$('#model').addEventListener('input', e => {
  s.engine.model = e.target.value.trim();
  if (s.engine.kind === 'api') {
    const p = s.providers.find(x => x.id === s.engine.id);
    if (p) p.model = s.engine.model;
  }
  save();
});
$('#customCommand').value = s.customCommand;
$('#customCommand').addEventListener('input', e => { s.customCommand = e.target.value; save(); });

// ---------- API 服务 ----------
$('#preset').replaceChildren(...PROVIDER_PRESETS.map(p => el('option', { value: p.id, textContent: p.name })));

$('#addProvider').addEventListener('click', () => {
  const pre = PROVIDER_PRESETS.find(p => p.id === $('#preset').value);
  const id = pre.id + '-' + Date.now().toString(36);
  s.providers.push({ id, name: pre.name, baseUrl: pre.baseUrl, apiKey: '', model: pre.model, noKey: !!pre.noKey });
  save();
  renderProviders();
  renderEngines();
});

// 访问 API 的网址要用户授权；只能在点击按钮时申请
async function grant(p) {
  const origin = new URL(p.baseUrl).origin + '/*';
  if (await chrome.permissions.contains({ origins: [origin] })) return;
  if (!await chrome.permissions.request({ origins: [origin] })) throw new Error('没有授权访问 ' + origin);
}

function renderProviders() {
  $('#providers').replaceChildren(...s.providers.map(p => {
    const field = (key, placeholder, type = 'text') => {
      const i = el('input', { type, value: p[key] || '', placeholder });
      i.addEventListener('input', () => { p[key] = i.value.trim(); save(); if (key === 'name') renderEngines(); });
      return i;
    };
    const status = el('span', { className: 'faint full' });
    const run = (label, fn) => {
      const b = el('button', { textContent: label });
      b.addEventListener('click', async () => {
        b.disabled = true;
        status.className = 'faint full';
        status.textContent = '处理中…';
        try {
          await grant(p);
          status.textContent = await fn();
          status.className = 'ok full';
        } catch (e) {
          status.textContent = e.message;
          status.className = 'err full';
        }
        b.disabled = false;
      });
      return b;
    };
    const del = el('button', { textContent: '删除' });
    del.addEventListener('click', () => {
      s.providers = s.providers.filter(x => x !== p);
      if (s.engine.kind === 'api' && s.engine.id === p.id) s.engine = { kind: 'cli', id: 'claude', model: 'sonnet' };
      save(); renderProviders(); renderEngines();
    });
    return el('div', { className: 'provider' },
      field('name', '名称'), field('baseUrl', '接口地址，例如 https://api.deepseek.com/v1', 'url'),
      el('div', { className: 'full' }, field('apiKey', p.noKey ? '本机服务不需要密钥' : 'API Key', 'password')),
      el('div', { className: 'row full' },
        run('授权并获取模型列表', async () => {
          p.models = await listModels(p);
          save(); renderEngines();
          return `共 ${p.models.length} 个模型，已放进「模型名」的下拉提示`;
        }),
        run('测试', async () => {
          const reply = await chat(p, (engineKey(s.engine) === `api:${p.id}` && s.engine.model) || p.model, '只回复两个字：你好');
          return '✓ 模型回复：' + reply.slice(0, 40);
        }),
        del),
      status);
  }));
}

// ---------- 笔记风格 ----------
$('#styles').replaceChildren(...Object.entries(STYLES).map(([id, st]) => {
  const input = el('input', { type: 'radio', name: 'style', checked: s.style === id });
  input.addEventListener('change', () => { s.style = id; save(); });
  return el('label', { className: 'choice' }, input, el('div', {}, el('b', { textContent: st.name }), el('span', { textContent: st.desc })));
}));
const bindCheck = (sel, obj, key) => {
  $(sel).checked = !!obj[key];
  $(sel).addEventListener('change', e => { obj[key] = e.target.checked; save(); });
};
const bindText = (sel, obj, key, map = v => v) => {
  $(sel).value = obj[key] || '';
  $(sel).addEventListener('input', e => { obj[key] = map(e.target.value); save(); });
};
bindCheck('#fmtLink', s.formats, 'link');
bindCheck('#fmtToc', s.formats, 'toc');
bindCheck('#fmtTranscript', s.formats, 'transcript');
bindText('#extraPrompt', s, 'extraPrompt');

// ---------- 导出 ----------
const ex = s.exports;
bindCheck('#folderAuto', ex.folder, 'auto');
bindText('#folderDir', ex.folder, 'dir', v => v.trim());
bindCheck('#openObsidian', ex.folder, 'openObsidian');
bindCheck('#downloadAuto', ex.download, 'auto');
bindCheck('#notionAuto', ex.notion, 'auto');
bindText('#notionToken', ex.notion, 'token', v => v.trim());
bindText('#notionDb', ex.notion, 'databaseId', v => v.trim());

function setDir(dir) {
  ex.folder.dir = dir;
  $('#folderDir').value = dir;
  save();
}

function renderVaults() {
  const vaults = hello?.vaults || [];
  if (!vaults.length) return;
  $('#vaults').replaceChildren(el('span', { className: 'faint', textContent: 'Obsidian 库：' }), ...vaults.map(v => {
    const b = el('button', { textContent: v.split(/[\\/]/).pop(), title: v });
    b.addEventListener('click', () => {
      setDir(v + (v.includes('\\') ? '\\' : '/') + 'B站总结');
      if (!ex.folder.openObsidian) { ex.folder.openObsidian = true; $('#openObsidian').checked = true; }
    });
    return b;
  }));
}

$('#pickFolder').addEventListener('click', async () => {
  try {
    const r = await hostCall('pick_folder');
    if (r.path) setDir(r.path);
  } catch (e) { alert(e.message); }
});

$('#notionTest').addEventListener('click', async () => {
  const m = $('#notionMsg');
  m.className = 'faint';
  m.textContent = '测试中…';
  try {
    const id = databaseId(ex.notion.databaseId);
    if (!ex.notion.token || !id) throw new Error('先填集成密钥和数据库');
    const r = await fetch(`https://api.notion.com/v1/databases/${id}`, {
      headers: { Authorization: `Bearer ${ex.notion.token}`, 'Notion-Version': '2022-06-28' },
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.message + (r.status === 404 ? '（数据库要先「连接」这个集成）' : ''));
    m.className = 'ok';
    m.textContent = '✓ 已连接数据库：' + (j.title?.map(t => t.plain_text).join('') || id);
  } catch (e) {
    m.className = 'err';
    m.textContent = e.message;
  }
});

// ---------- 音频转写 ----------
bindText('#asrModel', s, 'asrModel');
$('#asrModel').addEventListener('change', e => { s.asrModel = e.target.value; save(); });

renderProviders();
renderEngines();
checkHost();
