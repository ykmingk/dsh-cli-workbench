/**
 * 代码审查与运行中排队。
 *
 * 审查：真建一个临时 git 仓库，但**执行器是假的**（`_runIn` 接缝）——
 * 这样能验证「查仓库 → 命令拼对 → 报告入库」的全流程，又不用真跑 CLI
 * （真跑要几十秒，还会花调用费）。
 * 排队：直接用对象方法验证（排队上限、轮结束自动发、归档不自动跑），
 * 外加一条路由断言（附件不许排队）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(rootDir, 'index.js'), 'utf8');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

const { Workbench } = await import('../index.js');

/* 一个最小可用的 Workbench：只填 reviewSession / queueMessage 用到的字段。 */
const makeWorkbench = (overrides = {}) => {
  const wb = Object.create(Workbench.prototype);
  Object.assign(wb, {
    sessions: new Map(),
    streams: new Map(),
    procs: new Map(),
    approvals: new Map(),
    serialized: new Map(),
    deltaTimers: new Map(),
    deltaBuffers: new Map(),
    upgrading: new Set(),
    dir: path.join(os.tmpdir(), 'cw-review-data'),
    settings: { claudeMode: 'manual', codexMode: 'workspace-write' },
    save() {},
    scheduleSave() {},
    sessionEvent() {},
    logOperation() {},
    send: async () => {},
    /* 别在测试里真去探测 codex 沙箱（会拉起 codex doctor） */
    codexSandbox: async () => ({ override: 'unelevated' }),
    ...overrides,
  });
  return wb;
};

const makeSession = (overrides = {}) => ({
  id: 'cw_review_' + Math.random().toString(36).slice(2, 8),
  provider: 'codex',
  cwd: process.cwd(),
  title: '审查',
  status: 'idle',
  items: [],
  pendingQueue: [],
  pending: null,
  ...overrides,
});

/* —— 1. 准备工作目录 —— */
console.log('\n[1] 前置检查');
{
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-review-'));
  const repo = path.join(temp, 'repo');
  fs.mkdirSync(repo);
  const wb = makeWorkbench();
  const plain = path.join(temp, 'plain');
  fs.mkdirSync(plain);

  let notRepo = '';
  try { await wb.reviewSession(makeSession({ cwd: plain }), 'uncommitted'); }
  catch (error) { notRepo = error.message; }
  ok('非 git 目录被挡住', /不是 git 仓库/.test(notRepo), notRepo);

  let missing = '';
  try { await wb.reviewSession(makeSession({ cwd: path.join(temp, 'nope') }), 'uncommitted'); }
  catch (error) { missing = error.message; }
  ok('目录不存在被挡住', /工作目录不存在/.test(missing), missing);

  const running = makeSession({ cwd: repo, status: 'running' });
  let busy = '';
  try { await wb.reviewSession(running, 'uncommitted'); }
  catch (error) { busy = error.message; }
  ok('正在跑的会话不许审查', /正在跑/.test(busy), busy);

  const git = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
  ok('临时仓库建好了', fs.existsSync(path.join(repo, '.git')), git.status === 0 ? '' : String(git.stderr));

  let badBase = '';
  try { await wb.reviewSession(makeSession({ cwd: repo }), 'base', 'main; rm -rf /'); }
  catch (error) { badBase = error.message; }
  ok('分支名里的危险字符被拒', /分支名/.test(badBase), badBase);

  fs.rmSync(temp, { recursive: true, force: true });
}

