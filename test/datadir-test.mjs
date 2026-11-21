/**
 * 1.0.3 数据目录「选主」验证。
 *
 * 直接抽取 index.js 里 dataDirectory() 的真实源码来跑（不是复制一份），
 * 保证测的就是线上那段代码。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const INDEX = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'index.js');
const src = fs.readFileSync(INDEX, 'utf8');

// —— 按大括号配对挖出函数体 ——
const start = src.indexOf('function dataDirectory()');
if (start < 0) { console.error('找不到 dataDirectory()'); process.exit(1); }
let i = src.indexOf('{', start);
let depth = 0;
let end = -1;
for (; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const fnSrc = src.slice(start, end);

// 用真实模块作为参数注入
const readFileSync = fs.readFileSync;
const statSync = fs.statSync;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-dd-'));
const homeDir = path.join(root, 'home');
const profileDir = path.join(root, 'profile');
const homeFallback = path.join(homeDir, '.dsh', 'cli-workbench');
const profileData = path.join(profileDir, 'cli-workbench');

const writeSessions = (dir, savedAt, valid = true) => {
  fs.mkdirSync(dir, { recursive: true });
  const body = valid ? JSON.stringify({ version: 2, savedAt, sessions: [] }) : '{ broken';
  fs.writeFileSync(path.join(dir, 'sessions.json'), body);
};
const reset = () => {
  fs.rmSync(homeFallback, { recursive: true, force: true });
  fs.rmSync(profileData, { recursive: true, force: true });
};

// 伪造 os.homedir()
const fakeOs = { homedir: () => homeDir, tmpdir: os.tmpdir };

const run = (profileEnv) => {
  const envProcess = { env: {} };
  if (profileEnv) envProcess.env.DSH_PROFILE_DIR = profileDir;
  const factory = new Function('readFileSync', 'statSync', 'os', 'path', 'process', 'return ' + fnSrc);
  return factory(readFileSync, statSync, fakeOs, path, envProcess)();
};

console.log('\n[选主] 只有一边有数据');
reset(); writeSessions(homeFallback, 1000);
let r = run(true);
ok('只有回退目录有数据 → 选回退', r.source === 'home-fallback' && r.dir === homeFallback, '→ ' + r.source);

reset(); writeSessions(profileData, 1000);
r = run(true);
ok('只有 profile 有数据 → 选 profile', r.source === 'profile' && r.dir === profileData, '→ ' + r.source);

console.log('\n[选主] 两边都有数据，按新旧');
reset(); writeSessions(homeFallback, 5000); writeSessions(profileData, 1000);
r = run(true);
ok('回退更新 → 选回退（不因「有 profile」而硬选 profile）', r.source === 'home-fallback', '→ ' + r.source);

reset(); writeSessions(homeFallback, 1000); writeSessions(profileData, 5000);
r = run(true);
ok('profile 更新 → 选 profile', r.source === 'profile', '→ ' + r.source);

console.log('\n[选主] 缺失与损坏');
reset();
r = run(true);
ok('两边都空且带 profile 环境 → 用 profile 新建', r.source === 'profile', '→ ' + r.source);

r = run(false);
ok('两边都空且无 profile 环境 → 用回退', r.source === 'home-fallback', '→ ' + r.source);

reset(); writeSessions(profileData, 9000, false); writeSessions(homeFallback, 1000);
r = run(true);
ok('profile 文件损坏 → 让给可用的回退（不覆盖好数据）', r.source === 'home-fallback', '→ ' + r.source);

reset(); writeSessions(profileData, 0); writeSessions(homeFallback, 0);
r = run(true);
const hasSavedAtFallback = r.source === 'profile' || r.source === 'home-fallback';
ok('无 savedAt 的老文件也不会崩', hasSavedAtFallback, '→ ' + r.source);

console.log('\n[回归] 无 profile 环境时永远不该指向 profile 目录');
reset(); writeSessions(profileData, 9999);
r = run(false);
ok('无环境变量时不选 profile 目录', !String(r.dir).includes('profile'), '→ ' + r.source);

fs.rmSync(root, { recursive: true, force: true });
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);