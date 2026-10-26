// 纯逻辑自检：node extension/test/check.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { subtitleText } from '../lib/bili.js';
import { toBlocks } from '../lib/notion.js';
import { linkStamps, parseOutput, safeName, toc, toMarkdown } from '../lib/prompt.js';

globalThis.marked = createRequire(import.meta.url)('../vendor/marked.umd.js');
const { toTree, noteBody } = await import('../lib/mindmap.js');

// 模型输出：去思考过程、去整篇代码块包裹、取标签、去一级标题
const out = parseOutput('<think>想想</think>```markdown\nTAGS: 人口，生育率、 #韩国\n\n# 标题\n## 主要内容 [01:05]\n- a\n```');
assert.deepEqual(out.tags, ['人口', '生育率', '韩国']);
assert.equal(out.body, '## 主要内容 [01:05]\n- a');

// 时间戳变链接，已经是链接的不重复处理，小时格式也能换算
const url = 'https://www.bilibili.com/video/BV1NvJ66gEMn/';
assert.equal(linkStamps('## A [01:05]', url), `## A [01:05](${url}?t=65)`);
assert.equal(linkStamps('[1:02:03]', url + '?p=2'), `[1:02:03](${url}?p=2&t=3723)`);
assert.equal(linkStamps('[01:05](x)', url), '[01:05](x)');

// 目录：三个以上小节才生成
assert.equal(toc('## a\n## b'), '');
assert.match(toc('## a\n## b\n## c'), /^## 目录\n- a\n- b\n- c/);

const note = { title: 'T: "x"', up: 'U', url, cover: 'https://i0.hdslb.com/a.jpg', duration: 736, date: '2026-10-26',
  tags: ['a'], body: '## 主要内容\n1. **x**：y', source: 'AI 字幕', model: 'claude:sonnet', transcript: '[00:00] 原文' };
const md = toMarkdown(note);
assert.match(md, /^---\ntitle: "T: \\"x\\""\ntags: \["B站总结", "a"\]/);
assert.match(md, /duration: "12:16"/);
assert.match(md, /<details>\n<summary>AI 字幕文字稿<\/summary>\n\n\[00:00\] 原文/);
assert.equal(safeName('a/b:c?. '), 'a_b_c_');

// Notion 块
const blocks = toBlocks('## 标题\n1. **粗** 和 [链接](https://a.b)\n- [x] 完成\n```\ncode\n```\n<details>\n文字');
assert.deepEqual(blocks.map(b => b.type), ['heading_2', 'numbered_list_item', 'to_do', 'code', 'paragraph']);
assert.equal(blocks[1].numbered_list_item.rich_text[0].annotations.bold, true);
assert.equal(blocks[1].numbered_list_item.rich_text[2].text.link.url, 'https://a.b');
assert.equal(toBlocks('x'.repeat(4500))[0].paragraph.rich_text.length, 3);

// 思维导图：标题成树，列表和嵌套列表挂到对应标题下
const tree = toTree(noteBody(toMarkdown({ ...note, transcript: '' }, { frontmatter: false })) + '\n### 子\n- 甲\n  - 乙', 'R<');
assert.equal(tree.content, 'R&lt;');
assert.equal(tree.children[0].content, '主要内容');
assert.equal(tree.children[0].children[0].content, 'x');
assert.equal(tree.children[0].children[0].children[0].content, 'y');
assert.equal(tree.children[0].children[1].content, '子');
assert.equal(tree.children[0].children[1].children[0].children[0].content, '乙');

// 字幕约每 30 秒一段，段首带时间
globalThis.fetch = async () => ({ json: async () => ({ body: [
  { from: 0, to: 10, content: '一' }, { from: 10, to: 31, content: '二' }, { from: 3600, to: 3605, content: '三' }] }) });
assert.equal(await subtitleText('//x'), '[00:00] 一 二\n[1:00:00] 三');

console.log('all checks passed');
