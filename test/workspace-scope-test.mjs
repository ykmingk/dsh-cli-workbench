/**
 * 工作区按助手「只在这一侧移除」：同一目录两个助手都在用的时候，
 * 从 Claude 侧移除不能把 Codex 的会话打散到「未分组」。
 *
 * removeWorkspace / ensureWorkspace 是抽真实源码 + 假 this 跑的；
 * hiddenFor 的显示过滤与撤销/确认文案用静态断言盯住。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(rootDir, 'index.js'), 'utf8');
const clientSrc = fs.readFileSync(path.join(rootDir, 'client.js'), 'utf8');

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

const removeBlock = sliceBlock(src, 'removeWorkspace(dir, provider) {');
const ensureBlock = sliceBlock(src, 'ensureWorkspace(dir, titleOverride, provider) {');
ok('抽到 removeWorkspace(dir, provider)', Boolean(removeBlock));
ok('抽到 ensureWorkspace(dir, titleOverride, provider)', Boolean(ensureBlock));

/* 方法源码以「方法名(参数) {」开头：转成独立函数时把名字换成 function 声明。 */
const toFunction = (block, name) => {
  const brace = block.indexOf('{');
  return 'function ' + name + block.slice(block.indexOf('('), brace) + ' ' + block.slice(brace);
};

/* 拼一个最小工作台：workspaces / sessions 两个 Map，save 记一下次数。 */
const factory = new Function(
  'path', 'now', 'oneLine', 'text', 'realCwd',
  `const ${'removeWorkspace'} = ${toFunction(removeBlock, 'removeWorkspace')};
   const ensureWorkspace = ${toFunction(ensureBlock, 'ensureWorkspace')};
   return { removeWorkspace, ensureWorkspace };`,
);
const dirA = path.join('C:', 'tmp', 'xxxx工作');
const wb = factory(
  path,
  () => Date.now(),
  (value) => String(value),
  (value) => (value == null ? '' : String(value)),
  (value) => String(value),
);
const make = () => {
  const state = {
    workspaces: new Map(),
    sessions: new Map(),
    saves: 0,
    save() { this.saves += 1; },
  };
  state.workspaces.set(dirA.toLowerCase(), {
    cwd: dirA, title: 'xxxx工作', addedAt: 1, hiddenFor: [],
  });
  state.sessions.set('s1', { provider: 'claude', cwd: dirA, archived: false });
  state.sessions.set('s2', { provider: 'codex', cwd: dirA, archived: false });
  return state;
};

/* 两侧都有会话：Claude 侧移除 → 只隐藏，登记还在 */
const a = make();
const removed = wb.removeWorkspace.call(a, dirA, 'claude');
ok('另一侧还有会话时只隐藏', removed && removed.hidden === true);
ok('全局登记没被删掉', a.workspaces.has(dirA.toLowerCase()));
ok('hiddenFor 记下当前助手', JSON.stringify(a.workspaces.get(dirA.toLowerCase()).hiddenFor) === '["claude"]');

/* Codex 侧仍然可见：hiddenFor 不含 codex */
ok('另一侧不受影响', !a.workspaces.get(dirA.toLowerCase()).hiddenFor.includes('codex'));

/* 只剩当前助手会话：照旧整条删除 */
const b = make();
b.sessions.delete('s2');
const removedB = wb.removeWorkspace.call(b, dirA, 'claude');
ok('没有另一侧会话时整条删除', removedB && removedB.hidden === false && !b.workspaces.has(dirA.toLowerCase()));

/* 撤销 / 新建会话把当前助手从 hiddenFor 放出来 */
const c = make();
wb.removeWorkspace.call(c, dirA, 'claude');
wb.ensureWorkspace.call(c, dirA, null, 'claude');
ok('恢复后当前助手重新可见', c.workspaces.get(dirA.toLowerCase()).hiddenFor.length === 0);

/* 旧数据没有 hiddenFor：按空数组处理，不影响删除判断 */
const d = make();
d.workspaces.get(dirA.toLowerCase()).hiddenFor = undefined;
const removedD = wb.removeWorkspace.call(d, dirA, 'claude');
ok('老数据缺 hiddenFor 也能隐藏', removedD.hidden === true
  && JSON.stringify(d.workspaces.get(dirA.toLowerCase()).hiddenFor) === '["claude"]');

/* —— 客户端接线 —— */
ok('左栏按 hiddenFor 过滤当前助手', clientSrc.includes('entry.hiddenFor.includes(provider)'));
ok('删除请求带 provider', clientSrc.includes("'&provider=' + encodeURIComponent(wsDelete.provider)"));
ok('确认框说明只移除这一侧', clientSrc.includes('只从 ') && clientSrc.includes('另一侧仍按工作区分组'));
ok('撤销按当前助手恢复', clientSrc.includes('restoreWorkspace(removed.cwd, removed.title, removed.provider)'));
ok('工作区列表回传 hiddenFor', src.includes('hiddenFor: Array.isArray(entry.hiddenFor) ? entry.hiddenFor : []'));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);