/* —— 2. Codex：走 codex review —— */
console.log('\n[2] Codex 审查');
{
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-review-codex-'));
  const calls = [];
  const wb = makeWorkbench({
    _runIn: async (cwd, command) => {
      calls.push(command);
      if (command.startsWith('git rev-parse')) return { code: 0, stdout: 'true\n', stderr: '' };
      return { code: 0, stdout: 'LGTM\n\n没有发现问题。', stderr: '' };
    },
  });
  const session = makeSession({ cwd: temp, provider: 'codex' });
  const result = await wb.reviewSession(session, 'uncommitted');
  ok('命令走 codex review --uncommitted', calls.some((command) => /review --uncommitted$/.test(command)), JSON.stringify(calls));
  ok('带上了 Windows 沙箱绕行参数', calls.some((command) => command.includes('windows.sandbox="unelevated"')));
  ok('报告读的是 stdout', result.item.text.startsWith('LGTM'), result.item.text.slice(0, 20));
  ok('记录标成 review 类型', result.item.kind === 'review' && result.item.ok === true);
  ok('报告进了会话', session.items.length === 1 && session.items[0].kind === 'review');
  ok('记了耗时', Number(result.item.durationMs) >= 0 && typeof result.item.command === 'string');

  /* codex review 的 JSON 结论要能抽出来（界面用来显示「LGTM / N 个问题」） */
  const jsonWb = makeWorkbench({
    _runIn: async (cwd, command) => {
      if (command.startsWith('git rev-parse')) return { code: 0, stdout: 'true\n', stderr: '' };
      return {
        code: 0,
        stdout: '前言\n{"findings":[{"title":"a"},{"title":"b"}],"overall_correctness":"patch is incorrect","overall_confidence_score":0.8}\n结尾',
        stderr: '',
      };
    },
  });
  const jsonSession = makeSession({ cwd: temp, provider: 'codex' });
  const jsonResult = await jsonWb.reviewSession(jsonSession, 'uncommitted');
  ok('抽出 JSON 结论', jsonResult.item.summary && jsonResult.item.summary.findings === 2
    && jsonResult.item.summary.verdict === 'patch is incorrect', JSON.stringify(jsonResult.item.summary));
  ok('置信度也带出来', jsonResult.item.summary.confidence === 0.8);
  ok('正文里不再出现那段 JSON', !jsonResult.item.text.includes('overall_correctness')
    && jsonResult.item.text.includes('前言'), jsonResult.item.text);

  ok('没有 JSON 时 summary 为 null', result.item.summary === null || result.item.summary === undefined);

  const base = await wb.reviewSession(session, 'base', 'origin/main');
  ok('对比分支用 --base', calls.some((command) => command.endsWith('review --base origin/main')), JSON.stringify(calls.slice(-2)));
  ok('第二次审查接着往后追加', session.items.length === 2);

  fs.rmSync(temp, { recursive: true, force: true });
}

