/**
 * 无状态小工具：时间、id、文本归一化、路径、子进程。
 * 从 index.js 原样搬出，逻辑未改。
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';

const now = () => Date.now();

const idOf = (prefix) => prefix + '_' + now().toString(36) + randomBytes(3).toString('hex');

const text = (value) => (typeof value === 'string' ? value : value == null ? '' : String(value));

const clipText = (value, n) => {
  const flat = text(value).replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat;
}

function oneLine(value, max = 120) {
  const flat = text(value).replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

function realCwd(dir) {
  try { return realpathSync.native(dir); } catch { return dir; }
}

function run(command) {
  return new Promise((resolve) => {
    const windows = process.platform === 'win32';
    const child = windows
      ? spawn('cmd.exe', ['/d', '/s', '/c', command], { windowsHide: true, env: process.env })
      : spawn('sh', ['-c', command], { env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: stderr + String(error) }));
    child.on('close', (code) => resolve({ code: code == null ? -1 : code, stdout, stderr }));
  });
}

function killTree(child) {
  if (!child || child.exitCode != null || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    try { child.kill(); } catch { /* already gone */ }
  }
}

/* 与 CLI 约定的取值集合：这些是「能传给 --permission-mode / --sandbox 的值」，
   不是可自由扩展的枚举，所以集中放在这里，index.js 与两个适配器共用同一份。 */
const PERMISSION_MODES = new Set(['manual', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'bypass']);
const SANDBOX_BACKENDS = new Set(['auto', 'unelevated', 'elevated']);
const MAX_ITEMS = 600;

/* HTTP 层的最小公共件：适配器也要回写审批结果，所以放在这里共用。 */
const API = '/cli-workbench/api';

function json(res, status, value) {
  const payload = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export { now, idOf, text, clipText, oneLine, realCwd, run, killTree, PERMISSION_MODES, SANDBOX_MODES, SANDBOX_BACKENDS, MAX_ITEMS, API, json };
