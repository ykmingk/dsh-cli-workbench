/**
 * 引用选中文字（1.0.49：输入框换成 contenteditable，引用是正文流里的一枚内联块）。
 *
 *   选中消息里的一段 → 浮动「引用」→ 原文变成 `“ 引文…` 的小块插在光标处，
 *   后面可以接着打字；发出去后气泡里也按引用样式渲染。
 *
 * 抽真实源码在跑的三段：`parseDraft`（草稿 → 片段）、`serializeEditor`（DOM → 草稿）、
 * `renderUserText`（气泡渲染）。真正操作 Selection 的部分没有浏览器可点，只能静态盯接线。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcClient = fs.readFileSync(path.join(rootDir, 'client.js'), 'utf8');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

const sliceBlock = (text, marker) => {
  const start = text.indexOf(marker);
  if (start < 0) return null;
  let index = text.indexOf('{', start);
  let depth = 0;
  for (; index < text.length; index++) {
    if (text[index] === '{') depth++;
    else if (text[index] === '}') { depth--; if (depth === 0) return text.slice(start, index + 1); }
  }
  return null;
};

/* —— 草稿 ↔ 编辑器 —— */
console.log('\n[1] 草稿与编辑器 DOM 之间的往返');
{
  const parseBlock = sliceBlock(srcClient, 'const parseDraft = (value) => {');
  const serializeBlock = sliceBlock(srcClient, 'const serializeEditor = (node) => {');
  ok('抽到 parseDraft', Boolean(parseBlock));
  ok('抽到 serializeEditor', Boolean(serializeBlock));
  const factory = new Function('QUOTE_OPEN', 'QUOTE_CLOSE',
    parseBlock + '\n' + serializeBlock + '\n return { parseDraft, serializeEditor };');
  const { parseDraft, serializeEditor } = factory('【', '】');

  const segments = parseDraft('前半【引用一】中间【引用二】结尾');
  ok('草稿被切成 文字/引用/文字/引用/文字', segments.length === 5
    && segments[0].type === 'text' && segments[1].type === 'quote' && segments[1].text === '引用一'
    && segments[3].text === '引用二' && segments[4].text === '结尾', JSON.stringify(segments));
  ok('没有引用时只有一段文字', parseDraft('就是普通一句话').length === 1);
  ok('空草稿没有片段', parseDraft('').length === 0);
  ok('未闭合的【当普通文字', parseDraft('只有【左括号').length === 1 && parseDraft('只有【左括号')[0].type === 'text');

  /* 假 DOM：文本节点 / 引用块 / <br> / 浏览器塞进来的 <div> 块 */
  const text = (value) => ({ nodeType: 3, textContent: value });
  const chip = (value) => ({ nodeType: 1, tagName: 'SPAN', getAttribute: (name) => (name === 'data-quote' ? value : null), childNodes: [text('“'), text(value)] });
  const br = { nodeType: 1, tagName: 'BR', getAttribute: () => null, childNodes: [] };
  const root = (nodes) => ({ nodeType: 1, tagName: 'DIV', childNodes: nodes });
  const block = (nodes) => ({ nodeType: 1, tagName: 'DIV', getAttribute: () => null, childNodes: nodes });

  ok('引用块还原成【原文】', serializeEditor(root([chip('引文')])) === '【引文】');
  ok('文字 + 引用 + 文字', serializeEditor(root([text('前半'), chip('引文'), text('后半')])) === '前半【引文】后半');
  ok('br 还原成换行', serializeEditor(root([text('a'), br, text('b')])) === 'a\nb');
  ok('浏览器塞的 div 块之间补换行', serializeEditor(root([block([text('一')]), block([text('二')])])) === '一\n二');
  ok('空编辑器序列化成空串', serializeEditor(root([])) === '');
  ok('没有节点时也不炸', serializeEditor(null) === '' && serializeEditor(undefined) === '');

  /* 往返：parseDraft 出来再序列化回去，文本不变 */
  const roundTrip = (value) => {
    const nodes = [];
    for (const segment of parseDraft(value)) nodes.push(segment.type === 'quote' ? chip(segment.text) : text(segment.text));
    return serializeEditor(root(nodes));
  };
  for (const value of ['【a】b', 'x【a】y【b】z', '普通文本', '【整段都是引用】']) {
    ok('往返不变：' + JSON.stringify(value), roundTrip(value) === value, JSON.stringify(roundTrip(value)));
  }
}

/* —— 没有 DOM 时的兜底：插到末尾 —— */
console.log('\n[2] 兜底插入（无 DOM / 编辑器不在文档里）');
{
  const block = sliceBlock(srcClient, 'const insertQuoteText = (draft, quoteText, caret) => {');
  ok('抽到 insertQuoteText', Boolean(block));
  const insert = new Function('QUOTE_OPEN', 'QUOTE_CLOSE', block + '\n return insertQuoteText;')('【', '】');

  ok('空草稿得到【原文】', insert('', '原文', 0).text === '【原文】');
  ok('接在末尾时补空格', insert('我的问题', '原文', 4).text === '我的问题 【原文】');
  ok('插在最前面时后面补空格', insert('我的问题', '原文', 0).text === '【原文】 我的问题');
  ok('光标落在插入内容之后', insert('前半后半', '原文', 2).caret === '前半 【原文】'.length);
  ok('多行引用压成一行', insert('', '第一行\n第二行', 0).text === '【第一行 第二行】');
  ok('空白引用不插入', insert('我的草稿', '   ', 2).text === '我的草稿');
}

