/**
 * HTTP 层的真实行为：附件从 `/message` 进门，到落盘、交给适配器、再由 `/attachment` 回放。
 *
 * 和 attach-test 的区别：那边是「抽函数出来跑」，这边是**真的走一遍路由**
 * （`Workbench.handle` → `route` → `readBody` → `saveAttachments` → `send`），
 * 用的是 `Object.create(Workbench.prototype)` 拼出来的最小实例，数据目录在临时目录里，
 * 不碰用户的会话数据。
 *
 * 顺便钉住两件容易悄悄坏掉的事：
 *   - 空正文 + 只有附件也能发；附件上限/体积/路径校验的报错文案；
 *   - 413 的文案不再写死某个数字（上限按路由不同）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Workbench } from '../index.js';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

/* ------------------------------------------------------------------ 假请求 */

class FakeReq extends EventEmitter {
  constructor(method, url, body, headers = {}) {
    super();
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.destroyed = false;
    /* readBody 先挂监听再把数据推过来：用 setImmediate 保证顺序。 */
    setImmediate(() => {
      if (body != null) this.emit('data', Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'));
      this.emit('end');
    });
  }
  destroy() { this.destroyed = true; }
}

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    chunks: [],
    finished: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers || {}; },
    end(payload) {
      if (payload != null) this.chunks.push(Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8'));
      this.finished = true;
    },
  };
  return res;
}

/* --------------------------------------------------------------- 最小实例 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-route-'));
const calls = [];
const wb = Object.create(Workbench.prototype);
Object.assign(wb, {
  ctx: { webServer: { getOrigin: () => 'http://127.0.0.1:1234' } },
  dir,
  attachmentsDir: path.join(dir, 'attachments'),
  sessionsDir: path.join(dir, 'sessions'),
  mcpDir: path.join(dir, 'mcp'),
  sessions: new Map(),
  workspaces: new Map(),
  streams: new Map(),
  procs: new Map(),
  approvals: new Map(),
  upgrading: new Set(),
  deltaTimers: new Map(),
  deltaBuffers: new Map(),
  settings: {},
  instanceId: 'wb_route_test',
  startedAt: Date.now(),
  serialized: new Map(),
  unmountTimer: null,
  disposed: false,
  saveTimer: null,
  dirty: false,
  // 路由里会碰到的两个「环境」方法：测试里不真起定时器、也不真写盘
  scheduleIdleUnmount() {},
  scheduleSave() {},
  save() {},
  logOperation() {},
  // 适配器入口拦住：这里只验「交给它什么」，不真的拉起 CLI
  send: async (session, content, attachments) => {
    calls.push({ sessionId: session.id, content, attachments });
  },
});

const session = {
  id: 'cw_route',
  provider: 'claude',
  cwd: dir,
  title: '测试会话',
  status: 'idle',
  pinned: false,
  archived: false,
  items: [],
  files: [],
  pendingQueue: [],
  pending: null,
  advisories: [],
  itemBase: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};
wb.sessions.set(session.id, session);

async function request(method, url, body, headers) {
  const res = fakeRes();
  await wb.handle(new FakeReq(method, '/cli-workbench/api' + url, body, headers), res);
  const text = Buffer.concat(res.chunks).toString('utf8');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON（图片） */ }
  return { status: res.statusCode, headers: res.headers, text, json, raw: Buffer.concat(res.chunks) };
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const post = (url, body) => request('POST', url, JSON.stringify(body));

/* ------------------------------------------------------------------ 用例 */

console.log('\n[1] /message：附件从请求体进来，落盘后交给适配器');
{
  calls.length = 0;
  const result = await post('/sessions/cw_route/message', {
    text: '看看这张图',
    attachments: [{ name: '截图 1.png', mediaType: 'image/png', data: PNG.toString('base64') }],
  });
  ok('返回 200', result.status === 200, String(result.status));
  ok('适配器拿到正文', calls.length === 1 && calls[0].content === '看看这张图', JSON.stringify(calls[0] && calls[0].content));
  const saved = calls[0] && calls[0].attachments && calls[0].attachments[0];
  ok('适配器拿到图片描述', Boolean(saved) && saved.kind === 'image' && saved.mediaType === 'image/png');
  ok('文件真的落在会话目录里', Boolean(saved) && saved.path.startsWith(path.join(dir, 'attachments', session.id))
    && fs.existsSync(saved.path) && fs.readFileSync(saved.path).equals(PNG));
  ok('落盘文件名带可读后缀', Boolean(saved) && path.basename(saved.path).endsWith('截图 1.png'));

  /* 客户端渲染聊天记录用的就是这两个参数 */
  const file = path.basename(saved.path);
  const served = await request('GET', '/attachment?session=cw_route&file=' + encodeURIComponent(file));
  ok('GET /attachment 回放同一张图', served.status === 200 && served.raw.equals(PNG), served.headers['content-type']);
  ok('回放带 nosniff 与 no-store', served.headers['x-content-type-options'] === 'nosniff' && served.headers['cache-control'] === 'no-store');
}

console.log('\n[2] 只有附件、没有正文也能发');
{
  calls.length = 0;
  const result = await post('/sessions/cw_route/message', {
    text: '',
    attachments: [{ name: '需求.txt', mediaType: 'text/plain', data: Buffer.from('hello').toString('base64') }],
  });
  ok('返回 200', result.status === 200, JSON.stringify(result.json));
  ok('正文是空串（附件说明由适配器补）', calls.length === 1 && calls[0].content === '');
  ok('普通文件按 file 交给适配器', calls[0].attachments[0].kind === 'file' && calls[0].attachments[0].size === 5);
}

