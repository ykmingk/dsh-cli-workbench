/**
 * 右栏「文件」面板的刷新 / 搜索（1.0.59）。
 *
 * 两层：
 *  1. Host 的 searchFiles()：真建一个临时目录树，验证按名字/相对路径命中、
 *     跳过 node_modules、上限截断、isNew 标记、空关键词直接返回空；
 *  2. FilesPanel 组件：真渲染，点刷新、开搜索、打字、看结果与空态、Esc 收起。
 */
import fs from 'node:fs';
import os from 'node:os';
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

/* ======================= 1. Host：searchFiles ======================= */
const { Workbench } = await import('../index.js');
const wb = Object.create(Workbench.prototype);
Object.assign(wb, { sessions: new Map() });

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-search-'));
const make = (rel, content = 'x') => {
  const full = path.join(temp, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
};
const changed = make('src/utils/math.js');
make('src/main.js');
make('src/utils/strings.ts');
make('README.md');
make('docs/guide.md');
/* 这些目录必须被跳过，哪怕里面名字匹配 */
make('node_modules/pkg/utils.js');
make('.git/objects/utils.js');
make('dist/utils.min.js');

console.log('\n[1] Host：按名字与相对路径搜索');
{
  const session = { cwd: temp, files: [{ path: changed }] };

  const byName = wb.searchFiles(session, 'utils');
  const names = byName.results.map((entry) => entry.relative).sort();
  ok('按名字命中（相对路径里带 utils 的）', names.length === 2 && names.every((rel) => rel.includes('utils')),
    JSON.stringify(names));
  ok('跳过 node_modules / .git / dist', !byName.results.some((entry) => /node_modules|\.git|dist/.test(entry.relative)),
    JSON.stringify(names));
  ok('结果带相对路径与绝对路径', byName.results.every((entry) => entry.path.startsWith(temp) && entry.relative));

  const math = byName.results.find((entry) => entry.name === 'math.js');
  ok('本会话改过的文件标 isNew', math && math.isNew === true, JSON.stringify(math && math.isNew));
  ok('没改过的不标', byName.results.filter((entry) => entry.name !== 'math.js').every((entry) => entry.isNew === false));

  const byPath = wb.searchFiles(session, 'src/ma');
  ok('能用路径片段搜（src/ma）', byPath.results.length === 1 && byPath.results[0].relative === path.join('src', 'main.js'),
    JSON.stringify(byPath.results.map((entry) => entry.relative)));

  const upper = wb.searchFiles(session, 'README');
  ok('大小写不敏感', upper.results.length === 1 && upper.results[0].name === 'README.md');

  const empty = wb.searchFiles(session, '   ');
  ok('空关键词直接返回空（不扫目录）', empty.results.length === 0 && empty.scanned === 0);
  ok('回传 root 与 rootName', empty.root === temp && empty.rootName === path.basename(temp));

  const none = wb.searchFiles(session, 'zzz-not-here');
  ok('没有匹配时结果为空但不算错', none.results.length === 0 && none.truncated === false);
}

console.log('\n[2] Host：上限截断');
{
  const flood = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-search-flood-'));
  for (let i = 0; i < 120; i += 1) {
    fs.writeFileSync(path.join(flood, 'hit-' + String(i).padStart(3, '0') + '.txt'), 'x');
  }
  const session = { cwd: flood, files: [] };
  const result = wb.searchFiles(session, 'hit-');
  ok('最多返回 100 条', result.results.length === 100, String(result.results.length));
  ok('截断时标记 truncated', result.truncated === true);
  ok('报了扫过的条目数', Number(result.scanned) > 0, String(result.scanned));
  fs.rmSync(flood, { recursive: true, force: true });
}

/* ======================= 2. Client：FilesPanel ======================= */
const element = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() });
let store = [];
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
    if (!store[index]) store[index] = { effects: [] };
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

const requests = [];
const SEARCH_REPLY = {
  root: 'D:\\proj',
  rootName: 'proj',
  results: [
    { name: 'math.js', path: 'D:\\proj\\src\\utils\\math.js', relative: 'src\\utils\\math.js', isNew: true },
    { name: 'strings.ts', path: 'D:\\proj\\src\\utils\\strings.ts', relative: 'src\\utils\\strings.ts', isNew: false },
  ],
  truncated: false,
  scanned: 42,
};
global.fetch = async (url) => {
  const raw = String(url);
  requests.push(raw);
  const data = raw.includes('/fs/search') ? SEARCH_REPLY : {};
  return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
};

