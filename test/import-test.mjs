/**
 * 「从 CLI 导入会话」——解析、扫描、导入、以及**删除时真的删掉 CLI 记录**。
 *
 * 分三层：
 *  1. 两个 jsonl 头部的解析（纯函数，喂固定文本）；
 *  2. 两个目录的扫描（临时目录里造 .jsonl，验证过滤与归档标记）；
 *  3. 真跑一遍 HTTP 路由：scan → import → 删除，删除后检查磁盘上的记录是不是真没了。
 *
 * 第 3 层把 CLAUDE_CONFIG_DIR / USERPROFILE 指到临时目录，不碰用户真实历史。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { parseClaudeHead, parseCodexHead, codexIdFromName, scanClaudeSessions, scanCodexSessions } from '../lib/history.js';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

const uuid = (seed) => seed.padEnd(8, '0').slice(0, 8) + '-1111-2222-3333-' + seed.padEnd(12, '0').slice(0, 12);
const line = (value) => JSON.stringify(value);

/* —— 1. 头部解析 —— */
console.log('\n[1] Claude jsonl 头部：cwd 与首条真人消息');
{
  const text = [
    line({ type: 'queue-operation', operation: 'enqueue', sessionId: 'x' }),
    line({ type: 'user', isSidechain: true, cwd: 'C:\\子代理目录', message: { role: 'user', content: '子代理说的话' } }),
    line({ type: 'user', cwd: 'C:\\真正的项目', message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
    line({ type: 'user', cwd: 'C:\\真正的项目', message: { role: 'user', content: [{ type: 'text', text: '把签名校验重构一下' }] } }),
  ].join('\n');
  const parsed = parseClaudeHead(text);
  ok('cwd 来自主会话而不是子代理', parsed.cwd === 'C:\\真正的项目', parsed.cwd);
  ok('标题取第一条有内容的用户消息', parsed.title === '把签名校验重构一下', parsed.title);

  /* 只有斜杠命令的会话：没有「人话」可当标题，用命令名兜底 */
  const commandOnly = parseClaudeHead([
    line({ type: 'user', cwd: 'D:\\a', message: { role: 'user', content: '<local-command-caveat>忽略我</local-command-caveat>' } }),
    line({ type: 'user', cwd: 'D:\\a', message: { role: 'user', content: '<command-name>/usage</command-name><command-message>usage</command-message>' } }),
  ].join('\n'));
  ok('只有斜杠命令时用命令名当标题', commandOnly.title === '/usage', commandOnly.title);

  const empty = parseClaudeHead(line({ type: 'queue-operation' }));
  ok('没有用户消息时标题为空', empty.title === '' && empty.cwd === '');

  const plain = parseClaudeHead(line({ type: 'user', cwd: 'D:\\a', message: { role: 'user', content: '纯字符串内容' } }));
  ok('content 是字符串时也能取', plain.title === '纯字符串内容', plain.title);

  const long = parseClaudeHead(line({ type: 'user', cwd: 'D:\\a', message: { role: 'user', content: 'x'.repeat(200) } }));
  ok('超长标题截断到 80 字以内', long.title.length <= 80 && long.title.endsWith('…'), String(long.title.length));

  const broken = parseClaudeHead('{不是 json}\n' + line({ type: 'user', cwd: 'D:\\b', message: { role: 'user', content: '坏行之后' } }));
  ok('坏行跳过，不影响后面的解析', broken.title === '坏行之后' && broken.cwd === 'D:\\b');
}

console.log('\n[2] Codex rollout 头部：session_meta 与用户真说的话');
{
  const id = uuid('abcdef12');
  const text = [
    line({ type: 'session_meta', payload: { id, cwd: 'D:\\codex 项目', timestamp: '2026-01-01T00:00:00Z' } }),
    line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\n忽略我' }] } }),
    line({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'input_text', text: '跑一下导出脚本' }] } } }),
  ].join('\n');
  const parsed = parseCodexHead(text);
  ok('拿到线程 id', parsed.nativeId === id, parsed.nativeId);
  ok('拿到 cwd', parsed.cwd === 'D:\\codex 项目', parsed.cwd);
  ok('标题取 UserMessage，不取 AGENTS.md 注入', parsed.title === '跑一下导出脚本', parsed.title);

  ok('文件名里能取 uuid', codexIdFromName('rollout-2026-11-23T21-04-28-' + id + '.jsonl') === id);
  ok('不是 rollout 的文件名返回空', codexIdFromName('sessions.jsonl') === '');
}