console.log('\n[3] 路径引用（桌面端拖入）：只核存在性，不复制');
{
  const outside = path.join(dir, '外部.txt');
  fs.writeFileSync(outside, 'outside');
  calls.length = 0;
  const result = await post('/sessions/cw_route/message', {
    text: '读一下',
    attachments: [{ name: '外部.txt', kind: 'file', path: outside }],
  });
  ok('返回 200', result.status === 200, JSON.stringify(result.json));
  ok('只带路径、不带字节', calls[0].attachments[0].file === '' && calls[0].attachments[0].path === outside);
  ok('大小取自磁盘', calls[0].attachments[0].size === 7);
}

console.log('\n[4] 拒绝路径：空消息 / 太多 / 太大 / 找不到 / 运行中');
{
  const empty = await post('/sessions/cw_route/message', { text: '   ', attachments: [] });
  ok('空消息 400', empty.status === 400 && empty.json.error === 'empty message', JSON.stringify(empty.json));

  const many = Array.from({ length: 11 }, (_, index) => ({ name: 'a' + index + '.txt', data: 'eA==' }));
  const tooMany = await post('/sessions/cw_route/message', { text: 'x', attachments: many });
  ok('超过 10 个附件 400', tooMany.status === 400 && /最多 10 个/.test(tooMany.json.error), tooMany.json.error);

  const big = Buffer.alloc(9 * 1024 * 1024, 0);
  Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(big, 0);
  const tooBig = await post('/sessions/cw_route/message', {
    text: 'x',
    attachments: [{ name: 'big.png', mediaType: 'image/png', data: big.toString('base64') }],
  });
  ok('超过 8MB 的图片 400', tooBig.status === 400 && /太大/.test(tooBig.json.error), tooBig.json.error);

  const missing = await post('/sessions/cw_route/message', {
    text: 'x',
    attachments: [{ name: 'nope', kind: 'file', path: path.join(dir, '不存在.txt') }],
  });
  ok('不存在的路径 400', missing.status === 400 && /找不到/.test(missing.json.error), missing.json.error);

  const relative = await post('/sessions/cw_route/message', {
    text: 'x',
    attachments: [{ name: 'nope', kind: 'file', path: '相对\\路径' }],
  });
  ok('相对路径 400', relative.status === 400 && /绝对路径/.test(relative.json.error), relative.json.error);

  const running = { ...session, status: 'running' };
  wb.sessions.set('cw_busy', running);
  const busy = await post('/sessions/cw_busy/message', { text: 'x' });
  wb.sessions.delete('cw_busy');
  ok('会话运行中 409', busy.status === 409, JSON.stringify(busy.json));

  const unknown = await post('/sessions/nope/message', { text: 'x' });
  ok('未知会话 404', unknown.status === 404, JSON.stringify(unknown.json));
}

console.log('\n[5] /attachment 的边界：只回放本会话图片');
{
  const traversal = await request('GET', '/attachment?session=cw_route&file=' + encodeURIComponent('../state.json'));
  ok('路径穿越 400', traversal.status === 400 && traversal.json.error === 'bad file', JSON.stringify(traversal.json));

  const textFile = await request('GET', '/attachment?session=cw_route&file=' + encodeURIComponent('x.txt'));
  ok('非图片扩展名 403', textFile.status === 403 && textFile.json.error === 'not an image', JSON.stringify(textFile.json));

  /* 跨站 <img> 能当「文件存不存在」的探针，带 Sec-Fetch-Site: cross-site 就拒掉 */
  const crossSite = await request('GET', '/attachment?session=cw_route&file=' + encodeURIComponent('x.png'), null, { 'sec-fetch-site': 'cross-site' });
  ok('跨站取附件被拒 403', crossSite.status === 403 && crossSite.json.error === 'cross-site request rejected', JSON.stringify(crossSite.json));
  const sameOrigin = await request('GET', '/attachment?session=cw_route&file=' + encodeURIComponent('x.png'), null, { 'sec-fetch-site': 'same-origin' });
  ok('同源请求照常走（这里是没有这个文件 → 404）', sameOrigin.status === 404, String(sameOrigin.status));

  const noSession = await request('GET', '/attachment?session=nope&file=a.png');
  ok('未知会话 404', noSession.status === 404, JSON.stringify(noSession.json));

  const noFile = await request('GET', '/attachment?session=cw_route&file=' + encodeURIComponent('missing.png'));
  ok('文件不存在 404', noFile.status === 404 && noFile.json.error === 'attachment not found', JSON.stringify(noFile.json));
}

console.log('\n[6] 413：请求体超限的文案不再写死 4MB');
{
  const huge = JSON.stringify({ padding: 'x'.repeat(4 * 1024 * 1024 + 32) });
  const result = await request('POST', '/settings', huge);
  ok('返回 413', result.status === 413, String(result.status));
  ok('文案说的是「分批发送」而不是某个固定上限', result.json && result.json.error === '一次发送的内容太多，请分批发送', JSON.stringify(result.json));
}

console.log('\n[7] 删会话时连带清附件目录');
{
  const before = fs.readdirSync(path.join(dir, 'attachments', session.id)).length;
  ok('删之前会话目录里有文件', before > 0, String(before));
  /* 只调删附件那一段的实际行为：deleteSession 会顺带停进程、删转录，这里直接跑真方法 */
  wb.stop = async () => {};
  await wb.deleteSession(session);
  ok('附件目录被删掉', !fs.existsSync(path.join(dir, 'attachments', session.id)));
  ok('会话从索引里消失', wb.session('cw_route') === null);
}

/* 收尾：临时目录整个删掉，别在 %TEMP% 里留东西 */
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);