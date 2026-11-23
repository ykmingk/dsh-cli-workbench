/**
 * 客户端接线的**行为**测试：真的把 App 挂起来，模拟「输入文字 → 选文件 → 点发送」，
 * 看它发出去的 HTTP 请求体是什么、失败后输入框里剩下什么。
 *
 * 为什么要有这个文件：attach-test 里客户端那部分只能是 `includes()` 字符串断言，
 * 而 1.0.45 修的「首条消息失败把文字和附件吞掉」正好落在那种断言覆盖不到的分支上。
 * 这里用 client-render 同款 React shim + 假 fetch，把那条路真跑一遍。
 *
 * 不碰真实网络、不碰用户数据；只读 client.js 源码。
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
const stores = new Map();
let effectSink = null;

const React = {
  createElement: element,
  Fragment: Symbol('Fragment'),
  useState(init) {
    const index = hookIndex++;
    const currentStore = store;
    if (!currentStore[index]) currentStore[index] = { value: typeof init === 'function' ? init() : init };
    return [currentStore[index].value, (value) => {
      currentStore[index].value = typeof value === 'function' ? value(currentStore[index].value) : value;
    }];
  },
  useRef(init) {
    const index = hookIndex++;
    const currentStore = store;
    if (!currentStore[index]) currentStore[index] = { current: init };
    return currentStore[index];
  },
  useMemo(fn) {
    const index = hookIndex++;
    const currentStore = store;
    if (!currentStore[index]) currentStore[index] = { value: fn() };
    return currentStore[index].value;
  },
  useCallback(fn) {
    const index = hookIndex++;
    const currentStore = store;
    if (!currentStore[index]) currentStore[index] = { value: fn };
    return currentStore[index].value;
  },
  useEffect(fn, deps) {
    const index = hookIndex++;
    const currentStore = store;
    if (!currentStore[index]) currentStore[index] = {};
    const slot = currentStore[index];
    const key = deps ? JSON.stringify(deps) : String(Math.random());
    if (slot.deps === key) return undefined;
    slot.deps = key;
    if (effectSink) effectSink.push(fn);
    return undefined;
  },
  useLayoutEffect() { return undefined; },
};

class ShimComponent {
  constructor(props) { this.props = props || {}; this.state = {}; }
  setState(updater) {
    const patch = typeof updater === 'function' ? updater(this.state) : updater;
    this.state = { ...this.state, ...(patch || {}) };
  }
}
React.Component = ShimComponent;

global.setInterval = () => 0;
global.clearInterval = () => {};
global.requestAnimationFrame = (fn) => { fn(0); return 0; };
global.cancelAnimationFrame = () => {};

/* --------------------------------------------------------- 假 FileReader */

/* addFiles 用 FileReader.readAsDataURL 读字节；测试文件自带 __b64，
   这里同步把 data URL 交回去（下一 tick，跟真实 FileReader 一样是异步的）。 */
global.FileReader = class {
  readAsDataURL(file) {
    setTimeout(() => {
      this.result = 'data:' + (file.type || 'application/octet-stream') + ';base64,' + file.__b64;
      if (this.onload) this.onload();
    }, 0);
  }
};

/* ------------------------------------------------------------- 假窗口/网络 */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const posts = [];
let messageStatus = 200;
const created = [];

const newSession = () => ({
  id: 'cw_new', provider: 'claude', cwd: 'D:\\projects\\pay-flow', title: '新会话', status: 'idle',
  pinned: false, archived: false, permissionMode: 'manual', sandboxMode: 'workspace-write', model: '',
  files: [], updatedAt: Date.now(), createdAt: Date.now(), itemCount: 0, pending: null, pendingCount: 0,
  usage: null, error: null,
});

const jsonResponse = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
  text: async () => JSON.stringify(data),
});

const bootStatus = {
  providers: {
    claude: { id: 'claude', label: 'Claude Code', installed: true, version: '2.1.330', error: '' },
    codex: { id: 'codex', label: 'Codex', installed: true, version: '0.171.0', error: '' },
  },
  defaultCwd: 'D:\\projects\\pay-flow',
  dataDir: 'C:\\data',
  storage: { saveError: '' },
};

