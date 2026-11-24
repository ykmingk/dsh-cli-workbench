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

/**
 * cmd.exe 的 stderr/stdout 用的是 OEM 代码页（简中系统 = 936/GBK），不是 UTF-8。
 * 直接 toString('utf8') 会得到一串乱码——真实原因（「不是内部或外部命令」）
 * 用户完全看不到。这里按字节特征判断：含合法 UTF-8 多字节序列则原样，
 * 否则尝试把 Latin-1 视角下的字节经 GBK 解码（Node 没内置 GBK，用 TextDecoder）。
 */
let gbkDecoder = null;
function decodeConsole(buffer) {
  const s = buffer.toString('utf8');
  // 含 U+FFFD 说明 utf8 解码失败过 → 不是 UTF-8 文本
  if (!s.includes('\uFFFD')) return s;
  try {
    if (!gbkDecoder) gbkDecoder = new TextDecoder('gbk');
    const decoded = gbkDecoder.decode(buffer);
    if (decoded && !decoded.includes('\uFFFD')) return decoded;
  } catch { /* 运行时不支持 GBK 标签就保持原样 */ }
  return s;
}

/**
 * 跑一条命令并收集输出。
 *
 * 带超时：`codex doctor`、`codex delete`、`npm view` 这些都可能卡住（网络、
 * 锁文件、CLI 自己的交互等待），没有超时就会把 HTTP 请求一直挂住，Host 卸载时
 * 也来不及收尾。默认 5 分钟，个别慢命令自己传。
 */
/** 超时文案：不足 10 秒带一位小数（400ms 不该写成「0 秒」）。 */
function timeoutLabel(ms) {
  const value = Number(ms) || 0;
  return value >= 10000 ? Math.round(value / 1000) + ' 秒' : (value / 1000).toFixed(1) + ' 秒';
}

function run(command, options = {}) {
  const timeout = Number(options.timeout) > 0 ? Number(options.timeout) : 5 * 60 * 1000;
  return new Promise((resolve) => {
    const windows = process.platform === 'win32';
    let child;
    try {
      child = windows
        ? spawn('cmd.exe', ['/d', '/s', '/c', command], { windowsHide: true, env: process.env })
        : spawn('sh', ['-c', command], { env: process.env });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error) });
      return;
    }
    const outChunks = [];
    const errChunks = [];
    let settled = false;
    const finish = (code, extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: decodeConsole(Buffer.concat(outChunks)),
        stderr: decodeConsole(Buffer.concat(errChunks)) + (extra || ''),
      });
    };
    const timer = setTimeout(() => {
      try { killTree(child); } catch { /* 已经退出 */ }
      finish(-1, '\n（超时 ' + timeoutLabel(timeout) + '，已终止）');
    }, timeout);
    child.stdout.on('data', (chunk) => { outChunks.push(chunk); });
    child.stderr.on('data', (chunk) => { errChunks.push(chunk); });
    child.on('error', (error) => finish(-1, String(error)));
    child.on('close', (code) => finish(code == null ? -1 : code));
  });
}

/**
 * 在**指定目录**里跑一条命令（可选喂 stdin、带超时）。
 *
 * 代码审查要用：`codex review` 必须在会话的工作目录里跑。这里用 spawn 的 cwd
 * 而不是在命令里拼 `cd /d "路径"`——路径带空格或中文时，拼字符串经 cmd 解析
 * 很容易出问题，spawn 的 cwd 是直接传给 CreateProcess 的。
 */
function runIn(cwd, command, options = {}) {
  const timeout = Number(options.timeout) > 0 ? Number(options.timeout) : 5 * 60 * 1000;
  return new Promise((resolve) => {
    const windows = process.platform === 'win32';
    let child;
    try {
      child = windows
        ? spawn('cmd.exe', ['/d', '/s', '/c', command], { cwd, windowsHide: true, env: options.env || process.env })
        : spawn('sh', ['-c', command], { cwd, env: options.env || process.env });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error) });
      return;
    }
    const outChunks = [];
    const errChunks = [];
    let settled = false;
    const finish = (code, extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: decodeConsole(Buffer.concat(outChunks)),
        stderr: decodeConsole(Buffer.concat(errChunks)) + (extra || ''),
      });
    };
    const timer = setTimeout(() => {
      try { killTree(child); } catch { /* already gone */ }
      finish(-1, '\n（超时 ' + timeoutLabel(timeout) + '，已终止）');
    }, timeout);
    child.stdout.on('data', (chunk) => { outChunks.push(chunk); });
    child.stderr.on('data', (chunk) => { errChunks.push(chunk); });
    child.on('error', (error) => finish(-1, String(error)));
    child.on('close', (code) => finish(code == null ? -1 : code));
    try {
      if (options.input != null) child.stdin.write(String(options.input));
      child.stdin.end();
    } catch { /* stdin 已关闭：让进程自己跑 */ }
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

export { now, idOf, text, clipText, oneLine, realCwd, run, runIn, killTree, PERMISSION_MODES, SANDBOX_MODES, SANDBOX_BACKENDS, MAX_ITEMS, API, json, decodeConsole };