/* —— 2. 目录扫描 —— */
console.log('\n[3] 目录扫描：过滤、归档标记、缺 cwd');
{
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-import-scan-'));
  const claudeRoot = path.join(temp, 'claude-projects');
  const projectDir = path.join(claudeRoot, 'D--proj');
  fs.mkdirSync(projectDir, { recursive: true });
  const idA = uuid('aaaa0001');
  fs.writeFileSync(path.join(projectDir, idA + '.jsonl'), [
    line({ type: 'user', cwd: 'D:\\proj', message: { role: 'user', content: '第一个会话' } }),
  ].join('\n'));
  /* 子代理转录：文件名不是 uuid，必须被跳过 */
  fs.writeFileSync(path.join(projectDir, 'agent-' + uuid('bbbb0002') + '.jsonl'), line({ type: 'user', message: { role: 'user', content: '子代理' } }));
  /* 空文件 / 坏文件不该让扫描崩掉 */
  fs.writeFileSync(path.join(projectDir, uuid('cccc0003') + '.jsonl'), '');
  fs.writeFileSync(path.join(claudeRoot, 'not-a-dir.jsonl'), '{}');

  const claude = scanClaudeSessions(claudeRoot);
  ok('只认出 uuid 命名的 jsonl', claude.length === 2, JSON.stringify(claude.map((entry) => entry.nativeId.slice(0, 8))));
  ok('标题与 cwd 来自文件头', claude.some((entry) => entry.title === '第一个会话' && entry.cwd === 'D:\\proj'));

  const codexRoot = path.join(temp, 'codex', 'sessions');
  const archivedRoot = path.join(temp, 'codex', 'archived_sessions');
  const dayDir = path.join(codexRoot, '2026', '11', '23');
  fs.mkdirSync(dayDir, { recursive: true });
  fs.mkdirSync(archivedRoot, { recursive: true });
  const idB = uuid('dddd0004');
  const idC = uuid('eeee0005');
  const rollout = (id, cwd, title) => [
    line({ type: 'session_meta', payload: { id, cwd } }),
    line({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'input_text', text: title }] } } }),
  ].join('\n');
  fs.writeFileSync(path.join(dayDir, 'rollout-2026-11-23T10-00-00-' + idB + '.jsonl'), rollout(idB, 'D:\\b', '普通会话'));
  fs.writeFileSync(path.join(archivedRoot, 'rollout-2026-11-20T10-00-00-' + idC + '.jsonl'), rollout(idC, 'D:\\c', '归档会话'));
  fs.writeFileSync(path.join(dayDir, 'notes.txt'), 'ignore me');

  const codex = scanCodexSessions(codexRoot, archivedRoot);
  ok('扫到普通 + 归档两个会话', codex.length === 2, JSON.stringify(codex.map((entry) => entry.title)));
  ok('归档的单独标记', codex.filter((entry) => entry.archived).map((entry) => entry.title).join() === '归档会话');
  ok('id 取自文件内容而不是文件名', codex.some((entry) => entry.nativeId === idB));
  ok('非 rollout 文件被忽略', !codex.some((entry) => entry.title === 'ignore me'));

  fs.rmSync(temp, { recursive: true, force: true });
}

