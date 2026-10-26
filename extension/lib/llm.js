// 调模型：本地 agent 命令行走本地服务，API 直接从扩展发请求
import { hostCall } from './host.js';

export async function complete(settings, prompt, onProgress) {
  const e = settings.engine;
  if (e.kind === 'cli') {
    const r = await hostCall('run_cli', {
      cli: e.id, model: e.model, prompt, command: e.id === 'custom' ? settings.customCommand : undefined,
    }, onProgress);
    return r.text;
  }
  const p = settings.providers.find(x => x.id === e.id);
  if (!p) throw new Error('选中的 API 已被删除，去设置里重新选模型');
  onProgress?.(`${p.name} 正在总结`);
  return chat(p, e.model || p.model, prompt);
}

export async function chat(p, model, prompt) {
  if (!model) throw new Error(`${p.name} 还没填模型名`);
  let r;
  try {
    r = await fetch(p.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}) },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(15 * 60 * 1000),
    });
  } catch (err) {
    throw new Error(`连不上 ${p.name}：${err.message}。检查接口地址；第一次用要在设置里点这个 API 的「测试」，授权访问它的网址`);
  }
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`${p.name} 返回异常（${r.status}）：${text.slice(0, 200)}`); }
  if (!r.ok) throw new Error(`${p.name} 报错（${r.status}）：${j.error?.message || text.slice(0, 200)}`);
  const content = j.choices?.[0]?.message?.content;
  if (!content) throw new Error(`${p.name} 没有返回内容`);
  return content;
}

export async function listModels(p) {
  const r = await fetch(p.baseUrl.replace(/\/+$/, '') + '/models', {
    headers: p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {},
  });
  if (!r.ok) throw new Error(`读取模型列表失败（${r.status}）`);
  const j = await r.json();
  return (j.data || j.models || []).map(m => (m.id || m.name || '').replace(/^models\//, '')).filter(Boolean).sort();
}
