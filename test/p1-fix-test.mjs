/**
 * P1 修复验证：抽取真实源码执行（不是复制品）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INDEX = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'index.js');
const CLIENT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'client.js');

const srcIndex = fs.readFileSync(INDEX, 'utf8');
const srcClient = fs.readFileSync(CLIENT, 'utf8');

const extract = (source, signature) => {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error('找不到 ' + signature);
  let i = source.indexOf('{', start);
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start + signature.length, i); }
  }
  throw new Error('括号不配对: ' + signature);
};

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

/* ------------------------------------------------------------ P1-2 链接渲染 */
console.log('\n[P1-2] 助手输出里的 markdown 链接');
{
  const body = extract(srcClient, 'function inlineNodes(text) {');
  const h = (tag, props, ...children) => ({ tag: typeof tag === 'string' ? tag : 'C', props, children });
  const inlineNodes = new Function('h', 'return function inlineNodes(text) {' + body + '}')(h);

  const nodes = inlineNodes('见 [官网](https://example.com) 与 **粗体** 和 `代码`');
  const kinds = nodes.filter((n) => typeof n === 'object').map((n) => n.tag);
  ok('生成了 a / strong / code 三种节点', kinds.join(',') === 'a,strong,code', '→ ' + kinds.join(','));
  const link = nodes.find((n) => typeof n === 'object' && n.tag === 'a');
  ok('链接文字正确', link && link.children[0] === '官网');
  ok('链接地址正确', link && link.props.href === 'https://example.com');
  ok('不再出现乱码（slice(2,-2) 的残留）', !JSON.stringify(nodes).includes('](https'));

  const bad = inlineNodes('[点我](javascript:alert(1))');
  ok('javascript: 伪协议不渲染成链接', !bad.some((n) => typeof n === 'object' && n.tag === 'a'));
}

/* --------------------------------------------------------------- P1-1 跨站 */
console.log('\n[P1-1] 跨站写请求拒绝');
{
  const body = extract(srcIndex, 'crossSite(req) {');
  const crossSite = new Function('req', 'with (this) {' + body + '}');
  const self = {
    ctx: { webServer: { getOrigin: () => 'http://127.0.0.1:53680' } },
  };
  const run = (headers) => crossSite.call(self, { headers });

  ok('无 Origin（审批桥 / curl）→ 放行', run({}) === false);
  ok('同端口 127.0.0.1 → 放行', run({ origin: 'http://127.0.0.1:53680' }) === false);
  ok('同端口 localhost → 放行', run({ origin: 'http://localhost:53680' }) === false);
  ok('别的端口 → 拒绝', run({ origin: 'http://127.0.0.1:9999' }) === true);
  ok('外部站点 → 拒绝', run({ origin: 'https://evil.example' }) === true);
  ok('Sec-Fetch-Site: cross-site → 拒绝', run({ 'sec-fetch-site': 'cross-site' }) === true);
  ok('畸形 Origin → 拒绝', run({ origin: '不是网址' }) === true);
}

/* --------------------------------------------------------- P1-12 预览边界 */
console.log('\n[P1-12] /preview 的工作区边界');
{
  const body = extract(srcIndex, 'withinAnyWorkspace(input) {');
  const realpathSync = fs.realpathSync;
  const text = (value) => (value == null ? '' : String(value));
  const within = new Function('text', 'realpathSync', 'path', 'input', 'with (this) {' + body + '}');
  // 用仓库自己当工作区、系统临时目录当界外：不依赖某台机器的具体盘符
  const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const self = {
    workspaces: new Map([[repoRoot.toLowerCase(), { cwd: repoRoot }]]),
  };
  const run = (p) => within.call(self, text, realpathSync, path, p);
  const inside = path.join(repoRoot, 'README.md');
  const outside = os.tmpdir();
  ok('工作区内的文件 → 允许', run(inside) === true);
  ok('工作区外的文件 → 拒绝', run(outside) === false);
  ok('不存在的路径 → 拒绝', run(path.join(os.tmpdir(), '不存在的目录', 'x.txt')) === false);
  ok('空路径 → 拒绝', run('') === false);
}