global.fetch = async (url, init = {}) => {
  const method = String(init.method || 'GET').toUpperCase();
  const pathname = String(url).replace('/cli-workbench/api', '');
  if (method === 'POST') {
    const body = init.body ? JSON.parse(init.body) : null;
    posts.push({ path: pathname, body });
    if (pathname === '/sessions') {
      const session = newSession();
      created.push(session);
      return jsonResponse({ session, items: [], workspaces: [] });
    }
    if (/^\/sessions\/[^/]+\/message$/.test(pathname)) {
      if (messageStatus >= 400) return jsonResponse({ error: '首条消息失败（测试）' }, messageStatus);
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ ok: true });
  }
  if (pathname.includes('/stream')) {
    return { ok: true, status: 200, body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) }, json: async () => ({}), text: async () => '' };
  }
  if (pathname.startsWith('/status')) return jsonResponse(bootStatus);
  if (pathname === '/sessions') return jsonResponse({ sessions: created });
  if (pathname.startsWith('/sessions/')) {
    const id = pathname.split('/')[2];
    const session = created.find((item) => item.id === id) || newSession();
    return jsonResponse({ session, items: [] });
  }
  if (pathname.startsWith('/models')) return jsonResponse({ claude: { model: '' }, codex: { model: '' } });
  if (pathname.startsWith('/settings')) return jsonResponse({ claudeMode: 'manual', codexMode: 'workspace-write' });
  if (pathname.startsWith('/updates')) return jsonResponse({ fetchedAt: Date.now(), entries: {} });
  return jsonResponse({});
};

/* ---------------------------------------------------------------- 挂载 */

const captured = [];
const fakeWindow = {
  __ModuleLoader__: { load: (config) => captured.push(config) },
  addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900,
  /* 桌面端的路径桥（DSH preload 提供的那个）：给了路径就只传路径、不复制字节。
     文件对象上挂 __path 就代表「这次是从资源管理器拖进来的」。 */
  __DSH_HOST_PATHS__: { pathFor: (file) => (file && file.__path) || '' },
};

new Function('window', code)(fakeWindow, undefined);
const plugin = captured[0].factory((name) => {
  if (name === 'react') return React;
  throw new Error('unexpected module ' + name);
});

let registrations = [];
plugin.apply({
  get: () => null,
  slots: {
    inject(key, callback) { registrations.push({ key, registration: callback() }); return () => {}; },
    register(options, component) { return { options, component }; },
  },
});

const App = registrations.find((entry) => entry.key === 'main').registration.component;

function expand(node, keyPath) {
  if (node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((child, index) => expand(child, keyPath + '.' + index));
  if (typeof node.type === 'function') {
    if (node.type.prototype instanceof ShimComponent) {
      const instance = new node.type({ ...node.props, children: node.children });
      return expand(instance.render(), keyPath);
    }
    const key = keyPath + ':' + (node.type.name || 'anon');
    if (!stores.has(key)) stores.set(key, []);
    const previous = store;
    const previousIndex = hookIndex;
    store = stores.get(key);
    hookIndex = 0;
    const output = node.type({ ...node.props, children: node.children });
    store = previous;
    hookIndex = previousIndex;
    return expand(output, keyPath);
  }
  if (node.type === React.Fragment) return node.children.map((child, index) => expand(child, keyPath + '.' + index));
  return { ...node, children: (node.children || []).map((child, index) => expand(child, keyPath + '.' + index)) };
}

function collect(node, out = []) {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) collect(child, out); return out; }
  out.push(node);
  for (const child of node.children || []) collect(child, out);
  return out;
}