/* —— 3. Claude：自己算 diff 再喂给 claude -p —— */
console.log('\n[3] Claude 审查');
{
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-review-claude-'));
  const calls = [];
  let stdin = '';
  const wb = makeWorkbench({
    _runIn: async (cwd, command, options = {}) => {
      calls.push(command);
      if (command.startsWith('git rev-parse')) return { code: 0, stdout: 'true\n', stderr: '' };
      if (command.startsWith('git diff')) return { code: 0, stdout: 'diff --git a/x.js b/x.js\n+const a = 1;\n', stderr: '' };
      if (command.startsWith('claude')) { stdin = options.input || ''; return { code: 0, stdout: '发现 1 个问题\n\nx.js:1 变量未使用', stderr: '' }; }
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  const session = makeSession({ cwd: temp, provider: 'claude' });
  const result = await wb.reviewSession(session, 'uncommitted');
  ok('先自己跑 git diff', calls.some((command) => command.startsWith('git diff')), JSON.stringify(calls));
  ok('diff 写进了提示词', stdin.includes('+const a = 1;'), String(stdin.length));
  ok('提示词要求不要调用工具', stdin.includes('不要调用任何工具'));
  ok('报告入库', result.item.kind === 'review' && result.item.text.includes('发现 1 个问题'));

  /* 没有 diff：不能白跑一次模型 */
  const clean = makeWorkbench({
    _runIn: async (cwd, command) => {
      if (command.startsWith('git rev-parse')) return { code: 0, stdout: 'true\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  let empty = '';
  try { await clean.reviewSession(makeSession({ cwd: temp, provider: 'claude' }), 'uncommitted'); }
  catch (error) { empty = error.message; }
  ok('没有改动时直接报错、不调模型', /没有未提交改动/.test(empty), empty);

  /* 只暂存不 worktree：说清楚 */
  const stagedOnly = makeWorkbench({
    _runIn: async (cwd, command) => {
      if (command.startsWith('git rev-parse')) return { code: 0, stdout: 'true\n', stderr: '' };
      if (command.includes('--cached')) return { code: 0, stdout: 'diff --cached', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  let staged = '';
  try { await stagedOnly.reviewSession(makeSession({ cwd: temp, provider: 'claude' }), 'uncommitted'); }
  catch (error) { staged = error.message; }
  ok('只有暂存区改动时给出明确说明', /暂存/.test(staged), staged);

  /* 超大 diff：不硬塞 */
  const huge = makeWorkbench({
    _runIn: async (cwd, command) => {
      if (command.startsWith('git rev-parse')) return { code: 0, stdout: 'true\n', stderr: '' };
      return { code: 0, stdout: 'x'.repeat(300 * 1024), stderr: '' };
    },
  });
  let tooBig = '';
  try { await huge.reviewSession(makeSession({ cwd: temp, provider: 'claude' }), 'uncommitted'); }
  catch (error) { tooBig = error.message; }
  ok('改动过大时拒绝（200KB 上限）', /改动太大/.test(tooBig), tooBig);

  /* 命令失败：报告仍然入库，但标成失败 */
  const failing = makeWorkbench({
    _runIn: async (cwd, command) => {
      if (command.startsWith('git rev-parse')) return { code: 0, stdout: 'true\n', stderr: '' };
      return { code: 2, stdout: '报错输出', stderr: 'boom' };
    },
  });
  const failed = await failing.reviewSession(makeSession({ cwd: temp, provider: 'codex' }), 'uncommitted');
  ok('命令失败也留下报告', failed.ok === false && failed.item.ok === false && failed.item.text.includes('报错输出'));

  fs.rmSync(temp, { recursive: true, force: true });
}

/* —— 4. 排队 —— */
console.log('\n[4] 运行中排队');
{
  const sent = [];
  const wb = makeWorkbench({ send: async (session, content) => { sent.push(content); } });
  const session = makeSession({ status: 'running', _turnActive: true });

  ok('排队一条返回 1', wb.queueMessage(session, '第一个') === 1);
  ok('再排一条返回 2', wb.queueMessage(session, '第二个占位') === 2);
  wb.queueMessage(session, '第二个');

  ok('空内容不收', (() => { try { wb.queueMessage(session, '   '); return false; } catch { return true; } })());
  let cap = '';
  try {
    for (let i = 0; i < 25; i += 1) wb.queueMessage(session, 'x' + i);
  } catch (error) { cap = error.message; }
  ok('超过 20 条被拒', /20 条/.test(cap), cap);
  session.queued = session.queued.slice(0, 2);

  /* 还在跑：不自动发 */
  session._turnActive = true;
  session.status = 'running';
  wb.onTurnEnd(session);
  await new Promise((r) => setTimeout(r, 10));
  ok('还在跑时不会自动发', sent.length === 0, JSON.stringify(sent));

  /* 轮结束：发队首 */
  session._turnActive = false;
  session.status = 'idle';
  wb.onTurnEnd(session);
  await new Promise((r) => setTimeout(r, 20));
  ok('轮结束后自动发队首', sent.length === 1 && sent[0] === '第一个', JSON.stringify(sent));
  ok('队列少了一条', session.queued.length === 1 && session.queued[0].text === '第二个占位');

  /* 归档会话不自动跑 */
  const sent2 = [];
  const wb2 = makeWorkbench({ send: async (session, content) => { sent2.push(content); } });
  const archived = makeSession({ status: 'idle', archived: true, queued: [{ id: 'q1', text: '放着', at: Date.now() }] });
  wb2.onTurnEnd(archived);
  await new Promise((r) => setTimeout(r, 10));
  ok('归档会话不会被排队消息顶回来', sent2.length === 0);

  /* 发失败：记到 error 上，不吞掉 */
  const wb3 = makeWorkbench({ send: async () => { throw new Error('进程没起来'); } });
  const broken = makeSession({ status: 'idle', queued: [{ id: 'q1', text: '会失败', at: Date.now() }] });
  wb3.onTurnEnd(broken);
  await new Promise((r) => setTimeout(r, 20));
  ok('排队发送失败会写进 error', /排队消息发送失败/.test(String(broken.error)), String(broken.error));
}

/* —— 5. 路由与适配器接线 —— */
console.log('\n[5] 接线');
{
  ok('有 /queue 路由', src.includes("action === '/queue' && method === 'POST'"));
  ok('有 /review 路由', src.includes("action === '/review' && method === 'POST'"));
  ok('附件不许排队', src.includes('运行中只能排队文字'));
  ok('publicSession 下发给整条排队列表（界面要显示/撤回/修改）', src.includes("queued: this.queueList(session).map"));
  const claudeSrc = fs.readFileSync(path.join(rootDir, 'lib/claude.js'), 'utf8');
  const codexSrc = fs.readFileSync(path.join(rootDir, 'lib/codex.js'), 'utf8');
  ok('两个适配器轮结束都会通知 Host', claudeSrc.includes('wb.onTurnEnd(session)') && codexSrc.includes('wb.onTurnEnd(session)'));
  const clientSrc = fs.readFileSync(path.join(rootDir, 'client.js'), 'utf8');
  ok('菜单里有「审查未提交改动」', clientSrc.includes("onAction('review')") && clientSrc.includes('审查未提交改动'));
  ok('审查报告有独立样式', clientSrc.includes('.cw-review{') && clientSrc.includes("item.kind === 'review'"));
  ok('结论徽标读 summary', clientSrc.includes('item.summary.findings'));
  ok('运行中发送会转成排队', clientSrc.includes("'/queue'") && clientSrc.includes('已排队 '));
  ok('输入框上方是排队列表（显示内容，可撤回/修改/插入）', clientSrc.includes('function QueueCard')
    && clientSrc.includes('本轮结束后逐条自动发送')
    && clientSrc.includes('撤回（不发送这条）')
    && clientSrc.includes('在这条之前插入'));
  ok('排队列表与输入框同宽', clientSrc.includes('.cw-dock > .cw-queue'));

}

/* —— 6. 真走 HTTP 路由 —— */
console.log('\n[6] /queue 路由');
{
  const wb = makeWorkbench({
    ctx: { webServer: { getOrigin: () => 'http://127.0.0.1:1' } },
    attachmentsDir: path.join(os.tmpdir(), 'cw-queue-att'),
    settings: { claudeMode: 'manual', codexMode: 'workspace-write' },
  });
  const sent = [];
  wb.send = async (session, content) => { sent.push(content); };
  const running = makeSession({ status: 'running', _turnActive: true });
  wb.sessions.set(running.id, running);

  class FakeReq extends EventEmitter {
    constructor(method, url, body) {
      super();
      this.method = method;
      this.url = '/cli-workbench/api' + url;
      this.headers = {};
      setImmediate(() => {
        if (body != null) this.emit('data', Buffer.from(body, 'utf8'));
        this.emit('end');
      });
    }
    destroy() {}
  }
  const request = async (method, url, body) => {
    const res = {
      statusCode: 0,
      chunks: [],
      writeHead(status, headers) { this.statusCode = status; this.headers = headers || {}; },
      end(payload) { if (payload != null) this.chunks.push(Buffer.from(String(payload), 'utf8')); },
    };
    await wb.handle(new FakeReq(method, url, body), res);
    const raw = Buffer.concat(res.chunks).toString('utf8');
    return { status: res.statusCode, json: raw ? JSON.parse(raw) : null };
  };

  const queued = await request('POST', '/sessions/' + running.id + '/queue', JSON.stringify({ text: '顺便跑一下测试' }));
  ok('运行中排队返回 200', queued.status === 200, String(queued.status));
  ok('回传队列长度 1', queued.json.queued === 1 && queued.json.sent === false);
  ok('会话里真的挂上了', running.queued.length === 1 && running.queued[0].text === '顺便跑一下测试');

  const withAttachment = await request('POST', '/sessions/' + running.id + '/queue', JSON.stringify({
    text: '带图的',
    attachments: [{ name: 'a.png', mediaType: 'image/png', data: 'eA==' }],
  }));
  ok('附件不许排队（400）', withAttachment.status === 400 && /只能排队文字/.test(withAttachment.json.error), JSON.stringify(withAttachment.json));

  const empty = await request('POST', '/sessions/' + running.id + '/queue', JSON.stringify({ text: '   ' }));
  ok('空内容 400', empty.status === 400, String(empty.status));

  /* /review 路由：客户端拿到的必须是 { ok, item, session, items } */
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-review-route-'));
  spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
  wb._runIn = async (cwd, command) => {
    if (command.startsWith('git rev-parse')) return { code: 0, stdout: 'true\n', stderr: '' };
    return { code: 0, stdout: '{"findings":[],"overall_correctness":"patch is correct"}\n\nLGTM', stderr: '' };
  };
  const target = makeSession({ status: 'idle', cwd: repo, provider: 'codex' });
  wb.sessions.set(target.id, target);
  const reviewed = await request('POST', '/sessions/' + target.id + '/review', JSON.stringify({ scope: 'uncommitted' }));
  ok('审查路由返回 200', reviewed.status === 200, String(reviewed.status) + JSON.stringify(reviewed.json && reviewed.json.error));
  ok('回传报告与刷新后的会话', reviewed.json.item && reviewed.json.item.kind === 'review'
    && reviewed.json.items.length === 1 && reviewed.json.session.id === target.id,
  JSON.stringify(reviewed.json.item && reviewed.json.item.summary));
  ok('结论徽标数据也在', reviewed.json.item.summary && reviewed.json.item.summary.findings === 0);

  const notRepo = makeSession({ status: 'idle', cwd: path.join(os.tmpdir(), 'cw-not-a-repo-' + Date.now()), provider: 'codex' });
  wb.sessions.set(notRepo.id, notRepo);
  const bad = await request('POST', '/sessions/' + notRepo.id + '/review', JSON.stringify({}));
  ok('非 git 目录返回 400 且说明原因', bad.status === 400 && /工作目录不存在|不是 git 仓库/.test(bad.json.error), JSON.stringify(bad.json));
  fs.rmSync(repo, { recursive: true, force: true });

  const idle = makeSession({ status: 'idle' });
  wb.sessions.set(idle.id, idle);
  const immediate = await request('POST', '/sessions/' + idle.id + '/queue', JSON.stringify({ text: '直接发' }));
  ok('空闲时直接发出去', immediate.status === 200 && immediate.json.sent === true && sent.includes('直接发'), JSON.stringify(sent));
  ok('空闲时不留队列', !idle.queued || idle.queued.length === 0);
}

/* —— 7. 排队项：撤回 / 修改 / 插入 —— */
console.log('\n[7] 排队项：撤回 / 修改 / 插入');
{
  const wb = makeWorkbench({
    ctx: { webServer: { getOrigin: () => 'http://127.0.0.1:1' } },
    attachmentsDir: path.join(os.tmpdir(), 'cw-queue-att-2'),
    settings: { claudeMode: 'manual', codexMode: 'workspace-write' },
  });
  const sent = [];
  wb.send = async (session, content) => { sent.push(content); };
  const running = makeSession({ status: 'running', _turnActive: true });
  wb.sessions.set(running.id, running);

  class FakeReq extends EventEmitter {
    constructor(method, url, body) {
      super();
      this.method = method;
      this.url = '/cli-workbench/api' + url;
      this.headers = {};
      setImmediate(() => {
        if (body != null) this.emit('data', Buffer.from(body, 'utf8'));
        this.emit('end');
      });
    }
    destroy() {}
  }
  const request = async (method, url, body) => {
    const res = {
      statusCode: 0,
      chunks: [],
      writeHead(status, headers) { this.statusCode = status; this.headers = headers || {}; },
      end(payload) { if (payload != null) this.chunks.push(Buffer.from(String(payload), 'utf8')); },
    };
    await wb.handle(new FakeReq(method, url, body), res);
    const raw = Buffer.concat(res.chunks).toString('utf8');
    return { status: res.statusCode, json: raw ? JSON.parse(raw) : null };
  };

  /* 先排两条，建立基线 */
  const a = await request('POST', '/sessions/' + running.id + '/queue', JSON.stringify({ text: '第一条' }));
  const b = await request('POST', '/sessions/' + running.id + '/queue', JSON.stringify({ text: '第二条' }));
  ok('排了两条', running.queued.length === 2, String(running.queued.length));
  const qid1 = running.queued[0].id;
  const qid2 = running.queued[1].id;
  ok('下发的 session.queued 是数组', Array.isArray(a.json.session.queued) && a.json.session.queued.length === 1);

  /* 插入：插到「第一条」之前 */
  const ins = await request('POST', '/sessions/' + running.id + '/queue', JSON.stringify({ text: '插到最前', before: qid1 }));
  ok('插入到指定位置', ins.status === 200 && running.queued.length === 3 && running.queued[0].text === '插到最前', JSON.stringify(running.queued.map((q) => q.text)));
  const qidIns = running.queued[0].id;

  /* 修改：改「第二条」的正文 */
  const patch = await request('PATCH', '/sessions/' + running.id + '/queue/' + qid2, JSON.stringify({ text: '第二条（改过）' }));
  ok('修改排队项', patch.status === 200 && running.queued.find((q) => q.id === qid2).text === '第二条（改过）', patch.json.session.queued.map((q) => q.text).join('|'));

  const emptyPatch = await request('PATCH', '/sessions/' + running.id + '/queue/' + qid2, JSON.stringify({ text: '   ' }));
  ok('改成空内容被拒（400）', emptyPatch.status === 400 && /不能为空/.test(emptyPatch.json.error), JSON.stringify(emptyPatch.json));

  /* 撤回：删掉插进来的那条 */
  const del = await request('DELETE', '/sessions/' + running.id + '/queue/' + qidIns);
  ok('撤回排队项', del.status === 200 && running.queued.length === 2 && !running.queued.some((q) => q.id === qidIns), String(running.queued.length));

  const delGone = await request('DELETE', '/sessions/' + running.id + '/queue/' + qidIns);
  ok('撤回不存在的排队项返回 404', delGone.status === 404, String(delGone.status));

  const patchGone = await request('PATCH', '/sessions/' + running.id + '/queue/nope', JSON.stringify({ text: 'x' }));
  ok('修改不存在的排队项返回 404', patchGone.status === 404, String(patchGone.status));

  ok('撤回后顺序保持', running.queued[0].text === '第一条' && running.queued[1].text === '第二条（改过）');
  ok('全程没有误发', sent.length === 0, JSON.stringify(sent));

  /* 队列停住时（DSH 重启打断了一轮）：手动让队首发出去 */
  running._turnActive = false;
  running.status = 'idle';
  const drain = await request('POST', '/sessions/' + running.id + '/queue/drain');
  ok('空闲时 /queue/drain 把队首发出去', drain.status === 200 && drain.json.sent === true,
    JSON.stringify({ status: drain.status, sent: drain.json.sent }));
  await new Promise((r) => setTimeout(r, 20));
  ok('发出的正是队首那条', sent[sent.length - 1] === '第一条', JSON.stringify(sent));
  ok('队列剩一条', running.queued.length === 1 && running.queued[0].text === '第二条（改过）');

  running._turnActive = true;
  running.status = 'running';
  const drainBusy = await request('POST', '/sessions/' + running.id + '/queue/drain');
  ok('正在跑时 drain 返回 409', drainBusy.status === 409, String(drainBusy.status));
  running._turnActive = false;
  running.status = 'idle';

  const emptyDrain = makeSession({ status: 'idle' });
  wb.sessions.set(emptyDrain.id, emptyDrain);
  const noQueue = await request('POST', '/sessions/' + emptyDrain.id + '/queue/drain');
  ok('空队列 drain 不发、不报错', noQueue.status === 200 && noQueue.json.sent === false, JSON.stringify(noQueue.json));

  const archivedSession = makeSession({
    status: 'idle', archived: true,
    queued: [{ id: 'q_arch', text: '归档里的', at: Date.now() }],
  });
  wb.sessions.set(archivedSession.id, archivedSession);
  const archivedDrain = await request('POST', '/sessions/' + archivedSession.id + '/queue/drain');
  ok('归档会话不自动发（409）', archivedDrain.status === 409, String(archivedDrain.status));

  /* 撤回不会触发发送；队列仍在、顺序没乱 */
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);