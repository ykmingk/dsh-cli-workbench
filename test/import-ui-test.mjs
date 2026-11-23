/**
 * 「从 CLI 导入会话」弹窗的**行为**：真把组件挂起来点一遍。
 *
 * 覆盖：扫描结果渲染、搜索过滤、目录缺失的行禁选、全选只作用于可见行、
 * 勾选后「导入 N 个」跟着变、已选计数、Esc 关闭。
 * 不碰真实网络（fetch 被替换），也不碰 CLI 记录。
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
    if (hookSink) hookSink.push(fn);
    return undefined;
  },
  useLayoutEffect() { return undefined; },
};
class ShimComponent {
  constructor(props) { this.props = props || {}; }
  setState(updater) { this.state = { ...this.state, ...(typeof updater === 'function' ? updater(this.state) : updater) }; }
}
React.Component = ShimComponent;
let hookSink = null;
global.setInterval = () => 0;
global.clearInterval = () => {};
global.requestAnimationFrame = (fn) => { fn(0); return 0; };
global.cancelAnimationFrame = () => {};

/* ------------------------------------------------------------------- 假数据 */
const ENTRIES = [
  { provider: 'claude', nativeId: 'aaaa1111-2222-3333-4444-555566667777', cwd: 'D:\\proj\\pay-flow', title: '把签名校验换成 HMAC', updatedAt: Date.now() - 3600000, size: 482133, archived: false, missingCwd: false },
  { provider: 'claude', nativeId: 'bbbb1111-2222-3333-4444-555566667777', cwd: 'D:\\proj\\old', title: '旧项目：导出脚本拆开', updatedAt: Date.now() - 86400000 * 5, size: 204800, archived: false, missingCwd: true },
  { provider: 'codex', nativeId: 'cccc1111-2222-3333-4444-555566667777', cwd: 'D:\\proj\\pay-flow', title: '查一下分期费率', updatedAt: Date.now() - 900000, size: 900211, archived: false, missingCwd: false },
  { provider: 'codex', nativeId: 'dddd1111-2222-3333-4444-555566667777', cwd: 'C:\\Users\\Administrator', title: '只回复两个字：收到', updatedAt: Date.now() - 86400000 * 3, size: 51000, archived: true, missingCwd: false },
];
const calls = [];
global.fetch = async (url, init = {}) => {
  const pathname = String(url).replace(/^https?:\/\/[^/]+/, '').replace('/cli-workbench/api', '').split('?')[0];
  calls.push({ path: pathname, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
  if (pathname === '/import/scan') {
    return { ok: true, status: 200, json: async () => ({ entries: ENTRIES, claudeDir: 'C:\\c', codexDir: 'C:\\x' }) };
  }
  if (pathname === '/import') return { ok: true, status: 200, json: async () => ({ created: [{ id: 'cw_x', provider: 'claude' }], skipped: [], sessions: [], workspaces: [] }) };
  return { ok: true, status: 200, json: async () => ({}) };
};

/* --------------------------------------------------------------- 挂载组件 */
const captured = [];
new Function('window', code)({ __ModuleLoader__: { load: (config) => captured.push(config) }, addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900 });
const plugin = captured[0].factory((name) => {
  if (name === 'react') return React;
  throw new Error('unexpected module ' + name);
});
const { ImportDialog } = plugin.__parts || {};
ok('导出了 __parts.ImportDialog', Boolean(ImportDialog));
if (!ImportDialog) { console.log('\n结果：0 通过 / 1 失败'); process.exit(1); }

let closed = 0;
let imported = null;
store = [];
const props = { onClose: () => { closed += 1; }, onImported: (result) => { imported = result; } };

function render() {
  hookIndex = 0;
  const effects = [];
  hookSink = effects;
  const out = ImportDialog(props);
  hookSink = null;
  for (const fn of effects) { try { fn(); } catch { /* 清理函数之类 */ } }
  return out;
}
const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0)); };
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
const inputOf = (tree) => walk(tree).find((node) => node.type === 'input' && node.props.type !== 'checkbox' && node.props['aria-label'] === '搜索要导入的会话');

let tree = render();
await flush();
tree = render();
await flush();
tree = render();

