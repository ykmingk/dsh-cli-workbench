/**
 * 排队消息列表（QueueCard）的**行为**：真把组件挂起来点一遍。
 *
 * 覆盖：逐条显示内容、撤回、就地修改（保存/取消）、引导式插入（追加末尾 / 插到某条之前）。
 * 不碰真实网络，onWithdraw/onEdit/onInsert 都是记录调用的假实现。
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
let store = null;
let hookIndex = 0;
const React = {
  createElement: element,
  Fragment: Symbol('Fragment'),
  useState(init) {
    const index = hookIndex++;
    if (!store[index]) store[index] = { value: typeof init === 'function' ? init() : init };
    return [store[index].value, (value) => {
      store[index].value = typeof value === 'function' ? value(store[index].value) : value;
    }];
  },
  useRef(init) {
    const index = hookIndex++;
    if (!store[index]) store[index] = { current: init };
    return store[index];
  },
  useMemo(fn) {
    const index = hookIndex++;
    if (!store[index]) store[index] = { value: fn() };
    return store[index].value;
  },
  useCallback(fn) {
    const index = hookIndex++;
    if (!store[index]) store[index] = { value: fn };
    return store[index].value;
  },
  useEffect(fn) {
    const index = hookIndex++;
    if (!store[index]) store[index] = {};
    return undefined;
  },
  useLayoutEffect() { return undefined; },
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

/* --------------------------------------------------------------- 挂载组件 */
const captured = [];
new Function('window', code)({ __ModuleLoader__: { load: (config) => captured.push(config) }, addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900 });
const plugin = captured[0].factory((name) => {
  if (name === 'react') return React;
  throw new Error('unexpected module ' + name);
});
const { QueueCard } = plugin.__parts || {};
ok('导出了 __parts.QueueCard', Boolean(QueueCard));
if (!QueueCard) { console.log('\n结果：0 通过 / 1 失败'); process.exit(1); }

/* ------------------------------------------------------------- 记录回调 */
const withdrawn = [];
const edited = [];
const inserted = [];
const props = {
  queued: [
    { id: 'q1', text: '把签名校验从 MD5 换成 HMAC-SHA256', at: Date.now() - 60000 },
    { id: 'q2', text: '顺便补上边界用例', at: Date.now() - 30000 },
    { id: 'q3', text: '最后跑一遍 pnpm test', at: Date.now() },
  ],
  onWithdraw: async (id) => { withdrawn.push(id); },
  onEdit: async (id, text) => { edited.push({ id, text }); },
  onInsert: async (text, beforeId) => { inserted.push({ text, beforeId }); },
};

function render() {
  hookIndex = 0;
  return QueueCard(props);
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const walk = (node, out = []) => {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) walk(child, out); return out; }
  out.push(node);
  for (const child of node.children || []) walk(child, out);
  return out;
};
const texts = (tree) => walk(tree).flatMap((node) => (node.children || []).filter((c) => typeof c === 'string'));
const byClass = (tree, token) => walk(tree).filter((node) => String((node.props && node.props.className) || '').split(/\s+/).includes(token));
const buttonByText = (tree, text) => walk(tree).find((node) => node.type === 'button' && (node.children || []).includes(text));
const textarea = (tree) => walk(tree).find((node) => node.type === 'textarea');

let tree;
store = [];
tree = render();

console.log('\n[1] 渲染');
{
  ok('渲染出 3 条排队消息', byClass(tree, 'cw-queue-row').length === 3, String(byClass(tree, 'cw-queue-row').length));
  ok('逐条显示内容', ['把签名校验从 MD5 换成 HMAC-SHA256', '顺便补上边界用例', '最后跑一遍 pnpm test'].every((text) => texts(tree).includes(text)));
  ok('头部写「排队中 3 条」', texts(tree).some((text) => text === '排队中 3 条'));
  const numbers = byClass(tree, 'cw-queue-no').map((node) => (node.children || [])[0]);
  ok('序号 1/2/3 都在', JSON.stringify(numbers) === '[1,2,3]', JSON.stringify(numbers));
  ok('有「插入」按钮', Boolean(buttonByText(tree, '插入')));
}

