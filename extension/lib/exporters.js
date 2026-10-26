// 各种导出方式。后台总结完自动导出和侧边栏里手动点按钮都走这里
import { hostCall } from './host.js';
import { sendToNotion } from './notion.js';
import { safeName, toMarkdown } from './prompt.js';

export async function saveToFolder(settings, note) {
  const f = settings.exports.folder;
  if (!f.dir) throw new Error('先在设置里选保存笔记的文件夹');
  const r = await hostCall('save_file', {
    dir: f.dir, name: safeName(note.title), content: toMarkdown(note), open_obsidian: f.openObsidian,
  });
  return r.path;
}

// 后台 service worker 里没有 URL.createObjectURL，统一用 data: 地址
export async function download(content, filename, mime = 'text/markdown') {
  const url = `data:${mime};charset=utf-8,` + encodeURIComponent(content);
  return chrome.downloads.download({ url, filename: 'B站总结/' + filename, conflictAction: 'overwrite' });
}

export const downloadMarkdown = note => download(toMarkdown(note), safeName(note.title) + '.md');

export const toNotion = (settings, note) => sendToNotion(settings.exports.notion, note, toMarkdown(note));

// 返回每种自动导出的结果，失败的不影响别的
export async function autoExport(settings, note) {
  const ex = settings.exports, jobs = [];
  if (ex.folder.auto && ex.folder.dir) jobs.push(['文件夹', saveToFolder(settings, note)]);
  if (ex.download.auto) jobs.push(['下载', downloadMarkdown(note)]);
  if (ex.notion.auto) jobs.push(['Notion', toNotion(settings, note)]);
  const out = [];
  for (const [name, p] of jobs) {
    try { out.push({ name, ok: true, detail: String(await p) }); } catch (e) { out.push({ name, ok: false, detail: e.message }); }
  }
  return out;
}