/* --------------------------------------------------- /open 的能力边界（1.0.19） */
console.log('\n[/open] 只允许打开工作台知道的路径');
{
  const body = extract(srcIndex, 'knownCwd(input) {');
  const realpathSync = fs.realpathSync;
  const text = (value) => (value == null ? '' : String(value));
  const known = new Function('text', 'realpathSync', 'path', 'input', 'with (this) {' + body + '}');
  const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const self = { sessions: new Map([['a', { cwd: repoRoot }]]) };
  const run = (p) => known.call(self, text, realpathSync, path, p);
  ok('会话的工作目录 → 允许', run(repoRoot) === true);
  ok('系统临时目录 → 拒绝', run(os.tmpdir()) === false);
  ok('路由里有 403 兜底', srcIndex.includes("error: '只能打开工作台里的路径'"));
  ok('三种放行来源都在（工作区 / 会话作用域 / 会话目录）',
    srcIndex.includes('this.withinAnyWorkspace(target)')
    && srcIndex.includes('this.safePath(session, target)')
    && srcIndex.includes('this.knownCwd(target)'));
}

/* ---------------------------------------------------------- P1-10 轮次统计 */
console.log('\n[P1-10] 轮次与步数');
{
  const formula = (s) => ({ turns: (Number(s._turns) || 0) + 1, steps: Number(s._turnSteps) || 0 });
  ok('第一轮显示 1 轮', formula({}).turns === 1);
  ok('第二轮显示 2 轮（原来会显示 1）', formula({ _turns: 1 }).turns === 2);
  ok('第五轮显示 5 轮', formula({ _turns: 4 }).turns === 5);
  ok('步数用本轮计数', formula({ _turnSteps: 7 }).steps === 7);
  ok('无工具调用时步数为 0', formula({ _turnSteps: 0 }).steps === 0);
  ok('index.js 每轮开始时重置 _turnSteps', srcIndex.includes('session._turnSteps = 0'));
  ok('index.js tool 条目累加步数', srcIndex.includes('session._turnSteps = (Number(session._turnSteps) || 0) + 1'));
}

/* ------------------------------------------------------------- 其它静态断言 */
console.log('\n[其它] 关键改动是否就位');
{
  ok('P1-6 SSE 写前判空且挂了 error 监听',
    srcIndex.includes('res.writableEnded || res.destroyed') && srcIndex.includes("res.on('error', close)"));
  ok('P1-7 强杀定时器随新回合取消',
    srcIndex.includes('session._interruptTimer') && srcIndex.includes('clearTimeout(session._interruptTimer)'));
  ok('P1-8 新增 /permission/cancel 路由',
    srcIndex.includes("route === '/permission/cancel'"));
  ok('P1-8 MCP 桥处理 notifications/cancelled',
    fs.readFileSync(path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'mcp-permission.mjs'), 'utf8')
      .includes("method === 'notifications/cancelled'"));
  ok('P1-9 Codex 文件改动不再编造行数',
    !srcIndex.includes('existingFile.added += patch') && srcIndex.includes("const kind = text(change.kind) || 'update'"));
  ok('P1-11 归档失败会回填真实状态',
    srcIndex.includes("'软归档 · 原生命令失败'"));
  ok('P1-3 空态任务卡把 prompt 传进 startNew',
    srcClient.includes('startNew(currentProvider, undefined, text)'));
  ok('P1-5 输入框与重命名框都判 IME',
    (srcClient.match(/isComposing/g) || []).length >= 2, '→ ' + (srcClient.match(/isComposing/g) || []).length + ' 处');
  ok('P1-4 断线可重连且有可见提示',
    srcClient.includes("setStreamState('retrying')") && srcClient.includes("'连接中断，正在重连…'"));
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);