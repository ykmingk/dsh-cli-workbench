/**
 * 左栏批量操作的「全选」：要覆盖收起分组里、以及被「展开剩余」截断的会话。
 *
 * 1.0.8 的审计改动曾把全选限制成「只勾可见」，用户 1.0.61 明确反馈「点全选时
 * 被隐藏的会话不会被选中」。现在全选覆盖当前过滤结果的全部会话，条上写清
 * 「含 N 个未显示」，再点一次是取消全选。
 *
 * Rail 是纯渲染组件（状态都在 App），这里直接调用它，点按钮看回调拿到什么。
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

/* ------------------------------------------------------------- React shim */
const element = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() });
let store = [];
let hookIndex = 0;
const React = {
  createElement: element,
  Fragment: Symbol('Fragment'),
  useState(init) {
    const index = hookIndex++;
    if (!store[index]) store[index] = { value: typeof init === 'function' ? init() : init };
    return [store[index].value, (value) => { store[index].value = value; }];
  },
  useRef(init) {
    const index = hookIndex++;
    if (!store[index]) store[index] = { current: init };
    return store[index];
  },
  useMemo(fn) { const i = hookIndex++; if (!store[i]) store[i] = { value: fn() }; return store[i].value; },
  useCallback(fn) { const i = hookIndex++; if (!store[i]) store[i] = { value: fn }; return store[i].value; },
  useEffect() { const i = hookIndex++; if (!store[i]) store[i] = {}; return undefined; },
  useLayoutEffect() { const i = hookIndex++; if (!store[i]) store[i] = {}; return undefined; },
};
class ShimComponent {
  constructor(props) { this.props = props || {}; }
  setState(updater) { this.state = { ...this.state, ...(typeof updater === 'function' ? updater(this.state) : updater) }; }
}
React.Component = ShimComponent;
global.setInterval = () => 0;
global.clearInterval = () => {};
global.requestAnimationFrame = (fn) => { fn(0); return 0; };
global.cancelAnimationFrame = () => {};
global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' });

const captured = [];
new Function('window', code)({ __ModuleLoader__: { load: (config) => captured.push(config) }, addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900 });
const plugin = captured[0].factory((name) => {
  if (name === 'react') return React;
  throw new Error('unexpected module ' + name);
});
const { Rail } = plugin.__parts || {};
ok('导出了 __parts.Rail', Boolean(Rail));
if (!Rail) { console.log('\n结果：0 通过 / 1 失败'); process.exit(1); }

const walk = (node, out = []) => {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) walk(child, out); return out; }
  out.push(node);
  for (const child of node.children || []) walk(child, out);
  return out;
};
const texts = (tree) => walk(tree).flatMap((node) => (node.children || []).filter((c) => typeof c === 'string'));
const buttonByText = (tree, text) => walk(tree).find((node) => node.type === 'button'
  && ((node.children || []).includes(text) || String((node.children || []).join('')) === text));
const byClass = (tree, token) => walk(tree).filter((node) => String((node.props && node.props.className) || '').split(/\s+/).includes(token));

/* ------------------------------------------------------------ 数据：两处「隐藏」 */
/* A 组 6 个会话（默认档只显示 4 个 → 2 个被「展开剩余」藏住）
   B 组 2 个会话，整组被收起（collapsed → 2 个全藏） */
const mk = (id, cwd, extra = {}) => ({
  id, provider: 'claude', cwd, title: '会话 ' + id, status: 'idle', updatedAt: Date.now(),
  files: [], archived: false, ...extra,
});
const sessions = [
  mk('a1', 'D:\\a'), mk('a2', 'D:\\a'), mk('a3', 'D:\\a'), mk('a4', 'D:\\a'),
  mk('a5', 'D:\\a'), mk('a6', 'D:\\a'),
  mk('b1', 'D:\\b'), mk('b2', 'D:\\b'),
  mk('old', 'D:\\a', { archived: true }),   // 归档的不在左栏，也不该被全选
];
const workspaces = [
  { cwd: 'D:\\a', title: 'a', provider: 'claude' },
  { cwd: 'D:\\b', title: 'b', provider: 'claude' },
];