/* —— 气泡渲染 —— */
console.log('\n[3] 气泡里：内联【…】与老消息的 > 引用块');
{
  const block = sliceBlock(srcClient, 'const renderUserText = (value) => {');
  const inlineBlock = sliceBlock(srcClient, 'const renderInlineQuotes = (line) => {');
  ok('抽到 renderUserText / renderInlineQuotes', Boolean(block) && Boolean(inlineBlock));
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() });
  const renderUserText = new Function('h', inlineBlock + '\n' + block + '\n return renderUserText;')(h);

  const inline = renderUserText('【这个功能可以做】那这条先搁置？');
  ok('正文里引用是一枚内联小块', inline[0].children[0].props.className === 'cw-quote-inline'
    && inline[0].children[0].children[0] === '这个功能可以做');
  ok('引用后面接着自己的话', inline[0].children.slice(1).join('') === '那这条先搁置？');

  const two = renderUserText('【A】可以，【B】再说。');
  ok('一句里两段引用各自成块',
    two[0].children.filter((child) => child && child.props && child.props.className === 'cw-quote-inline').length === 2);

  const legacy = renderUserText('> 老的引用\n我的问题');
  ok('老消息的 > 引用块照旧', legacy[0].props.className === 'cw-quote-block'
    && legacy[0].children[0].children[0] === '老的引用');
  ok('普通换行仍是纯文本', renderUserText('一\n二')[0].children.join('') === '一\n二');
  ok('空正文不炸', Array.isArray(renderUserText('')) && renderUserText('').length === 0);
}

/* —— 接线 —— */
console.log('\n[4] 接线：contenteditable 输入框 + 内联引用块');
{
  ok('输入框是 contenteditable 的 div', srcClient.includes("className: 'cw-editor'")
    && srcClient.includes('contentEditable: true'));
  ok('占位符走 data-placeholder（空编辑器才显示）', srcClient.includes("'data-placeholder':")
    && srcClient.includes('.cw-editor:empty::before'));
  ok('输入时把 DOM 序列化成草稿', srcClient.includes('setDraft(serializeEditor(editor))'));
  ok('草稿被外部改动时才重画（否则光标会被顶走）', srcClient.includes('if (serializeEditor(editor) === value) return;'));
  ok('重画时把引用画成小块', srcClient.includes('editor.appendChild(createQuoteChip(segment.text))'));
  ok('引用块是不可编辑的原子节点', srcClient.includes("chip.setAttribute('contenteditable', 'false')")
    && srcClient.includes("chip.setAttribute('data-quote', text)"));
  ok('引用插在光标处（不是只拼字符串）', srcClient.includes('range.insertNode(chip)'));
  ok('插入后光标落在引用后面', srcClient.includes('range.setStartAfter(space)'));
  ok('没有 DOM 时退回字符串插入', srcClient.includes('insertQuoteText(draft, text, draft.length)'));
  ok('粘贴纯文本走无格式插入', srcClient.includes("data.getData('text/plain')") && srcClient.includes('insertPlainText(plain)'));
  ok('Enter 发送、Shift+Enter 换行（换行是 <br>）', srcClient.includes("event.key === 'Enter' && !event.shiftKey")
    && srcClient.includes("if (tag === 'br') { out += '\\n'; return; }"));
  ok('IME 合成期间不误发', srcClient.includes('isComposing'));
  ok('上限仍是 2000 字', /QUOTE_MAX_CHARS = 2000/.test(srcClient));
  ok('选区只认同一条 .cw-msg', srcClient.includes("startEl.closest('.cw-msg')") && srcClient.includes('startMsg !== endMsg'));
  ok('浮动按钮 fixed + 边界夹紧 + 滚动收起', srcClient.includes('position: fixed')
    && srcClient.includes('window.innerWidth - 76') && srcClient.includes('if (quoteSel) setQuoteSel(null)'));
  ok('气泡里有内联引用样式', srcClient.includes('.cw-quote-inline{'));
  ok('引用块的样式（单行截断的小块）', srcClient.includes('.cw-editor-quote{') && srcClient.includes('text-overflow: ellipsis'));
  /* 形状照 DSH 截图：链接蓝、无底色无边框，后面直接接用户文字 */
  ok('引用用 DSH 的链接色，不带底色/边框', srcClient.includes('var(--dsw-alias-link') 
    && /\.cw-editor-quote\{[^}]*\}/.test(srcClient)
    && !/\.cw-editor-quote\{[^}]*background/.test(srcClient)
    && !/\.cw-editor-quote\{[^}]*border/.test(srcClient));
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);