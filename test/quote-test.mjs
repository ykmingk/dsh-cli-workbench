/**
 * 引用选中文字（1.0.46）。
 *
 * 两段逻辑是**抽真实源码**在跑的：`renderUserText`（消息气泡里的引用块）与
 * `quotePrefix`（发给 CLI 的 `> ` 文本）。剩下的是接线断言——选区捕获依赖浏览器
 * 的 Selection API，这里没有浏览器可点。
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

/* —— 气泡渲染：行首 `> ` 变成引用块，其余仍是纯文本 —— */
console.log('\n[1] 消息气泡：`> ` 渲染成引用块');
{
  const block = sliceBlock(srcClient, 'const renderUserText = (value) => {');
  ok('抽到 renderUserText', Boolean(block));
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() });
  const renderUserText = new Function('h', block + '\n return renderUserText;')(h);

  const quoted = renderUserText('> 原来的那段话\n我的问题');
  ok('第一块是引用', quoted[0].props.className === 'cw-quote-block');
  ok('引用块里是原文，且不带 `> `', quoted[0].children[0].children[0] === '原来的那段话');
  ok('后面仍是纯文本块', quoted[1].props.className === 'cw-plain-block' && quoted[1].children[0] === '我的问题');

  const multi = renderUserText('> 第一行\n> 第二行\n\n> 隔着空行的另一段\n收尾');
  const quoteBlocks = multi.filter((node) => node.props.className === 'cw-quote-block');
  ok('多行引用仍是同一块（每行一条）', quoteBlocks[0].children.length === 2
    && quoteBlocks[0].children[1].children[0] === '第二行');
  ok('空行把引用切断成两段', quoteBlocks.length === 2);
  ok('空行以后还能回到纯文本', multi[multi.length - 1].children[0].includes('收尾'));

  const plain = renderUserText('就是一句普通的话\n第二行');
  ok('没有 `> ` 时仍是纯文本、换行不丢', plain.length === 1
    && plain[0].props.className === 'cw-plain-block'
    && plain[0].children[0] === '就是一句普通的话\n第二行');
  ok('只给一个 `>` 不炸', renderUserText('>').length === 1);
  ok('空正文不炸', Array.isArray(renderUserText('')) && renderUserText('').length === 0);
  ok('引用块末尾的空行不渲染成空白块', renderUserText('> 原文\n\n').length === 1);
}

/* —— 发给 CLI 的引用块 —— */
console.log('\n[2] 发给 CLI 的 `> ` 引用块');
{
  const block = sliceBlock(srcClient, 'const quotePrefix = () => {');
  ok('抽到 quotePrefix', Boolean(block));
  const make = (quotes) => new Function('quotes', block + '\n return quotePrefix;')(quotes);

  ok('没有引用时是空串', make([])() === '');
  ok('单段单行', make([{ text: '原文' }])() === '> 原文\n\n');
  ok('多行每行都加 `> `', make([{ text: '一\n二' }])() === '> 一\n> 二\n\n');
  ok('两段之间空一行', make([{ text: 'a' }, { text: 'b' }])() === '> a\n\n> b\n\n');
  ok('引用块后面接正文时是一整段', (make([{ text: 'a' }])() + '我的问题').startsWith('> a\n\n我的问题'));
}

/* —— 上限与接线 —— */
console.log('\n[3] 选区捕获与草稿 chip 的接线');
{
  ok('上限是 5 段 / 2000 字', /QUOTE_MAX_ITEMS = 5/.test(srcClient) && /QUOTE_MAX_CHARS = 2000/.test(srcClient));
  ok('超过 2000 字截断并提示', srcClient.includes('text.slice(0, QUOTE_MAX_CHARS)') && srcClient.includes('已截断'));
  ok('只在会话滚动区里响应松开鼠标', srcClient.includes('onMouseUp: captureQuote'));
  ok('锚点必须落在同一条 .cw-msg 里', srcClient.includes("startEl.closest('.cw-msg')")
    && srcClient.includes('startMsg !== endMsg'));
  ok('浮动按钮按视口坐标定位并做边界夹紧', srcClient.includes('position: fixed')
    && srcClient.includes('window.innerWidth - 76'));
  ok('点别处 / Esc 收起按钮', srcClient.includes("closest('.cw-quotebtn')") && srcClient.includes("event.key === 'Escape'"));
  ok('滚动时收起（fixed 定位会跟丢）', srcClient.includes('if (quoteSel) setQuoteSel(null)'));
  ok('草稿里有引用 chip 与「清空」', srcClient.includes("className: 'cw-quoterail'")
    && srcClient.includes("className: 'cw-quote-clear'"));
  ok('chip 能单独移除', srcClient.includes('current.filter((item) => item.id !== entry.id)'));
  ok('引用块排在正文最前面', srcClient.includes("const composed = quotePrefix() + plan")
    && srcClient.includes("const content = quotePrefix() + plan"));
  ok('发出去就清空引用', srcClient.includes('setQuotes([]);'));
  ok('建会话失败时把引用还回去', srcClient.includes('setQuotes(pendingQuotes)'));
  ok('切会话清空引用（不跨会话带）', srcClient.includes('useEffect(() => { setQuotes([]); }, [currentId])'));
  ok('气泡改用 renderUserText', srcClient.includes("h('div', { className: 'cw-bubble-user' }, renderUserText(item.text))"));
  /* 用户气泡只做引用块，不给整段 Markdown：助手回复那条仍然走 Markdown 组件。 */
  ok('用户气泡没有走 Markdown 组件',
    !srcClient.includes("cw-bubble-user' }, h(Markdown") && srcClient.includes('h(Markdown, { text: item.text || \'\' })'));
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);