let selectedNow = new Set();
let selectAllArg = null;
const noop = () => {};
const props = {
  sessions,
  workspaces,
  registryReady: true,
  currentId: null,
  provider: 'claude',
  query: '',
  setQuery: noop,
  fold: { 'D:\\b': 'collapsed' },
  toggleFold: noop,
  expandGroup: noop,
  batch: true,
  selected: selectedNow,
  toggleSelect: noop,
  selectAll: (list) => { selectAllArg = list.map((session) => session.id); },
  onNew: noop, onNewIn: noop, onAddWorkspace: noop, onOpen: noop, onMenu: noop,
  onGroupMenu: noop, onToggleSelect: noop,
  onArchiveSelected: noop, onDeleteSelected: noop, onExitBatch: noop,
};

const render = (patch = {}) => {
  hookIndex = 0;
  return Rail({ ...props, ...patch });
};

console.log('\n[1] 默认态：全选把收起的和截断的都算进去');
{
  const tree = render();
  ok('条上写「已选 0 项」', texts(tree).some((text) => text === '已选 0 项'), JSON.stringify(texts(tree).slice(-6)));
  const all = buttonByText(tree, '全选');
  ok('有「全选」按钮', Boolean(all));
  all.props.onClick();
  const got = (selectAllArg || []).slice().sort();
  ok('全选 8 个未归档会话（a1-a6 + b1-b2）', got.length === 8 && !got.includes('old'),
    JSON.stringify(got));
  ok('收起分组里的 b1/b2 也在其中', got.includes('b1') && got.includes('b2'));
  ok('被「展开剩余」藏住的 a5/a6 也在其中', got.includes('a5') && got.includes('a6'));
}

console.log('\n[2] 已经全选时：按钮变成取消全选');
{
  const tree = render({ selected: new Set(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'b1', 'b2']) });
  ok('按钮文案变成「取消全选」', Boolean(buttonByText(tree, '取消全选')), JSON.stringify(texts(tree).slice(-6)));
  ok('已选 8 项（4 个未显示也说清楚）', texts(tree).some((text) => String(text).startsWith('已选 8 项')),
    JSON.stringify(texts(tree).slice(-6)));
  buttonByText(tree, '取消全选').props.onClick();
  ok('再点一次清空选择', Array.isArray(selectAllArg) && selectAllArg.length === 0, JSON.stringify(selectAllArg));
}

console.log('\n[3] 选中的里有看不见的：条上要明说');
{
  const tree = render({ selected: new Set(['a1', 'a5', 'b1']) });
  const count = byClass(tree, 'cw-bcount')[0];
  ok('计数里写明含几个未显示', String((count.children || [])[0] || '').includes('含 2 个未显示')
    || String((count.children || [])[0] || '').includes('（含 2 个未显示）'),
  JSON.stringify(count.children));
  ok('悬停能看到具体说明', /收起的分组|展开剩余/.test(String(count.props.title || '')), String(count.props.title));
  ok('没选隐藏项时不写这句', (() => {
    const plain = render({ selected: new Set(['a1']) });
    return !String((byClass(plain, 'cw-bcount')[0].children || [])[0] || '').includes('未显示');
  })());
}

console.log('\n[3b] 勾选跨搜索累积：不在当前列表的也要说明');
{
  /* 搜「a1」只剩一条，但之前勾过 b1；条上要写「1 个不在当前列表」 */
  const tree = render({ query: 'a1', selected: new Set(['a1', 'b1']) });
  const count = byClass(tree, 'cw-bcount')[0];
  const label = String((count.children || [])[0] || '');
  ok('计数里说明不在当前列表的个数', label.includes('不在当前列表'), label);
  ok('悬停解释来源', /切过关键词/.test(String(count.props.title || '')), String(count.props.title));
}

console.log('\n[4] 搜索过滤后：全选只覆盖搜索结果');
{
  const tree = render({ query: '会话 b1' });
  const all = buttonByText(tree, '全选');
  all.props.onClick();
  ok('只选中命中的 b1（b2 被 b1 挤掉但同为收起组，理应也命中同关键字？）', Array.isArray(selectAllArg),
    JSON.stringify(selectAllArg));
  /* 关键字「会话 b1」只命中 b1 的标题 */
  ok('搜索结果里的全选不含未命中的', selectAllArg.length === 1 && selectAllArg[0] === 'b1', JSON.stringify(selectAllArg));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);