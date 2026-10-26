// 笔记 → 思维导图。用 marked 的词法分析建树，markmap-view + d3 画图（都在 vendor/ 里，扩展不能加载远程代码）
/* global marked */

// 标题按层级成树；列表挂在最近的标题下，嵌套列表成为子节点
export function toTree(md, title) {
  const root = { content: esc(title), children: [] };
  const stack = [{ depth: 0, node: root }];
  const under = depth => {
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
    return stack[stack.length - 1].node;
  };
  const addList = (list, parent) => {
    for (const item of list.items) {
      const textTok = item.tokens.find(t => t.type === 'text' || t.type === 'paragraph');
      const text = textTok?.text || item.text.split('\n')[0];
      // 「**小标题**：内容」拆成两层，节点上只放小标题，图才看得清
      const m = text.match(/^\*\*(.+?)\*\*\s*[：:]\s*([\s\S]+)$/);
      const node = m ? { content: inline(m[1]), children: [{ content: inline(m[2]), children: [] }] }
        : { content: inline(text), children: [] };
      parent.children.push(node);
      for (const t of item.tokens) if (t.type === 'list') addList(t, node);
    }
  };
  for (const tok of marked.lexer(md)) {
    if (tok.type === 'heading') {
      if (tok.depth === 1) continue;  // 一级标题就是根节点
      const node = { content: inline(tok.text), children: [] };
      under(tok.depth).children.push(node);
      stack.push({ depth: tok.depth, node });
    } else if (tok.type === 'list') {
      addList(tok, stack[stack.length - 1].node);
    } else if (tok.type === 'paragraph' && stack.length > 1 && tok.text.length < 120) {
      // 标题下的短段落（比如「一句话」）也放进图里，长段落只会让图变乱
      stack[stack.length - 1].node.children.push({ content: inline(tok.text), children: [] });
    }
  }
  return root;
}

// 长句子换行显示，不然整张图被拉得很宽，缩到窗口里字小得看不清
export const MM_OPTIONS = { duration: 300, maxWidth: 260 };

const esc = s =>s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const inline = s => marked.parseInline(s);

export function noteBody(md) {
  // 去掉 frontmatter、标题下那行元信息和折叠的文字稿
  return md.replace(/^---\n[\s\S]*?\n---\n+/, '').replace(/^UP 主：.*\n/m, '')
    .replace(/<details>[\s\S]*<\/details>\n?/, '');
}

// 独立的 HTML 文件：把 d3 和 markmap-view 内联进去，离线也能打开
export async function standaloneHtml(tree, title) {
  const [d3, mm] = await Promise.all(['vendor/d3.min.js', 'vendor/markmap-view.js']
    .map(p => fetch(chrome.runtime.getURL(p)).then(r => r.text())));
  const data = JSON.stringify(tree).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https://*.hdslb.com">
<!-- 笔记由模型生成，禁止这个文件发出任何网络请求；链接在生成时已只保留 http(s) -->
<title>${esc(title)}</title>
<style>html,body{margin:0;height:100%}svg{width:100%;height:100%}</style></head>
<body><svg id="mm"></svg>
<script>${d3}</script>
<script>${mm}</script>
<script>markmap.Markmap.create('#mm', ${JSON.stringify(MM_OPTIONS)}, ${data});</script>
</body></html>`;
}

// 导出 SVG 前把画布缩放到刚好装下整张图
export function svgString(svg) {
  const g = svg.querySelector('g');
  const box = g.getBBox();
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('viewBox', `${box.x - 20} ${box.y - 20} ${box.width + 40} ${box.height + 40}`);
  clone.setAttribute('width', box.width + 40);
  clone.setAttribute('height', box.height + 40);
  clone.querySelector('g').removeAttribute('transform');
  return new XMLSerializer().serializeToString(clone);
}