const captured = [];
new Function('window', code)({ __ModuleLoader__: { load: (config) => captured.push(config) }, addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900 });
const plugin = captured[0].factory((name) => {
  if (name === 'react') return React;
  throw new Error('unexpected module ' + name);
});
const { FilesPanel } = plugin.__parts || {};
ok('导出了 __parts.FilesPanel', Boolean(FilesPanel));
ok('导出了 __parts.Inspector（运行状态是页签）', Boolean(plugin.__parts.Inspector));

const TREE = {
  root: 'D:\\proj',
  rootName: 'proj',
  newCount: 1,
  entries: [
    { name: 'src', path: 'D:\\proj\\src', relative: 'src', depth: 0, type: 'dir' },
    { name: 'main.js', path: 'D:\\proj\\src\\main.js', relative: 'src\\main.js', depth: 1, type: 'file', isNew: true },
    { name: 'README.md', path: 'D:\\proj\\README.md', relative: 'README.md', depth: 0, type: 'file', isNew: false },
  ],
};

let refreshed = 0;
const props = { tree: TREE, loading: false, onOpen() {}, highlight: '', sessionId: 'cw_t', onRefresh: () => { refreshed += 1; } };

function render() {
  hookIndex = 0;
  const effects = [];
  hookSink = effects;
  const out = FilesPanel(props);
  hookSink = null;
  for (const fn of effects) { try { fn(); } catch { /* ignore */ } }
  return out;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = async () => { for (let i = 0; i < 12; i += 1) await sleep(30); };
const walk = (node, out = []) => {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) walk(child, out); return out; }
  out.push(node);
  for (const child of node.children || []) walk(child, out);
  return out;
};
const texts = (tree) => walk(tree).flatMap((node) => (node.children || []).filter((c) => typeof c === 'string'));
const byClass = (tree, token) => walk(tree).filter((node) => String((node.props && node.props.className) || '').split(/\s+/).includes(token));
const tool = (tree, label) => walk(tree).find((node) => node.type === 'button' && node.props['aria-label'] === label);

store = [];
let tree = render();

console.log('\n[3] 文件头：刷新与搜索按钮');
{
  ok('有刷新按钮', Boolean(tool(tree, '刷新文件列表')));
  ok('有搜索按钮', Boolean(tool(tree, '搜索文件')));
  ok('文件树照常渲染', byClass(tree, 'cw-tree-row').length === 3, String(byClass(tree, 'cw-tree-row').length));
  ok('默认不显示搜索条', !byClass(tree, 'cw-filesearch').length);
  ok('新文件标记还在', texts(tree).includes('新'));

  tool(tree, '刷新文件列表').props.onClick();
  ok('点刷新会回调 onRefresh', refreshed === 1, String(refreshed));
}

console.log('\n[4] 打开搜索、打字、看结果');
{
  tool(tree, '搜索文件').props.onClick();
  tree = render();
  ok('搜索条出现', byClass(tree, 'cw-filesearch').length === 1);
  const input = walk(tree).find((node) => node.type === 'input' && node.props['aria-label'] === '搜索文件名');
  ok('搜索输入框带占位提示', Boolean(input) && /搜索文件名/.test(input.props.placeholder), input && input.props.placeholder);

  input.props.onChange({ target: { value: 'utils' } });
  tree = render();
  await flush();
  tree = render();
  ok('打了字会请求 /fs/search', requests.some((url) => url.includes('/fs/search') && url.includes('q=utils')),
    JSON.stringify(requests.filter((url) => url.includes('search'))));
  ok('渲染出两条结果', byClass(tree, 'cw-tree-row').length === 2, String(byClass(tree, 'cw-tree-row').length));
  ok('结果显示文件名', texts(tree).includes('math.js') && texts(tree).includes('strings.ts'));
  ok('结果上方有「2 个结果」', texts(tree).some((text) => text === '2 个结果'), JSON.stringify(texts(tree).slice(0, 5)));
  /* 关键回归：根目录文件的相对路径就等于文件名，以前两段都画，看着像显示了 2 遍，
     右栏一窄还互相压。现在路径只进 title。 */
  ok('不再把相对路径重复画一遍', !texts(tree).some((text) => text === 'src\\utils\\math.js'), JSON.stringify(texts(tree)));
  ok('完整路径留在 title 里', byClass(tree, 'cw-tree-row').every((node) => String(node.props.title || '').includes('\\')),
    JSON.stringify(byClass(tree, 'cw-tree-row').map((node) => node.props.title)));
  ok('带文件类型徽标', byClass(tree, 'cw-fileext').map((node) => (node.children || [])[0]).join() === 'JS,TS',
    JSON.stringify(byClass(tree, 'cw-fileext').map((node) => (node.children || [])[0])));
  ok('名字唯一时不补目录', byClass(tree, 'cw-filesearch-dir').length === 0);
  ok('搜索时不再显示整棵树', !texts(tree).includes('README.md'));
}