/* —— 3. 真走路由：扫描 → 导入 → 删除 —— */
console.log('\n[4] 路由：扫描 → 导入 → 删除（删除要真的删掉 CLI 记录）');
{
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-import-route-'));
  const home = path.join(temp, 'home');
  const claudeConfig = path.join(home, '.claude');
  const projects = path.join(claudeConfig, 'projects', 'D--proj');
  fs.mkdirSync(projects, { recursive: true });
  const projectCwd = path.join(temp, 'work');
  fs.mkdirSync(projectCwd, { recursive: true });
  const nativeId = uuid('ffff0006');
  const transcript = path.join(projects, nativeId + '.jsonl');
  fs.writeFileSync(transcript, line({ type: 'user', cwd: projectCwd, message: { role: 'user', content: '导入我' } }));

  /* 扫描/导入都要看这两个环境变量：改完再 import 主模块 */
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  process.env.USERPROFILE = home;
  process.env.HOME = home;

  const { Workbench } = await import('../index.js');

  const wb = Object.create(Workbench.prototype);
  Object.assign(wb, {
    ctx: { webServer: { getOrigin: () => 'http://127.0.0.1:1234' } },
    dir: path.join(temp, 'data'),
    attachmentsDir: path.join(temp, 'data', 'attachments'),
    sessionsDir: path.join(temp, 'data', 'sessions'),
    mcpDir: path.join(temp, 'data', 'mcp'),
    sessions: new Map(),
    workspaces: new Map(),
    streams: new Map(),
    procs: new Map(),
    approvals: new Map(),
    upgrading: new Set(),
    deltaTimers: new Map(),
    deltaBuffers: new Map(),
    settings: { claudeMode: 'manual', codexMode: 'workspace-write' },
    instanceId: 'wb_import_test',
    startedAt: Date.now(),
    serialized: new Map(),
    unmountTimer: null,
    disposed: false,
    saveTimer: null,
    dirty: false,
    scheduleIdleUnmount() {},
    scheduleSave() {},
    save() {},
    logOperation() {},
    send: async () => {},
  });

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
      statusCode: 0, chunks: [], writeHead(status, headers) { this.statusCode = status; this.headers = headers || {}; },
      end(payload) { if (payload != null) this.chunks.push(Buffer.from(String(payload), 'utf8')); },
    };
    await wb.handle(new FakeReq(method, url, body), res);
    const text = Buffer.concat(res.chunks).toString('utf8');
    return { status: res.statusCode, json: text ? JSON.parse(text) : null };
  };

  const scan = await request('GET', '/import/scan');
  ok('扫描返回 200', scan.status === 200, String(scan.status));
  const found = (scan.json.entries || []).find((entry) => entry.nativeId === nativeId);
  ok('扫到临时目录里造的那个会话', Boolean(found), JSON.stringify((scan.json.entries || []).length));
  ok('标题与 cwd 正确', found && found.title === '导入我' && found.cwd === projectCwd, found && found.title);
  ok('目录存在时不禁选', found && found.missingCwd === false);

  const imported = await request('POST', '/import', JSON.stringify({ items: [{ provider: 'claude', nativeId }] }));
  ok('导入返回 200', imported.status === 200, String(imported.status));
  ok('创建了 1 条会话', imported.json.created && imported.json.created.length === 1);
  const session = imported.json.created[0];
  ok('会话带上了原生 id', session && session.claudeSessionId === nativeId, session && session.claudeSessionId);
  ok('标题沿用扫描结果', session && session.title === '导入我', session && session.title);
  /* 目录在 Windows 上会被展开成长路径（realpath），比较前先归一 */
  const longCwd = fs.realpathSync.native(projectCwd).toLowerCase();
  ok('工作区自动登记', (imported.json.workspaces || []).some((entry) => String(entry.cwd).toLowerCase() === longCwd),
    JSON.stringify((imported.json.workspaces || []).map((entry) => entry.cwd)));
  ok('导入的会话带一条说明', wb.session(session.id).items.some((item) => item.kind === 'notice' && item.text.includes('从 CLI 导入')));

  const again = await request('POST', '/import', JSON.stringify({ items: [{ provider: 'claude', nativeId }] }));
  ok('重复导入被跳过', again.json.created.length === 0 && again.json.skipped.length === 1, JSON.stringify(again.json.skipped));

  const bad = await request('POST', '/import', JSON.stringify({ items: [{ provider: 'claude', nativeId: '../../x' }] }));
  ok('非法 id 被拒', bad.json.created.length === 0 && /无效/.test(bad.json.skipped[0].reason || ''), JSON.stringify(bad.json.skipped));

  const empty = await request('POST', '/import', JSON.stringify({ items: [] }));
  ok('空选择返回 400', empty.status === 400, String(empty.status));

  /* —— 最关键的一条：删除会连 CLI 记录一起删 —— */
  ok('删除前记录还在', fs.existsSync(transcript));
  const removed = await request('DELETE', '/sessions/' + session.id);
  ok('删除返回 200', removed.status === 200, String(removed.status));
  ok('回传了 CLI 删除结果', removed.json.cli && removed.json.cli.deleted === true, JSON.stringify(removed.json.cli));
  ok('CLI 记录真的删掉了', !fs.existsSync(transcript));
  ok('工作台里也没了', wb.session(session.id) === null);

  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.USERPROFILE;
  delete process.env.HOME;
  fs.rmSync(temp, { recursive: true, force: true });
}