console.log('\n[2] 撤回');
{
  const danger = byClass(tree, 'is-danger').find((node) => node.type === 'button');
  ok('每条都有撤回按钮', byClass(tree, 'cw-queue-op').filter((node) => String(node.props.className).includes('is-danger')).length === 3);
  const firstRow = byClass(tree, 'cw-queue-row')[0];
  const withdrawBtn = walk(firstRow).find((node) => node.type === 'button' && String(node.props.className).includes('is-danger'));
  await withdrawBtn.props.onClick();
  ok('撤回回调收到第一条的 id', withdrawn.length === 1 && withdrawn[0] === 'q1', JSON.stringify(withdrawn));
}

console.log('\n[3] 修改（保存与取消）');
{
  const secondRow = byClass(tree, 'cw-queue-row')[1];
  const editBtn = walk(secondRow).find((node) => node.type === 'button' && node.props.title === '修改');
  editBtn.props.onClick();
  tree = render();
  ok('点修改后出现输入框', Boolean(textarea(tree)));
  ok('输入框预填原内容', textarea(tree).props.value === '顺便补上边界用例', textarea(tree).props.value);

  textarea(tree).props.onChange({ target: { value: '改成跑集成测试' } });
  tree = render();
  ok('输入框跟着打字更新', textarea(tree).props.value === '改成跑集成测试');

  const save = buttonByText(tree, '保存');
  await save.props.onClick();
  ok('保存回调收到新正文', edited.length === 1 && edited[0].id === 'q2' && edited[0].text === '改成跑集成测试', JSON.stringify(edited));
  tree = render();
  ok('保存后输入框收起', !textarea(tree));

  /* 取消：不回调 */
  const thirdRow = byClass(tree, 'cw-queue-row')[2];
  walk(thirdRow).find((node) => node.type === 'button' && node.props.title === '修改').props.onClick();
  tree = render();
  buttonByText(tree, '取消').props.onClick();
  tree = render();
  ok('取消后输入框收起、不回调', !textarea(tree) && edited.length === 1);
}

console.log('\n[4] 插入（追加到末尾）');
{
  buttonByText(tree, '插入').props.onClick();
  tree = render();
  ok('点插入后出现输入框', Boolean(textarea(tree)));
  ok('占位提示是「追加到末尾」', textarea(tree).props.placeholder.includes('追加到末尾'), textarea(tree).props.placeholder);

  textarea(tree).props.onChange({ target: { value: '补一条收尾' } });
  tree = render();
  const confirm = buttonByText(tree, '加入队列');
  await confirm.props.onClick();
  ok('追加回调 beforeId 为 null', inserted.length === 1 && inserted[0].text === '补一条收尾' && inserted[0].beforeId === null, JSON.stringify(inserted));
  tree = render();
  ok('提交后输入框收起', !textarea(tree));
}

console.log('\n[5] 插入（插到某条之前）');
{
  const secondRow = byClass(tree, 'cw-queue-row')[1];
  const beforeBtn = walk(secondRow).find((node) => node.type === 'button' && String(node.props.className).includes('cw-queue-before'));
  ok('条目上有「插到前面」的按钮', Boolean(beforeBtn));
  beforeBtn.props.onClick();
  tree = render();
  ok('占位提示是「插到它前面」', textarea(tree).props.placeholder.includes('插到它前面'), textarea(tree).props.placeholder);

  textarea(tree).props.onChange({ target: { value: '插到 q2 前' } });
  tree = render();
  const confirm = buttonByText(tree, '插到这里');
  await confirm.props.onClick();
  ok('前插回调带上目标 id', inserted.length === 2 && inserted[1].text === '插到 q2 前' && inserted[1].beforeId === 'q2', JSON.stringify(inserted));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);