/**
 * CSS 常量（`const CSS = String.raw\`…\``）不能被破坏性字符截断。
 *
 * 为什么会写这个：1.0.46 第一版在 CSS 注释里写了未转义的反引号，模板在注释处
 * 提前结束，于是后面整段 CSS 被当成 JS 的乘法/比较表达式求值——文件语法仍然
 * 合法、界面照常渲染，只是 `CSS` 变成了一个数字，**整个工作台没有样式**。
 *
 * 两个盲区让当时的自动化没发现：
 *   - `.dev/shot-quote.mjs` / `.dev/preview.mjs` 是按字符串切 CSS 的，切出来的
 *     文本本身是合法 CSS（反引号在 /* *\/ 注释里），渲染当然正常；
 *   - `client-render.mjs` 只断言类名与节点，不看样式是否真的注入。
 *
 * 所以这里直接**求值那段表达式**，确认它是一段等于源码文本的字符串。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const code = fs.readFileSync(path.join(rootDir, 'client.js'), 'utf8');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

const MARK = 'const CSS = String.raw`';

console.log('\n[1] 模板本身：结束在正确的位置');
const markIndex = code.indexOf(MARK);
ok('找得到 CSS 常量', markIndex >= 0);
const start = markIndex + MARK.length;

/* 按 JS 词法找模板结束：反斜杠转义先吃掉；否则遇到反引号就结束。 */
let end = start;
let escaped = false;
for (; end < code.length; end++) {
  const ch = code[end];
  if (escaped) { escaped = false; continue; }
  if (ch === '\\') { escaped = true; continue; }
  if (ch === '`') break;
}
ok('模板有结束反引号', end < code.length);
const after = code.slice(end, end + 4);
ok('结束反引号后面直接是分号（没有被提前截断）', after.startsWith('`;'), JSON.stringify(after));
/* 更硬的一条：源码里第一个「换行+反引号+分号」必须正好是词法找到的结束符。
   模板被提前截断时（比如注释里写了反引号），两者就对不上。 */
ok('词法结束位置 = 源码里第一个模板终止符', code.indexOf('\n`;', start) + 1 === end,
  'literal=' + (code.indexOf('\n`;', start) + 1) + ' lexed=' + end);
const closingLine = code.slice(0, end).split('\n');
ok('结束反引号独占一行末尾', closingLine[closingLine.length - 1] === '', JSON.stringify(closingLine[closingLine.length - 1].slice(-40)));

/* 整段模板文本里不能再有不配对的模板语法 */
const cssText = code.slice(start, end);
ok('CSS 文本里没有未转义的反引号', !cssText.includes('`'));
ok('CSS 文本里没有模板插值（美元 + 花括号）', !cssText.includes('$' + '{'));

console.log('\n[2] 求值出来必须是字符串（而不是数字 / 布尔）');
const expr = code.slice(markIndex + 'const CSS = '.length, end + 1);
let css;
let threw = '';
try { css = new Function('return ' + expr)(); } catch (error) { threw = String((error && error.message) || error); }
ok('表达式能求值', !threw, threw);
ok('求值结果是字符串', typeof css === 'string', typeof css);
ok('长度与源码文本一致', css === cssText, 'source=' + cssText.length + ' value=' + (typeof css === 'string' ? css.length : 'n/a'));
ok('样式表不是空串', typeof css === 'string' && css.length > 80000, String(css && css.length));

console.log('\n[3] 关键规则都还在（末尾的规则最容易被截断吞掉）');
for (const token of ['.cw-root', '.cw-rail', '.cw-bubble-user', '.cw-quote-block', '.cw-quote-inline', '.cw-editor', '.cw-editor-quote', '.cw-quotebtn', '.cw-send', '.cw-tolatest']) {
  ok('包含 ' + token, typeof css === 'string' && css.includes(token));
}
ok('首尾都完整（首字符非空、末字符是换行）', typeof css === 'string' && css.trim().length > 0 && css.endsWith('\n'));
ok('括号配平（坏掉的 CSS 通常从这里开始）', (function () {
  if (typeof css !== 'string') return false;
  let depth = 0;
  for (const ch of css) {
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth < 0) return false; }
  }
  return depth === 0;
}()));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);