async function flush() {
  for (let index = 0; index < 12; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

let tree = null;
async function render() {
  const effects = [];
  effectSink = effects;
  const rendered = expand(element(App, {}), 'root');
  effectSink = null;
  for (const fn of effects) {
    try { fn(); } catch { /* 测试里不关心清理函数 */ }
  }
  await flush();
  tree = rendered;
  return rendered;
}

const nodesOf = (target) => collect(target || tree);
const byClass = (target, token) => nodesOf(target).filter((node) => (node.props && String(node.props.className || '').split(/\s+/).includes(token)));
/* 输入框是 contenteditable 的 div（不是 textarea）：按类名找，正文由编辑器 DOM 持有 */
const editorOf = (target) => nodesOf(target).find((node) => node.props && String(node.props.className || '').includes('cw-editor'));
const fileInputOf = (target) => nodesOf(target).find((node) => node.props && node.props.type === 'file');
const sendButtonOf = (target) => nodesOf(target).find((node) => node.props
  && String(node.props.className || '').includes('cw-send')
  && String(node.props.className || '').indexOf('stop') < 0);

function allText(node, out = []) {
  if (node == null) return out;
  if (typeof node === 'string') { out.push(node); return out; }
  if (typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) allText(child, out); return out; }
  for (const child of node.children || []) allText(child, out);
  return out;
}

/* 假编辑器节点：一个文本节点就是「用户输入了这段字」，序列化后就是草稿。 */
const fakeEditor = (value) => ({
  nodeType: 1,
  tagName: 'DIV',
  childNodes: value ? [{ nodeType: 3, textContent: value }] : [],
});

function typeText(value) {
  editorOf().props.onInput({ currentTarget: fakeEditor(value) });
}

function pickImage(name = '截图.png') {
  const input = fileInputOf();
  const file = { name, type: 'image/png', size: PNG.length, __b64: PNG.toString('base64') };
  input.props.onChange({ target: { files: [file], value: '' } });
}

/* ------------------------------------------------------------------ 用例 */

await render();
await render();

console.log('\n[1] 有个能用的输入框与「+」选择器');
{
  ok('输入框渲染出来了', Boolean(editorOf()), editorOf() && String(editorOf().props['data-placeholder'] || ''));
  ok('输入框是 contenteditable（内联引用要靠它）', Boolean(editorOf()) && editorOf().props.contentEditable === true
    && editorOf().props.role === 'textbox');
  ok('隐藏的文件选择器在（点 + 打开它）', Boolean(fileInputOf()) && fileInputOf().props.multiple === true);
  ok('发送键初始是禁用的', Boolean(sendButtonOf()) && sendButtonOf().props.disabled === true);
}

console.log('\n[2] 选一张图 → 草稿里出现缩略图，发送键变为可用');
{
  typeText('看看这张图');
  await render();
  pickImage();
  await flush();
  await render();
  const rail = byClass(null, 'cw-attachrail');
  ok('草稿上方出现附件 rail', rail.length === 1);
  ok('图片是缩略图（previewUrl 是 data URL）', rail.length === 1
    && JSON.stringify(rail[0]).includes('data:image/png;base64,'));
  ok('发送键不再禁用', sendButtonOf() && sendButtonOf().props.disabled === false);
}

console.log('\n[3] 发送成功：POST 体里带上了正文与图片字节');
{
  posts.length = 0;
  messageStatus = 200;
  sendButtonOf().props.onClick();
  await flush();
  await render();
  const create = posts.find((entry) => entry.path === '/sessions');
  const message = posts.find((entry) => /\/message$/.test(entry.path));
  ok('先建会话、再发首条消息', Boolean(create) && Boolean(message), posts.map((entry) => entry.path).join(' → '));
  ok('首条消息带正文', message && message.body.text === '看看这张图', message && JSON.stringify(message.body.text));
  const attachment = message && message.body.attachments && message.body.attachments[0];
  ok('附件带上名字/类型/字节', Boolean(attachment) && attachment.name === '截图.png'
    && attachment.mediaType === 'image/png' && attachment.kind === 'image'
    && attachment.data === PNG.toString('base64'));
  ok('发送后草稿清空（发送键又变灰）', sendButtonOf() && sendButtonOf().props.disabled === true);
  ok('发送后附件 rail 消失', byClass(null, 'cw-attachrail').length === 0);
}

console.log('\n[5] 粘贴截图：剪贴板里的 file item 变成附件（不退化成一段乱码文本）');
{
  stores.clear();
  created.length = 0;
  posts.length = 0;
  messageStatus = 200;
  await render();
  await render();

  const pasted = { name: '粘贴的图.png', type: 'image/png', size: PNG.length, __b64: PNG.toString('base64') };
  let prevented = false;
  editorOf().props.onPaste({
    clipboardData: { items: [{ kind: 'file', getAsFile: () => pasted }] },
    preventDefault: () => { prevented = true; },
  });
  await flush();
  await render();
  ok('粘贴被接管（阻止浏览器把它当文本插进输入框）', prevented === true);
  ok('粘贴的图进了草稿', byClass(null, 'cw-attachrail').length === 1);

  sendButtonOf().props.onClick();
  await flush();
  await render();
  const message = posts.find((entry) => /\/message$/.test(entry.path));
  ok('发出去的附件就是那张图', Boolean(message) && message.body.attachments[0].kind === 'image'
    && message.body.attachments[0].data === PNG.toString('base64'));
}

console.log('\n[6] 从资源管理器拖文件：只传路径，不复制字节');
{
  stores.clear();
  created.length = 0;
  posts.length = 0;
  await render();
  await render();
  typeText('读一下这个文件');
  await render();

  const dropped = { name: '外部需求.md', type: 'text/markdown', size: 1234, __path: 'D:\\外部\\外部需求.md' };
  const box = nodesOf().find((node) => String((node.props && node.props.className) || '').includes('cw-inputbox'));
  let prevented = false;
  box.props.onDragOver({ dataTransfer: { types: ['Files'] }, preventDefault: () => { prevented = true; } });
  await render();
  ok('拖到输入卡上会高亮（阻止浏览器直接打开文件）', prevented === true && byClass(null, 'is-drag').length === 1);
  box.props.onDrop({ dataTransfer: { items: [{ kind: 'file', getAsFile: () => dropped }] }, preventDefault: () => {} });
  await flush();
  await render();
  ok('高亮在放下后消失', byClass(null, 'is-drag').length === 0);
  ok('拖入的文件成了附件卡片', byClass(null, 'cw-attach-file').length === 1);

  sendButtonOf().props.onClick();
  await flush();
  await render();
  const message = posts.find((entry) => /\/message$/.test(entry.path));
  const attachment = message && message.body.attachments[0];
  ok('线上形态只有路径、没有字节', Boolean(attachment) && attachment.path === 'D:\\外部\\外部需求.md'
    && attachment.data === undefined, JSON.stringify(attachment));
}

console.log('\n[4] 首条消息失败：文字与附件回到新会话的输入框（1.0.45 的回归点）');
{
  /* 换一个干净的 App：上面那轮已经把 currentId 指到会话上了 */
  stores.clear();
  created.length = 0;
  posts.length = 0;
  messageStatus = 500;
  await render();
  await render();
  typeText('这段别丢');
  await render();
  pickImage('参考图.png');
  await flush();
  await render();
  ok('失败前：草稿与缩略图都在', byClass(null, 'cw-attachrail').length === 1
    && sendButtonOf().props.disabled === false);

  sendButtonOf().props.onClick();
  await flush();
  await render();

  const message = posts.find((entry) => /\/message$/.test(entry.path));
  ok('首发请求确实发出去了（并被服务端拒掉）', Boolean(message), message && message.path);
  ok('附件也回到输入框（不再只剩一句提示）', byClass(null, 'cw-attachrail').length === 1);
  ok('提示说清楚了文字与附件都还回来了', allText(tree).join(' ').includes('文字与附件已放回输入框'));

  /* 文字是否真的回来了：再点一次发送，看这次 POST 的正文。
     （编辑器正文由 DOM 持有，shim 里没有 DOM，所以用第二次请求来验。） */
  posts.length = 0;
  ok('发送键仍可用（草稿没被清空）', sendButtonOf() && sendButtonOf().props.disabled === false);
  sendButtonOf().props.onClick();
  await flush();
  await render();
  const retry = posts.find((entry) => /\/message$/.test(entry.path));
  ok('文字回到输入框（重发时正文就是它）', retry && retry.body.text === '这段别丢', retry && JSON.stringify(retry.body.text));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);