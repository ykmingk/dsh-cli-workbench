/**
 * 1.0.4 验证：turnPhase 状态推进 + items 截断计数。
 *
 * 与 datadir-test 一样，直接抽取 index.js 里 push() 的真实源码执行，
 * 保证测的就是线上那段代码，而不是复制品。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INDEX = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'index.js');
const src = fs.readFileSync(INDEX, 'utf8');

const extractMethod = (signature) => {
  const start = src.indexOf(signature);
  if (start < 0) throw new Error('找不到 ' + signature);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start + signature.length, i); }
  }
  throw new Error('括号不配对');
};

const pushBody = extractMethod('push(session, item) {');
const push = new Function('session', 'item', 'MAX_ITEMS', pushBody);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

const noop = { emit() {}, touch() {} };
const MAX = 600;

console.log('\n[turnPhase] 由 push 的条目类型推进');
{
  const session = { items: [] };
  const run = (item) => push.call(noop, session, item, MAX);

  run({ kind: 'user', text: 'hi' });
  ok('user 条目不改变阶段', session._turnPhase === undefined);

  run({ kind: 'thinking', text: '' });
  ok('thinking → streaming', session._turnPhase === 'streaming');

  run({ kind: 'tool', name: 'Bash' });
  ok('tool → tool', session._turnPhase === 'tool');

  run({ kind: 'assistant', text: 'ok' });
  ok('assistant → 回到 streaming', session._turnPhase === 'streaming');

  run({ kind: 'notice', text: '' });
  ok('notice 不干扰阶段', session._turnPhase === 'streaming');
}

console.log('\n[omittedItems] 超限截断与累计计数');
{
  const session = { items: [] };
  for (let i = 0; i < 605; i++) push.call(noop, session, { kind: 'assistant', text: 'm' + i }, MAX);
  ok('内存里只保留 MAX_ITEMS 条', session.items.length === MAX, '→ ' + session.items.length);
  ok('记录了被裁掉的 5 条', session.itemBase === 5, '→ itemBase=' + session.itemBase);
  ok('保留的是最新的那批', session.items[MAX - 1].text === 'm604', '→ ' + session.items[MAX - 1].text);

  for (let i = 0; i < 7; i++) push.call(noop, session, { kind: 'assistant', text: 'n' + i }, MAX);
  ok('计数跨批次累加', session.itemBase === 12, '→ itemBase=' + session.itemBase);

  // 未超限时不该产生计数
  const small = { items: [] };
  for (let i = 0; i < 10; i++) push.call(noop, small, { kind: 'assistant', text: 'x' }, MAX);
  ok('未超限时 itemBase 为空', !small.itemBase, '→ ' + String(small.itemBase));
}

console.log('\n[契约] 字段确实对外暴露且能被读回');
{
  ok('publicSession 暴露 turnPhase', src.includes('turnPhase: session._turnPhase || null'));
  ok('publicSession 暴露 turnStartedAt', src.includes('turnStartedAt: Number(session._turnStartedAt) || null'));
  ok('publicSession 暴露 omittedItems', src.includes('omittedItems: Number(session.itemBase) || 0'));
  ok('load() 恢复 itemBase', src.includes('itemBase: Number(raw.itemBase) || 0'));
  ok('回合结束清空阶段', (src.match(/_turnPhase = null/g) || []).length >= 3, '→ 清空点 ' + (src.match(/_turnPhase = null/g) || []).length + ' 处');
  ok('发送时进入 spawn 阶段', src.includes("session._turnPhase = 'spawn'"));
  ok('进程起来后进入 waiting', (src.match(/_turnPhase = 'waiting'/g) || []).length === 2, '→ ' + (src.match(/_turnPhase = 'waiting'/g) || []).length + ' 处（claude + codex）');
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);