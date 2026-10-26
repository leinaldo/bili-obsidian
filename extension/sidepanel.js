/* global marked, markmap */
import { download, downloadMarkdown, saveToFolder, toNotion } from './lib/exporters.js';
import { MM_OPTIONS, noteBody, standaloneHtml, svgString, toTree } from './lib/mindmap.js';
import { safeName, toMarkdown } from './lib/prompt.js';
import { loadSettings } from './lib/settings.js';

const $ = s => document.querySelector(s);
// 笔记是模型生成的，不渲染里面的原始 HTML；文字稿单独用纯文本显示
marked.use({ renderer: { html: () => '' } });

let notes = [], current = null, tabKey = null, tabId = null, mm = null, tab = 'note';

const msg = (text, kind = '') => { $('#msg').textContent = text; $('#msg').className = kind; };
const keyOf = url => {
  const m = (url || '').match(/bilibili\.com\/video\/(BV[0-9A-Za-z]{10})/);
  return m ? `${m[1]}-${new URL(url).searchParams.get('p') || 1}` : null;
};

async function loadNotes() {
  notes = (await chrome.storage.local.get('notes')).notes || [];
  const sel = $('#history');
  sel.replaceChildren(...notes.map(n => new Option(n.title, n.key)));
  if (!notes.length) return select(null);
  select(notes.find(n => n.key === (current?.key || tabKey)) || notes.find(n => n.key === tabKey) || notes[0]);
}

function select(note) {
  current = note;
  $('#empty').hidden = !!note;
  $('#note').hidden = !note || tab !== 'note';
  $('#mind').hidden = !note || tab !== 'mind';
  for (const b of document.querySelectorAll('.actions button')) b.disabled = !note;
  if (!note) return;
  $('#history').value = note.key;
  const md = toMarkdown({ ...note, transcript: '' }, { frontmatter: false });
  $('#note').innerHTML = marked.parse(md);
  if (note.transcript) {
    const d = document.createElement('details');
    const s = document.createElement('summary');
    s.textContent = note.source + '文字稿';
    d.append(s, note.transcript);
    $('#note').append(d);
  }
  const meta = document.createElement('p');
  meta.className = 'faint';
  meta.textContent = `${note.date} · ${note.model} · ${note.source}`;
  $('#note').prepend(meta);
  if (tab === 'mind') drawMind();
}

function drawMind() {
  const svg = $('#mind svg');
  svg.replaceChildren();
  mm = markmap.Markmap.create(svg, MM_OPTIONS,toTree(noteBody(toMarkdown(current, { frontmatter: false })), current.title));
}

// ---------- 当前标签页对应的任务状态 ----------
async function refreshTab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = t?.id;
  tabKey = keyOf(t?.url);
  $('#run').disabled = !tabKey;
  $('#run').title = tabKey ? '' : '先打开一个 B 站视频页';
  showJob(tabKey ? await chrome.runtime.sendMessage({ type: 'job', key: tabKey }) : null);
  const n = notes.find(x => x.key === tabKey);
  if (n && n !== current) select(n);
}

function showJob(job) {
  const s = $('#status');
  s.className = job?.state === 'running' ? 'running muted' : job?.state === 'error' ? 'err' : 'muted';
  if (!job) s.textContent = tabKey ? '' : '打开 B 站视频页后可以总结';
  else if (job.state === 'running') s.textContent = job.msg;
  else if (job.state === 'error') s.textContent = '失败：' + job.msg;
  else s.textContent = '已完成' + (job.exports || []).map(x => ` · ${x.name}${x.ok ? '✓' : '✗ ' + x.detail}`).join('');
  $('#run').disabled = !tabKey || job?.state === 'running';
}

chrome.storage.session.onChanged.addListener(ch => {
  if (ch.jobs && tabKey) showJob(ch.jobs.newValue?.[tabKey]);
});
chrome.storage.local.onChanged.addListener(ch => {
  if (!ch.notes) return;
  const fresh = ch.notes.newValue?.[0];
  if (fresh?.key === tabKey) current = fresh;  // 刚总结完当前视频，直接显示新笔记
  loadNotes();
});
chrome.tabs.onActivated.addListener(refreshTab);
chrome.tabs.onUpdated.addListener((id, info) => { if (id === tabId && info.url) refreshTab(); });

// ---------- 按钮 ----------
$('#run').addEventListener('click', async () => {
  msg('');
  const r = await chrome.runtime.sendMessage({ type: 'summarizeTab', tabId });
  if (r?.error) msg(r.error, 'err');
});
$('#settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('#history').addEventListener('change', e => select(notes.find(n => n.key === e.target.value)));
for (const b of document.querySelectorAll('.tabs button')) {
  b.addEventListener('click', () => {
    tab = b.dataset.tab;
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
    $('#noteActions').hidden = tab !== 'note';
    $('#mindActions').hidden = tab !== 'mind';
    select(current);
  });
}
$('#note').addEventListener('click', e => {
  const a = e.target.closest('a');
  if (!a) return;
  e.preventDefault();
  if (/^https?:/.test(a.href)) chrome.tabs.create({ url: a.href });
});

const actions = {
  async copy() { await navigator.clipboard.writeText(toMarkdown(current)); return '已复制'; },
  async download() { await downloadMarkdown(current); return '已下载到「下载/B站总结」'; },
  async folder() { return '已保存：' + await saveToFolder(await loadSettings(), current); },
  async notion() {
    const url = await toNotion(await loadSettings(), current);
    return '已发到 Notion：' + url;
  },
  async redo() {
    if (current.key !== tabKey) throw new Error('先在当前标签页打开这个视频');
    const r = await chrome.runtime.sendMessage({ type: 'summarizeTab', tabId });
    if (r?.error) throw new Error(r.error);
    return '';
  },
  async delete() {
    const left = notes.filter(n => n.key !== current.key);
    current = null;
    await chrome.storage.local.set({ notes: left });
    return '已删除';
  },
  async mindHtml() {
    const html = await standaloneHtml(toTree(noteBody(toMarkdown(current, { frontmatter: false })), current.title), current.title);
    await download(html, safeName(current.title) + '.思维导图.html', 'text/html');
    return '已下载思维导图 HTML';
  },
  async mindSvg() {
    await download(svgString($('#mind svg')), safeName(current.title) + '.思维导图.svg', 'image/svg+xml');
    return '已下载思维导图 SVG';
  },
  async mindFit() { mm?.fit(); return ''; },
};
for (const b of document.querySelectorAll('.actions button')) {
  b.addEventListener('click', async () => {
    b.disabled = true;
    msg('处理中…');
    try { msg(await actions[b.dataset.act](), 'ok'); } catch (e) { msg(e.message, 'err'); }
    b.disabled = !current;
  });
}

await loadNotes();
await refreshTab();