console.log('\n[1] 扫描结果');
{
  ok('打开了扫描接口', calls.some((call) => call.path === '/import/scan'));
  ok('渲染出 4 行会话', byClass(tree, 'cw-import-row').length === 4, String(byClass(tree, 'cw-import-row').length));
  ok('按助手分成两组', byClass(tree, 'cw-import-group').length === 2);
  const disabled = walk(tree).filter((node) => node.type === 'input' && node.props.type === 'checkbox' && node.props.disabled);
  ok('目录缺失的行禁选', disabled.length === 1, String(disabled.length));
  ok('有搜索框', Boolean(inputOf(tree)));
  ok('页脚写全选 3 个（4 行里有 1 行目录缺失）', texts(tree).some((text) => text === '全选 3 个'), JSON.stringify(texts(tree).slice(-6)));
  ok('没选时导入按钮禁用', buttonByText(tree, '导入') ? buttonByText(tree, '导入').props.disabled === true : false);
}

console.log('\n[2] 搜索过滤');
{
  const input = inputOf(tree);
  input.props.onChange({ target: { value: '费率' } });
  tree = render();
  ok('只剩匹配的一行', byClass(tree, 'cw-import-row').length === 1, String(byClass(tree, 'cw-import-row').length));
  ok('全选按钮跟着变成 1 个', texts(tree).some((text) => text === '全选 1 个'), JSON.stringify(texts(tree).slice(-6)));

  inputOf(tree).props.onChange({ target: { value: '完全不存在' } });
  tree = render();
  ok('无匹配时给空态提示', texts(tree).some((text) => text.includes('没有匹配')), JSON.stringify(texts(tree).slice(-4)));

  /* 清空搜索：之前勾的不会丢 */
  inputOf(tree).props.onChange({ target: { value: '' } });
  tree = render();
  ok('清空搜索后回到 4 行', byClass(tree, 'cw-import-row').length === 4);
}

console.log('\n[3] 勾选、全选与提交');
{
  const boxes = walk(tree).filter((node) => node.type === 'input' && node.props.type === 'checkbox' && !node.props.disabled);
  boxes[0].props.onChange();
  tree = render();
  ok('勾上后出现「已选 1 个」', texts(tree).some((text) => text === '已选 1 个'), JSON.stringify(texts(tree).slice(-6)));
  ok('导入按钮写着数量', Boolean(buttonByText(tree, '导入 1 个')));

  const all = buttonByText(tree, '全选 4 个') || walk(tree).find((node) => node.type === 'button' && String((node.props && node.props.className) || '').includes('cw-import-all'));
  all.props.onClick();
  tree = render();
  ok('全选后变成取消全选', texts(tree).some((text) => text === '取消全选'), JSON.stringify(texts(tree).slice(-6)));
  ok('全选后是 3 个（禁选那行不算）', texts(tree).some((text) => text === '已选 3 个'));

  const submit = buttonByText(tree, '导入 3 个');
  submit.props.onClick();
  await flush();
  const post = calls.find((call) => call.path === '/import' && call.method === 'POST');
  ok('提交了 3 条、且不含目录缺失那条', post && post.body.items.length === 3
    && !post.body.items.some((item) => item.nativeId.startsWith('bbbb')), JSON.stringify(post && post.body.items.map((i) => i.nativeId.slice(0, 4))));
  ok('回调把结果交回给外层', imported && imported.created.length === 1);
}

console.log('\n[4] Esc 关闭');
{
  /* 组件把 keydown 挂在 document 上：先装好假的 document 再渲染，才能抓到监听器 */
  let handler = null;
  global.document = {
    addEventListener: (type, fn) => { if (type === 'keydown') handler = fn; },
    removeEventListener: () => {},
  };
  const before = closed;
  store = [];
  const effects = [];
  hookIndex = 0;
  hookSink = effects;
  ImportDialog(props);
  hookSink = null;
  for (const fn of effects) { try { fn(); } catch { /* ignore */ } }
  ok('注册了 Esc 监听', typeof handler === 'function');
  if (handler) handler({ key: 'Escape', stopPropagation() {} });
  ok('Esc 会调 onClose', closed === before + 1, String(closed - before));
  delete global.document;
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);