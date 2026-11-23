/**
 * 引用选中文字（1.0.48 起改成「内联」形态）：
 *
 *   选中消息里的一段 → 浮动「引用」→ 原文以【…】插到**光标处**，跟正文一起可编辑、
 *   可删除；发出去后气泡里把【…】渲染成弱化小块（不再是输入框上方堆 chip）。
 *
 * 两段逻辑是抽真实源码在跑的：`insertQuoteText`（插入与光标）和 `renderUserText`
 * （气泡渲染）。选区本身依赖浏览器 Selection，这里没有浏览器可点，只能静态盯接线。
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

/* —— 插入：内联在光标处 —— */
console.log('\n[1] 引用插到光标处（【原文】），不再单独占一行');
{
  const block = sliceBlock(srcClient, 'const insertQuoteText = (draft, quoteText, caret) => {');
  ok('抽到 insertQuoteText', Boolean(block));
  const insert = new Function('QUOTE_OPEN', 'QUOTE_CLOSE', block + '\n return insertQuoteText;')('【', '】');

  const empty = insert('', '原文', 0);
  ok('空草稿直接得到【原文】', empty.text === '【原文】', JSON.stringify(empty.text));
  ok('光标停在引用之后', empty.caret === '【原文】'.length, String(empty.caret));

  const appended = insert('我的问题', '原文', 4);
  ok('接在末尾时补空格', appended.text === '我的问题 【原文】', JSON.stringify(appended.text));

  const front = insert('我的问题', '原文', 0);
  ok('插在最前面时后面补空格', front.text === '【原文】 我的问题', JSON.stringify(front.text));

  const middle = insert('前半后半', '原文', 2);
  ok('插在中间时两侧都补空格', middle.text === '前半 【原文】 后半', JSON.stringify(middle.text));
  ok('光标落在插入内容之后、不在最末尾', middle.caret === '前半 【原文】'.length, String(middle.caret));

  ok('光标越界时夹到末尾', insert('abc', 'x', 99).text === 'abc 【x】');
  ok('光标是负数时夹到开头', insert('abc', 'x', -5).text === '【x】 abc');
  ok('光标不是数字时按末尾处理', insert('abc', 'x', undefined).text === 'abc 【x】');

  /* 引用原文里的换行压成空格：内联引用跨行不好读 */
  ok('多行引用压成一行', insert('', '第一行\n第二行\n\n第三行', 0).text === '【第一行 第二行 第三行】',
    JSON.stringify(insert('', '第一行\n第二行', 0).text));
  ok('代码里的缩进也压掉', insert('', '  func() {\n    return 1;\n  }', 0).text === '【func() { return 1; }】');

  const blank = insert('我的草稿', '   ', 2);
  ok('空白引用不插入、光标不动', blank.text === '我的草稿' && blank.caret === 2);
}

/* —— 气泡渲染：内联引用 + 老消息的引用块 —— */
console.log('\n[2] 气泡里：内联【…】与老消息的 > 引用块');
{
  const block = sliceBlock(srcClient, 'const renderUserText = (value) => {');
  ok('抽到 renderUserText', Boolean(block));
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() });
  /* renderUserText 依赖 renderInlineQuotes：一并抽出来放进闭包 */
  const inlineBlock = sliceBlock(srcClient, 'const renderInlineQuotes = (line) => {');
  ok('抽到 renderInlineQuotes', Boolean(inlineBlock));
  const renderUserText = new Function('h', inlineBlock + '\n' + block + '\n return renderUserText;')(h);

  const inline = renderUserText('【这个功能可以做】那这条先搁置？');
  const inlineBlockNode = inline[0];
  ok('正文是一块纯文本', inlineBlockNode.props.className === 'cw-plain-block');
  const children = inlineBlockNode.children;
  ok('引用被切成一个内联小块', children[0].props.className === 'cw-quote-inline' && children[0].children[0] === '这个功能可以做',
    JSON.stringify(children[0]));
  ok('引用后面接着自己的话', children.slice(1).join('') === '那这条先搁置？', JSON.stringify(children.slice(1)));

  const two = renderUserText('【A】可以，【B】再说。');
  const spans = two[0].children.filter((child) => child && child.props && child.props.className === 'cw-quote-inline');
  ok('一句里两段引用各自成块', spans.length === 2 && spans[0].children[0] === 'A' && spans[1].children[0] === 'B');

  const legacy = renderUserText('> 老的引用\n我的问题');
  ok('老消息的 > 引用块照旧', legacy[0].props.className === 'cw-quote-block'
    && legacy[0].children[0].children[0] === '老的引用');
  ok('老消息正文里的换行不丢', legacy[1].props.className === 'cw-plain-block');

  const plain = renderUserText('就是一句普通的话\n第二行');
  ok('普通换行仍然是纯文本（行间是真换行符）', plain[0].children.join('') === '就是一句普通的话\n第二行',
    JSON.stringify(plain[0].children));

  ok('没有引用时没有内联块', renderUserText('普通的一句话').length === 1);
  ok('空正文不炸', Array.isArray(renderUserText('')) && renderUserText('').length === 0);
  ok('未闭合的【不被吞', renderUserText('只有左括号【abc').length === 1);
}

/* —— 接线与上限 —— */
console.log('\n[3] 接线：浮动按钮 → 插入草稿；顶部 chip 已移除');
{
  ok('上限仍是 2000 字', /QUOTE_MAX_CHARS = 2000/.test(srcClient));
  ok('超过 2000 字截断并提示', srcClient.includes('text.slice(0, QUOTE_MAX_CHARS)') && srcClient.includes('已截断'));
  ok('只在会话滚动区里响应松开鼠标', srcClient.includes('onMouseUp: captureQuote'));
  ok('锚点必须落在同一条 .cw-msg 里', srcClient.includes("startEl.closest('.cw-msg')") && srcClient.includes('startMsg !== endMsg'));
  ok('浮动按钮按视口坐标定位并夹紧', srcClient.includes('position: fixed') && srcClient.includes('window.innerWidth - 76'));
  ok('点别处 / Esc 收起按钮', srcClient.includes("closest('.cw-quotebtn')") && srcClient.includes("event.key === 'Escape'"));
  ok('滚动时收起按钮', srcClient.includes('if (quoteSel) setQuoteSel(null)'));

  ok('点引用是把文本插进草稿', srcClient.includes('insertQuoteText(draft, quoteSel.text, caret)'));
  ok('用输入框当前光标位置插入', srcClient.includes('area.selectionStart'));
  ok('插入后把光标放到引用之后', srcClient.includes('element.setSelectionRange(next.caret, next.caret)'));
  ok('插入后重算输入框高度', srcClient.includes("element.style.height = Math.min(336, element.scrollHeight) + 'px'"));

  ok('顶部 chip rail 已移除', !srcClient.includes('cw-quoterail') && !srcClient.includes('cw-quote-chip'));
  ok('不再往文首拼引用块', !srcClient.includes('quotePrefix'));
  ok('发送正文就是草稿本身', srcClient.includes('const content = plan + (fileRef ?') && !srcClient.includes('quotePrefix() + plan'));
  ok('气泡里有内联引用样式', srcClient.includes('.cw-quote-inline{'));
  ok('气泡用 renderUserText', srcClient.includes("h('div', { className: 'cw-bubble-user' }, renderUserText(item.text))"));
  ok('用户气泡没走 Markdown 组件', !srcClient.includes("cw-bubble-user' }, h(Markdown") && srcClient.includes("h(Markdown, { text: item.text || '' })"));
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);