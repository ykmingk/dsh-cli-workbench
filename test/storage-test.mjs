/**
 * 存储层（v3：一个会话一个文件）的回归用例。
 *
 * 与其它用例一样：抽取 index.js 里 load()/save()/persistCopy() 的**真实源码**执行，
 * 不是复制一份逻辑。跑在临时目录里，不碰真实数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const BASE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcIndex = fs.readFileSync(path.join(BASE, 'index.js'), 'utf8');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

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

const MAX_ITEMS = 600;
const now = () => Date.now();
const text = (value) => (value == null ? '' : String(value));
const realCwd = (dir) => { try { return fs.realpathSync.native(dir); } catch { return dir; } };

const loadBody = extract(srcIndex, '  load() {');
const saveBody = extract(srcIndex, '  save(force) {');
const persistBody = extract(srcIndex, '  persistCopy(session) {');
const listBody = extract(srcIndex, '  workspaceList() {');

/** 造一个只带存储所需字段的假 Workbench。 */
function makeWorkbench(dir) {
  const self = {
    dir,
    stateFile: path.join(dir, 'state.json'),
    sessionsDir: path.join(dir, 'sessions'),
    legacyFile: path.join(dir, 'sessions.json'),
    serialized: new Map(),
    lastState: '',
    dirty: false,
    saveError: null,
    saveTimer: null,
    sessions: new Map(),
    workspaces: new Map(),
    logged: [],
    scheduleSave() { this.dirty = true; },
    logOperation(kind, detail) { this.logged.push({ kind, detail }); },
    workspaceList: null,
    persistCopy: null,
    load: null,
    save: null,
  };
  const scope = {
    existsSync: fs.existsSync, readFileSync: fs.readFileSync, readdirSync: fs.readdirSync,
    renameSync: fs.renameSync, rmSync: fs.rmSync, writeFileSync: fs.writeFileSync,
    mkdirSync: fs.mkdirSync, statSync: fs.statSync,
    path, realCwd, text, now, MAX_ITEMS, PERMISSION_MODES, SANDBOX_MODES,
  };
  const names = Object.keys(scope);
  self.workspaceList = new Function(...names, 'return function workspaceList() {' + listBody + '}').call(self, ...names.map((n) => scope[n])).bind(self);
  self.persistCopy = new Function(...names, 'return function persistCopy(session) {' + persistBody + '}').call(self, ...names.map((n) => scope[n])).bind(self);
  self.load = new Function(...names, 'return function load() {' + loadBody + '}').call(self, ...names.map((n) => scope[n])).bind(self);
  self.save = new Function(...names, 'return function save(force) {' + saveBody + '}').call(self, ...names.map((n) => scope[n])).bind(self);
  return self;
}

const PERMISSION_MODES = new Set(['manual', 'plan', 'acceptEdits', 'bypass']);
const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);

const sessionJson = (id, extra = {}) => JSON.stringify({
  id, provider: 'claude', cwd: os.tmpdir(), title: '会话 ' + id,
  createdAt: 1, updatedAt: 2, status: 'idle', items: [{ id: 'i1', kind: 'user', text: 'hi' }],
  ...extra,
});

console.log('\n[迁移] 旧单文件 → 一个会话一个文件');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-store-'));
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
    version: 2,
    savedAt: now(),
    workspaces: [{ cwd: os.tmpdir(), title: '临时区', addedAt: 1 }],
    sessions: [JSON.parse(sessionJson('cw_a')), JSON.parse(sessionJson('cw_b'))],
  }));

  const wb = makeWorkbench(dir);
  wb.load();

  ok('会话全部读出来', wb.sessions.size === 2, '→ ' + wb.sessions.size);
  ok('工作区读出来', wb.workspaces.size === 1);
  ok('生成了 sessions/ 目录', fs.existsSync(wb.sessionsDir));
  ok('每个会话一个文件', fs.readdirSync(wb.sessionsDir).filter((n) => n.endsWith('.json')).length === 2);
  ok('生成了 state.json', fs.existsSync(wb.stateFile));
  const legacyName = fs.readdirSync(dir).find((n) => n.startsWith('sessions.json.migrated-'));
  ok('旧文件改名保留（不删除）', Boolean(legacyName));
  ok('旧文件内容仍在', legacyName && fs.statSync(path.join(dir, legacyName)).size > 100);
  ok('记了一条 migrate 日志', wb.logged.some((entry) => entry.kind === 'migrate'));

  const state = JSON.parse(fs.readFileSync(wb.stateFile, 'utf8'));
  ok('state.json 版本 3', state.version === 3);
  ok('state.json 带工作区', Array.isArray(state.workspaces) && state.workspaces.length === 1);

  console.log('\n[写入隔离] 只重写改动过的会话');
  const fileOf = (id) => path.join(wb.sessionsDir, id + '.json');
  const stampBefore = new Map();
  for (const name of fs.readdirSync(wb.sessionsDir)) stampBefore.set(name, fs.statSync(path.join(wb.sessionsDir, name)).mtimeMs);

  wb.save();
  const unchanged = [...stampBefore.keys()].every((name) => fs.statSync(path.join(wb.sessionsDir, name)).mtimeMs === stampBefore.get(name));
  ok('内容没变的会话不重写文件', unchanged);

  await new Promise((resolve) => setTimeout(resolve, 10));
  wb.sessions.get('cw_a').title = '改过的标题';
  wb.save();
  const touched = [...stampBefore.keys()].filter((name) => fs.statSync(path.join(wb.sessionsDir, name)).mtimeMs !== stampBefore.get(name));
  ok('只有被改的那个文件变了', touched.length === 1 && touched[0] === 'cw_a.json', '→ ' + touched.join(','));
  ok('改动确实落盘', JSON.parse(fs.readFileSync(fileOf('cw_a'), 'utf8')).title === '改过的标题');

  console.log('\n[删除] 文件跟着消失');
  wb.sessions.delete('cw_b');
  wb.save();
  ok('被删会话的文件已移除', !fs.existsSync(fileOf('cw_b')));
  ok('剩下的还在', fs.existsSync(fileOf('cw_a')));

  console.log('\n[容错] 单个会话文件损坏不连累其它');
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-store2-'));
  const wb2 = makeWorkbench(dir2);
  wb2.sessions.set('cw_x', { id: 'cw_x', provider: 'claude', cwd: os.tmpdir(), title: 'x', items: [] });
  wb2.sessions.set('cw_y', { id: 'cw_y', provider: 'claude', cwd: os.tmpdir(), title: 'y', items: [] });
  wb2.save(true);
  fs.writeFileSync(path.join(wb2.sessionsDir, 'cw_x.json'), '{ 这不是 JSON');
  const wb3 = makeWorkbench(dir2);
  wb3.load();
  ok('坏文件被跳过，好的照常读入', wb3.sessions.size === 1 && wb3.sessions.has('cw_y'), '→ ' + wb3.sessions.size);
  ok('坏文件被改名留存', fs.readdirSync(wb2.sessionsDir).some((n) => n.includes('.broken-')));

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
