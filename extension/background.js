// 后台：串起整个流程。视频信息 → 字幕或本地转写 → 模型总结 → 拼笔记 → 存历史 → 自动导出
import { subtitleText, videoInfo } from './lib/bili.js';
import { autoExport } from './lib/exporters.js';
import { hostCall } from './lib/host.js';
import { complete } from './lib/llm.js';
import { buildPrompt, linkStamps, parseOutput, toc } from './lib/prompt.js';
import { loadSettings } from './lib/settings.js';

const MAX_NOTES = 50;

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

// key（BV号-分P）→ {state: running|done|error, msg, tabId, exports}
const jobs = {};
// service worker 重启后恢复已结束的任务状态；进行中的任务随旧的 worker 一起没了，不恢复
chrome.storage.session.get('jobs').then(({ jobs: saved = {} }) => {
  for (const [k, j] of Object.entries(saved)) if (j.state !== 'running' && !jobs[k]) jobs[k] = j;
});

function setJob(key, patch) {
  jobs[key] = { ...jobs[key], ...patch };
  chrome.storage.session.set({ jobs }).catch(() => {});
  const { tabId } = jobs[key];
  if (tabId) chrome.tabs.sendMessage(tabId, { type: 'job', key, job: jobs[key] }).catch(() => {});
}

// service worker 空闲 30 秒会被浏览器停掉，等模型回复时没有扩展事件；隔一会调一次扩展 API 让它保持运行
function keepAlive() {
  const t = setInterval(() => chrome.runtime.getPlatformInfo(), 20e3);
  return () => clearInterval(t);
}

function engineLabel(s) {
  const e = s.engine;
  if (e.kind === 'cli') return e.id === 'custom' ? '自定义命令' : e.id + (e.model ? ':' + e.model : '');
  const p = s.providers.find(x => x.id === e.id);
  return `${p?.name || e.id}:${e.model || p?.model || ''}`;
}

async function saveNote(note) {
  const { notes = [] } = await chrome.storage.local.get('notes');
  await chrome.storage.local.set({ notes: [note, ...notes.filter(n => n.key !== note.key)].slice(0, MAX_NOTES) });
}

async function summarize({ bvid, p, subtitleUrl }, tabId) {
  const key = `${bvid}-${p}`;
  if (jobs[key]?.state === 'running') return key;
  jobs[key] = { tabId };
  const stop = keepAlive();
  try {
    const settings = await loadSettings();
    setJob(key, { state: 'running', msg: '读取视频信息', exports: null, error: null });
    const info = await videoInfo(bvid, p);
    let text, source;
    if (subtitleUrl) {
      setJob(key, { msg: '下载字幕' });
      text = await subtitleText(subtitleUrl);
      source = 'AI 字幕';
    } else {
      setJob(key, { msg: '无字幕，准备转写音频' });
      text = (await hostCall('transcribe', { bvid, p, model: settings.asrModel },
        msg => setJob(key, { msg: '无字幕，' + msg }))).text;
      source = '语音识别';
    }
    setJob(key, { msg: '正在总结' });
    const raw = await complete(settings, buildPrompt({ info, text, source, settings }), msg => setJob(key, { msg }));
    let { tags, body } = parseOutput(raw);
    if (settings.formats.link) body = linkStamps(body, info.url);
    if (settings.formats.toc) body = toc(body) + body;
    const note = {
      key, bvid, p, ...info, tags, body, source, style: settings.style,
      transcript: settings.formats.transcript ? text : '',
      model: engineLabel(settings),
      date: new Date().toLocaleDateString('sv-SE'),  // 本地日期 YYYY-MM-DD
      createdAt: Date.now(),
    };
    await saveNote(note);
    setJob(key, { msg: '导出中' });
    const exports = await autoExport(settings, note);
    setJob(key, { state: 'done', msg: '已完成', exports });
  } catch (e) {
    console.error('[bili-obsidian]', e);
    setJob(key, { state: 'error', msg: e.message, error: e.message });
  } finally {
    stop();
  }
  return key;
}

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  const tabId = m.tabId ?? sender.tab?.id;
  if (m.type === 'summarize') {
    summarize(m, tabId);
    reply({ key: `${m.bvid}-${m.p}` });
  } else if (m.type === 'summarizeTab') {
    // 侧边栏里点「总结当前视频」：先让页面里的脚本拿字幕地址
    chrome.tabs.sendMessage(tabId, { type: 'start' })
      .then(r => reply(r || { error: '这个页面不是 B 站视频页' }))
      .catch(() => reply({ error: '这个页面不是 B 站视频页，或打开扩展后还没刷新过' }));
    return true;
  } else if (m.type === 'job') {
    reply(jobs[m.key] || null);
  } else if (m.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
  } else if (m.type === 'openPanel') {
    // 必须在用户点击后同步调用；浏览器不认就让页面提示去点工具栏图标
    chrome.sidePanel.open({ tabId }).then(() => reply({ ok: true }), e => reply({ error: e.message }));
    return true;
  }
});