/* —— 4. Codex 删除兜底（codex 命令失败时按 uuid 删 rollout 文件） —— */
console.log('\n[5] Codex：命令删不掉时按 uuid 删 rollout 文件');
{
  const probe = spawnSync('cmd.exe', ['/d', '/s', '/c', 'codex --version'], { encoding: 'utf8' });
  const hasCodex = probe.status === 0;
  if (!hasCodex) {
    console.log('  — 本机没有 codex，跳过（不算失败）');
  } else {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-import-codex-'));
    const home = path.join(temp, 'home');
    const dayDir = path.join(home, '.codex', 'sessions', '2026', '11', '23');
    fs.mkdirSync(dayDir, { recursive: true });
    const thread = uuid('9999abcd');
    const rollout = path.join(dayDir, 'rollout-2026-11-23T10-00-00-' + thread + '.jsonl');
    fs.writeFileSync(rollout, line({ type: 'session_meta', payload: { id: thread, cwd: temp } }));

    process.env.USERPROFILE = home;
    process.env.HOME = home;
    const previousHome = process.env.USERPROFILE;
    const { Workbench } = await import('../index.js');
    const wb = Object.create(Workbench.prototype);
    Object.assign(wb, {
      dir: path.join(temp, 'data'),
      mcpDir: path.join(temp, 'data', 'mcp'),
      sessionsDir: path.join(temp, 'data', 'sessions'),
      attachmentsDir: path.join(temp, 'data', 'attachments'),
      sessions: new Map(), workspaces: new Map(), streams: new Map(), procs: new Map(),
      approvals: new Map(), upgrading: new Set(), serialized: new Map(),
      deltaTimers: new Map(), deltaBuffers: new Map(),
      saveTimer: null, dirty: false, unmountTimer: null, disposed: false,
      scheduleSave() {}, scheduleIdleUnmount() {}, logOperation() {}, stop: async () => {},
    });
    const session = {
      id: 'cw_codex_import', provider: 'codex', cwd: temp, title: '终端里的 codex',
      codexThreadId: thread, claudeSessionId: null, items: [], status: 'idle',
    };
    wb.sessions.set(session.id, session);
    const result = await wb.deleteSession(session);
    /* 这个 uuid 在 codex 的索引里并不存在，`codex delete` 必然失败 → 走文件兜底 */
    ok('删除结果仍然成功（走了文件兜底）', result.deleted === true && result.via === 'file', JSON.stringify(result));
    ok('rollout 文件被删掉', !fs.existsSync(rollout));
    process.env.USERPROFILE = previousHome;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);