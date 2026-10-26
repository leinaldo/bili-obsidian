// 发到 Notion 数据库：笔记正文转成 Notion 的块，标签、链接等按数据库里已有的属性类型填
const API = 'https://api.notion.com/v1';
const MAX_TEXT = 2000;  // Notion 每段富文本最多 2000 字
const MAX_BLOCKS = 100; // 每次请求最多 100 个块

// 数据库 ID 可以直接粘贴数据库的网址
export const databaseId = s => (s.replace(/-/g, '').match(/[0-9a-f]{32}/i) || [''])[0];

async function api(token, path, method = 'GET', body) {
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) {
    const hint = r.status === 404 ? '（数据库要先在 Notion 里「连接」到你的集成）' : '';
    throw new Error(`Notion 报错：${j.message || r.status}${hint}`);
  }
  return j;
}

// **粗体**、`代码`、[链接](url) → Notion 富文本
function rich(text) {
  const out = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0, m;
  const push = (content, extra = {}) => {
    for (let i = 0; i < content.length; i += MAX_TEXT) {
      out.push({ type: 'text', text: { content: content.slice(i, i + MAX_TEXT), ...(extra.link ? { link: extra.link } : {}) },
        annotations: { bold: !!extra.bold, code: !!extra.code } });
    }
  };
  while ((m = re.exec(text))) {
    if (m.index > last) push(text.slice(last, m.index));
    if (m[1]) push(m[1], { bold: true });
    else if (m[2]) push(m[2], { code: true });
    else push(m[3], { link: { url: m[4] } });
    last = re.lastIndex;
  }
  if (last < text.length) push(text.slice(last));
  return out;
}

const block = (type, text, extra = {}) => ({ object: 'block', type, [type]: { rich_text: rich(text), ...extra } });

export function toBlocks(md) {
  const blocks = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (line.startsWith('```')) {
      const code = [];
      while (++i < lines.length && !lines[i].startsWith('```')) code.push(lines[i]);
      blocks.push({ object: 'block', type: 'code', code: { rich_text: rich(code.join('\n')), language: 'plain text' } });
    } else if ((m = line.match(/^(#{1,3})\s+(.*)/))) {
      blocks.push(block(`heading_${m[1].length}`, m[2]));
    } else if ((m = line.match(/^#{4,}\s+(.*)/))) {
      blocks.push(block('paragraph', `**${m[1]}**`));
    } else if ((m = line.match(/^\s*- \[( |x)\]\s+(.*)/i))) {
      blocks.push(block('to_do', m[2], { checked: m[1] !== ' ' }));
    } else if ((m = line.match(/^\s*[-*+]\s+(.*)/))) {
      blocks.push(block('bulleted_list_item', m[1]));
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
      blocks.push(block('numbered_list_item', m[1]));
    } else if ((m = line.match(/^>\s?(.*)/))) {
      blocks.push(block('quote', m[1]));
    } else if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      blocks.push({ object: 'block', type: 'divider', divider: {} });
    } else if (/^<\/?(details|summary)/.test(line.trim())) {
      continue;  // 文字稿的折叠标签 Notion 不认，正文照常写入
    } else if (line.trim()) {
      blocks.push(block('paragraph', line));
    }
  }
  return blocks;
}

export async function sendToNotion({ token, databaseId: rawId }, note, markdown) {
  const id = databaseId(rawId || '');
  if (!token || !id) throw new Error('先在设置里填 Notion 的集成密钥和数据库');
  const db = await api(token, `/databases/${id}`);
  const props = {};
  let urlDone = false, tagsDone = false, dateDone = false;
  for (const [name, p] of Object.entries(db.properties)) {
    if (p.type === 'title') props[name] = { title: rich(note.title) };
    else if (p.type === 'url' && !urlDone) { props[name] = { url: note.url }; urlDone = true; }
    else if (p.type === 'multi_select' && !tagsDone) {
      // 选项名不能带逗号
      props[name] = { multi_select: ['B站总结', ...note.tags].map(t => ({ name: t.replace(/,/g, ' ').slice(0, 100) })) };
      tagsDone = true;
    } else if (p.type === 'date' && !dateDone) { props[name] = { date: { start: note.date } }; dateDone = true; }
    else if (p.type === 'rich_text' && /up|作者|博主/i.test(name)) props[name] = { rich_text: rich(note.up) };
  }
  // 正文不要 frontmatter，元数据已经写进属性
  const blocks = toBlocks(markdown.replace(/^---\n[\s\S]*?\n---\n+/, '').replace(/^# .*\n+/, ''));
  const page = await api(token, '/pages', 'POST', {
    parent: { database_id: id }, properties: props,
    ...(note.cover ? { cover: { type: 'external', external: { url: note.cover } } } : {}),
    children: blocks.slice(0, MAX_BLOCKS),
  });
  for (let i = MAX_BLOCKS; i < blocks.length; i += MAX_BLOCKS) {
    await api(token, `/blocks/${page.id}/children`, 'PATCH', { children: blocks.slice(i, i + MAX_BLOCKS) });
  }
  return page.url;
}