console.log('\n[4b] 同名文件才补目录');
{
  /* 两个同名 index.ts 在不同目录：不补目录就分不清点哪个 */
  global.fetch = async (url) => {
    requests.push(String(url));
    const data = {
      root: 'D:\\proj', rootName: 'proj',
      results: [
        { name: 'index.ts', path: 'D:\\proj\\src\\index.ts', relative: 'src\\index.ts', isNew: false },
        { name: 'index.ts', path: 'D:\\proj\\test\\index.ts', relative: 'test\\index.ts', isNew: false },
      ],
      truncated: false, scanned: 9,
    };
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
  };
  const input = walk(tree).find((node) => node.type === 'input' && node.props['aria-label'] === '搜索文件名');
  input.props.onChange({ target: { value: 'index' } });
  tree = render();
  await flush();
  tree = render();
  const dirs = byClass(tree, 'cw-filesearch-dir').map((node) => (node.children || [])[0]);
  ok('同名时两行都补目录', dirs.length === 2 && dirs.includes('src') && dirs.includes('test'), JSON.stringify(dirs));
  ok('文件名仍然只出现一次一行一个', byClass(tree, 'cw-tree-row').length === 2);
}

console.log('\n[5] 无结果 / 清空 / Esc');
{
  const input = walk(tree).find((node) => node.type === 'input' && node.props['aria-label'] === '搜索文件名');
  global.fetch = async (url) => {
    requests.push(String(url));
    const data = { root: 'D:\\proj', rootName: 'proj', results: [], truncated: false, scanned: 7 };
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
  };
  input.props.onChange({ target: { value: 'nothing-matches' } });
  tree = render();
  await flush();
  tree = render();
  ok('无结果时给提示', texts(tree).some((text) => text.includes('没有匹配')), JSON.stringify(texts(tree).slice(0, 4)));

  /* 清空关键词：回到整棵树 */
  const control = walk(tree).find((node) => node.type === 'button' && node.props['aria-label'] === '清空搜索');
  ok('有清空按钮', Boolean(control));
  control.props.onClick();
  tree = render();
  ok('清空后回到文件树', byClass(tree, 'cw-tree-row').length === 3, String(byClass(tree, 'cw-tree-row').length));

  /* Esc 收起搜索 */
  const input2 = walk(tree).find((node) => node.type === 'input' && node.props['aria-label'] === '搜索文件名');
  input2.props.onKeyDown({ key: 'Escape', stopPropagation() {} });
  tree = render();
  ok('Esc 收起搜索条', byClass(tree, 'cw-filesearch').length === 0);
  ok('Esc 后仍是文件树', byClass(tree, 'cw-tree-row').length === 3);
}

fs.rmSync(temp, { recursive: true, force: true });

console.log('\n[6] 页签与路由接线');
{
  const hostSrc = fs.readFileSync(path.join(rootDir, 'index.js'), 'utf8');
  ok('运行状态是页签，和「文件」并列', code.includes("chip('run', '运行状态', 'gauge', false)"));
  ok('右边那个小图标按钮已删（不再有 title: 运行状态 的按钮）', !code.includes("title: '运行状态'"));
  ok('键盘左右键也把「运行状态」算进页签顺序', code.includes("const list = ['files', 'run', ...docs.map"));
  ok('Host 有 /fs/search 路由', hostSrc.includes("route === '/fs/search'") && hostSrc.includes('this.searchFiles('));
  ok('搜索有上限常量', hostSrc.includes('SEARCH_MAX_VISITS') && hostSrc.includes('SEARCH_MAX_RESULTS'));
  ok('搜索跳过大目录', hostSrc.includes('SKIP_DIRS.has(child.name)'));
  ok('Host 注释写明斜杠归一', hostSrc.includes('斜杠方向无关') || hostSrc.includes('统一成正斜杠'));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);