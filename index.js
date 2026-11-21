/**
 * Host half of the CLI workbench bundle.
 *
 * Owns the two locally installed command-line agents (`claude`, `codex`), their
 * transcripts, the approval bridge, and the small HTTP surface the Client page
 * talks to. No DSH agent, Session, or model is involved: these are the user's
 * own CLI processes.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = '/cli-workbench/api';
const MCP_SCRIPT = fileURLToPath(new URL('./mcp-permission.mjs', import.meta.url));
const PROVIDERS = {
  claude: { label: 'Claude Code', pkg: '@anthropic-ai/claude-code' },
  codex: { label: 'Codex', pkg: '@openai/codex' },
};
const PERMISSION_MODES = new Set(['manual', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'bypass']);
const SANDBOX_BACKENDS = new Set(['auto', 'unelevated', 'elevated']);
const COMPAT_CACHE_MS = 10 * 60 * 1000;

/**
 * The CLI flags this workbench depends on. Claude Code and Codex are third-party
 * CLIs: a release can rename or drop a flag without notice. The Host probes `--help`
 * at runtime so an upgrade shows up as a warning in the UI instead of an opaque
 * "process exited with code 1" on the first message.
 */
const CLI_CAPABILITIES = {
  claude: {
    package: '@anthropic-ai/claude-code',
    help: 'claude --help',
    required: [
      { flag: '--output-format', use: '读取流式事件' },
      { flag: '--input-format', use: '发送 stream-json 消息' },
      { flag: '--verbose', use: 'stream-json 输出前提' },
      { flag: '--permission-mode', use: '权限档位' },
      { flag: '--permission-prompts', use: '把审批交给工作台' },
      { flag: '--permission-prompt-tool', use: 'MCP 审批回调' },
      { flag: '--include-partial-messages', use: '逐字显示回复' },
      { flag: '--mcp-config', use: '挂载审批服务' },
      { flag: '--resume', use: '续接历史会话' },
    ],
    optional: [],
  },
  codex: {
    package: '@openai/codex',
    help: 'codex exec --help',
    topHelp: 'codex --help',
    required: [
      { flag: '--json', use: '读取 JSONL 事件流' },
      { flag: '--sandbox', use: '沙箱档位' },
      { flag: '--skip-git-repo-check', use: '在非 git 目录运行' },
      { flag: '--color', use: '关闭颜色输出' },
      { flag: '--config', use: '覆盖 approval_policy 等配置' },
      { flag: 'resume', use: '续接线程' },
    ],
    optional: [
      { flag: 'archive', use: '原生归档' },
      { flag: 'unarchive', use: '取消原生归档' },
      { flag: 'delete', use: '删除线程' },
    ],
  },
};
const MAX_ITEMS = 600;
const APPROVAL_TIMEOUT = 5 * 60 * 1000;
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.turbo', 'target', '.venv', 'venv',
  '__pycache__', '.idea', '.vscode', 'coverage', '.cache',
]);

const now = () => Date.now();
const idOf = (prefix) => prefix + '_' + now().toString(36) + randomBytes(3).toString('hex');
const text = (value) => (typeof value === 'string' ? value : value == null ? '' : String(value));
/** 截断到 n 个字符，用于技能描述这种会塞进下拉项的文本。 */
const clipText = (value, n) => {
  const flat = text(value).replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat;
};

/**
 * 二进制扩展名：这些文件永远不做文本预览。之前只靠「内容里有 0x00」判断，
 * 而很小的 exe/zip 头几个字节可能没有 0，就被当文本吐成乱码。
 */
const BINARY_EXT = new Set([
  '.exe', '.dll', '.sys', '.msi', '.so', '.dylib', '.bin', '.dat', '.class', '.jar', '.war',
  '.zip', '.rar', '.7z', '.gz', '.tar', '.bz2', '.xz', '.zst', '.iso', '.dmg',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods',
  '.mp3', '.mp4', '.wav', '.flac', '.mov', '.avi', '.mkv', '.webm', '.ogg', '.ico', '.ttf', '.otf', '.woff', '.woff2',
  '.psd', '.ai', '.sketch', '.db', '.sqlite', '.lock', '.pyc', '.node', '.wasm',
]);

/** 没有 NUL 但明显不是文本的：一堆控制字符 */
function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let control = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte < 0x20) control += 1;
  }
  return sample.length > 0 && control / sample.length > 0.1;
}

/** 代码高亮用的语言标签：只用于界面提示，不做真正的词法高亮 */
function langOf(ext) {
  const table = {
    '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.ts': 'TypeScript', '.tsx': 'TypeScript',
    '.jsx': 'JavaScript', '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.c': 'C', '.h': 'C',
    '.cpp': 'C++', '.cs': 'C#', '.rb': 'Ruby', '.php': 'PHP', '.sh': 'Shell', '.ps1': 'PowerShell',
    '.bat': 'Batch', '.cmd': 'Batch', '.css': 'CSS', '.scss': 'SCSS', '.json': 'JSON', '.yaml': 'YAML',
    '.yml': 'YAML', '.toml': 'TOML', '.ini': 'INI', '.xml': 'XML', '.sql': 'SQL', '.lua': 'Lua',
    '.vue': 'Vue', '.svelte': 'Svelte', '.html': 'HTML', '.htm': 'HTML', '.txt': 'Text',
  };
  return table[ext] || '';
}

/** 把 Codex 工具失败的结构化 error 转成可读原文（message / 其它字段 / 兜底 JSON） */
function codexFailureText(error) {
  if (!error) return '';
  if (typeof error === 'string') return error.trim();
  if (typeof error.message === 'string' && error.message.trim()) return error.message.trim();
  try { return JSON.stringify(error); } catch { return String(error); }
}

/**
 * Codex 的「提醒类」输出：实验性开关、更新提示、路径建议这类，不是本轮失败。
 * 判据只在措辞上——认清它们是提示、不是错误；认不出来的一律当错误显示，不吞。
 */
function isAdvisoryMessage(message) {
  const value = String(message || '').trim();
  if (!value) return false;
  return /^Under-development features enabled/i.test(value)
    || /suppress_unstable_features_warning/i.test(value)
    || /^Tip:\s/i.test(value);
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      if (part && typeof part.content === 'string') return part.content;
      return '';
    }).filter(Boolean).join('\n');
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    return JSON.stringify(content);
  }
  return '';
}

function oneLine(value, max = 120) {
  const flat = text(value).replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

function toolTarget(name, input) {
  if (!input || typeof input !== 'object') return '';
  switch (name) {
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit':
      return text(input.file_path || input.path);
    case 'Bash': case 'shell': case 'exec_command':
      return oneLine(input.command || input.cmd, 200);
    case 'Grep': return oneLine(input.pattern, 80) + (input.path ? ' · ' + oneLine(input.path, 80) : '');
    case 'Glob': return oneLine(input.pattern, 120);
    case 'WebFetch': return oneLine(input.url, 160);
    case 'WebSearch': return oneLine(input.query, 160);
    case 'Task': return oneLine(input.description || input.prompt, 160);
    default: return oneLine(input.file_path || input.path || input.command || input.pattern || '', 160);
  }
}

function toolCategory(name) {
  if (name === 'Bash' || name === 'shell' || name === 'exec_command') return 'terminal';
  if (name === 'Read' || name === 'NotebookEdit') return 'file';
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit') return 'edit';
  if (name === 'Grep' || name === 'Glob') return 'search';
  if (name === 'WebFetch' || name === 'WebSearch') return 'globe';
  if (name === 'Task') return 'layers';
  if (name === 'TodoWrite') return 'task';
  return 'wrench';
}

function toolVerb(name) {
  const map = {
    Read: '读取', Write: '写入', Edit: '改写', MultiEdit: '改写', NotebookEdit: '改写',
    Bash: '命令', Grep: '定位', Glob: '查找', WebFetch: '联网', WebSearch: '搜索',
    Task: '子任务', TodoWrite: '计划',
  };
  return map[name] || name;
}

function diffOf(name, input) {
  const out = [];
  let target = '';
  if (!input || typeof input !== 'object') return null;
  if (name === 'Edit' && typeof input.old_string === 'string') {
    target = text(input.file_path);
    for (const line of input.old_string.split('\n')) out.push({ t: 'del', line });
    for (const line of text(input.new_string).split('\n')) out.push({ t: 'add', line });
  } else if (name === 'Write' && typeof input.content === 'string') {
    target = text(input.file_path);
    for (const line of input.content.split('\n')) out.push({ t: 'add', line });
  } else if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    target = text(input.file_path);
    for (const edit of input.edits) {
      if (!edit || typeof edit !== 'object') continue;
      for (const line of text(edit.old_string).split('\n')) out.push({ t: 'del', line });
      for (const line of text(edit.new_string).split('\n')) out.push({ t: 'add', line });
    }
  } else {
    return null;
  }
  let added = 0;
  let removed = 0;
  for (const row of out) {
    if (row.t === 'add') added += 1;
    else removed += 1;
  }
  const lines = out.length > 220 ? out.slice(0, 220) : out;
  return { path: target, added, removed, lines };
}

function humanImpact(name, input) {
  const target = toolTarget(name, input);
  if (name === 'Bash') return '将在工作目录中执行这条 shell 命令，可能读写文件或启动进程。';
  if (name === 'Edit' || name === 'MultiEdit') return '将改写 ' + (target || '目标文件') + '，旧内容会被新内容替换。';
  if (name === 'Write') return '将写入或覆盖 ' + (target || '目标文件') + '。';
  if (name === 'Read') return '只读取 ' + (target || '目标文件') + '，不修改内容。';
  if (name === 'WebFetch' || name === 'WebSearch') return '将访问网络获取外部内容。';
  if (name === 'Task') return '将启动一个子任务代理。';
  return '将调用工具 ' + name + (target ? ' 操作 ' + target : '') + '。';
}

function parseVersion(output) {
  const match = text(output).match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/);
  return match ? match[0] : '';
}

/**
 * Turn a failed npm invocation into one readable line.
 *
 * npm exits 1 for our old quoted package spec as well as for real network
 * failures, and it prints `npm warn` noise (unknown ~/.npmrc keys) before the
 * actual error. Prefer the JSON error summary, then the first `npm error` line.
 */
function npmError(result) {
  const summary = text(result.stdout).match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (summary) return oneLine(summary[1].replace(/\\(["\\])/g, '$1'), 200);
  const lines = text(result.stderr).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const failure = lines.find((line) => /^npm (error|ERR!)/i.test(line));
  return oneLine(failure || lines[lines.length - 1] || 'npm 调用失败', 200);
}

/**
 * Expand a Windows 8.3 short path (or a symlinked directory) to its long form.
 *
 * Codex's Windows sandbox compares writable roots by string: a workspace spelled
 * `C:\Users\ADMINI~1\...` next to a `%TEMP%` spelled `C:\Users\Administrator\...`
 * is treated as two disjoint roots, and unelevated refuses to start any command
 * ("cannot enforce split writable root sets"). Normalizing once at session creation
 * keeps the sandbox, the file tree, and the preview on one spelling.
 */
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
      // 交由 route 的 catch 回 413；这里只负责停止继续累积。
      try { req.destroy(); } catch { /* already gone */ }
    };
    req.on('data', (chunk) => {
      if (settled) return;
      // 按**字节**计：data.length 是 UTF-16 码元数，中文/emoji 实际放行到 8-12MB。
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) { fail(new Error('body too large')); return; }
      data += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
    });
    req.on('error', (error) => { if (!settled) { settled = true; reject(error); } });
  });
}

function json(res, status, value) {
  const payload = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * 用系统默认程序打开一个路径或 URL（文件/文件夹/链接都同一套）。
 *
 * 安全注意：**不要**拼进 `cmd /c start`——cmd 在解析命令串时既把换行当分隔符，
 * 又会按控制台代码页解读参数，中文路径会静默打不开。这里直接把参数交给
 * explorer.exe / rundll32：Node 通过 CreateProcessW 传 UTF-16，绕开 cmd 的解析。
 * 控制字符与引号仍然一律拒绝（target 来自 HTTP 请求体）。
 */
function openTarget(target) {
  const value = text(target).trim();
  if (!value) return false;
  if (/[\u0000-\u001f\u007f"]/.test(value)) return false;
  try {
    if (/^(https?|mailto):/i.test(value)) {
      spawn('rundll32.exe', ['url.dll,FileProtocolHandler', value], { detached: true, windowsHide: true }).unref();
    } else {
      spawn('explorer.exe', [value], { detached: true, windowsHide: true }).unref();
    }
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------- skills */

/**
 * 读 SKILL.md 的 frontmatter（只取 name / description 两项）。
 * 两个 CLI 的 SKILL.md 都是 `---` 包起来的小段 YAML；这里不引依赖，只做够用的
 * 解析：`key: value` 单行、以及 `key: >` / `key: |` 这类折行块。
 * @param {string} raw SKILL.md 文本
 * @returns {{name: string, description: string}}
 */
function parseSkillFrontmatter(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '');
  const out = { name: '', description: '' };
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const body = match ? match[1] : '';
  const lines = body.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const kv = line.match(/^(name|description)\s*:\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const block = [];
      while (index + 1 < lines.length && (/^\s{2,}/.test(lines[index + 1]) || lines[index + 1].trim() === '')) {
        index += 1;
        block.push(lines[index].trim());
      }
      value = block.join(value.startsWith('|') ? '\n' : ' ').trim();
    } else {
      value = value.replace(/^['"]|['"]$/g, '');
    }
    if (kv[1] === 'description' && !out.description) out.description = value;
    else if (kv[1] === 'name' && !out.name) out.name = value;
  }
  return out;
}

/**
 * 在一个 skills 目录里找 SKILL.md；最多两层（`xxx/SKILL.md` 与 `xxx/xxx/SKILL.md`）。
 *
 * 这里有两个坑，之前让「技能一个都看不到」：
 * 1. `Dirent.isDirectory()` 对符号链接返回 false。用目录链接 / junction（`mklink /D`
 *    `ln -s`）装进来的技能会被整片跳过——用户明明装了，列表却是空的。
 * 2. 点开头的一律跳过（`.system` 之类），但 Codex 的内置技能恰好就在 `.codex/skills/.system`
 *    里。所以隐藏目录只跳过「直接就是技能」的那种，仍然往里找一层。
 * @param {string} root skills 根目录
 * @param {number} depth 允许的最大层数
 */
function collectSkillFiles(root, depth) {
  const found = [];
  /* 有没有因为层数上限而没去看的目录：有的话调用方要如实告诉用户，
     否则「技能少了一个」会被误当成没装。 */
  let truncated = false;
  const isDir = (dir) => {
    try { return statSync(dir).isDirectory(); } catch { return false; }
  };
  const walk = (dir, level) => {
    if (level > depth) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      /* 符号链接拿不到 isDirectory，只能实际探一次；探不到就当它不是目录 */
      const directory = entry.isDirectory() || (entry.isSymbolicLink() && isDir(child));
      if (!directory) continue;
      const file = path.join(child, 'SKILL.md');
      const hasSkill = existsSync(file);
      if (hasSkill && !entry.name.startsWith('.')) {
        found.push({ dir: child, dirName: entry.name, file });
        continue;
      }
      // 隐藏目录不收自身，但里面的技能照收（Codex 的 .system 内置技能）
      if (level >= depth) {
        // 已经到了允许的最深层，下一层可能还有技能；记下来，别让它静默消失
        truncated = true;
        continue;
      }
      walk(child, level + 1);
    }
  };
  walk(root, 1);
  return { files: found, truncated };
}

/**
 * 选出本插件的数据目录，并记录它的来源。
 *
 * 宿主进程可能带 DSH_PROFILE_DIR（profile 启动），也可能没有（回退到 ~/.dsh）。
 * 两种启动方式指向不同目录，如果简单地「有 profile 就用 profile」，用户一旦换了
 * 启动方式就会看到「会话全没了」——其实是读了另一个空目录。
 *
 * 所以按「谁的 sessions.json 更新就用谁」选主；两个候选都为空时才按 profile 优先
 * 创建。选中的目录之后会持续被写入，savedAt 自然最大，因此结果是自稳定的：一旦
 * 选定就不会在两个目录之间来回跳。
 *
 * 选错的代价只是「看不见」，不会损坏对话——这里存的是索引与界面状态，对话本体
 * 始终在 CLI 自己手里（~/.claude/projects、~/.codex/sessions）。
 *
 * @returns {{dir: string, source: 'profile' | 'home-fallback'}}
 */
function dataDirectory() {
  const candidates = [];
  if (process.env.DSH_PROFILE_DIR) {
    candidates.push({ dir: path.join(process.env.DSH_PROFILE_DIR, 'cli-workbench'), source: 'profile' });
  }
  candidates.push({ dir: path.join(os.homedir(), '.dsh', 'cli-workbench'), source: 'home-fallback' });

  const freshness = (dir) => {
    const file = path.join(dir, 'sessions.json');
    let parsed;
    try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
    catch { return { at: 0, has: false }; } // 不存在或已损坏：两个候选里它不该胜出
    const savedAt = Number(parsed && parsed.savedAt) || 0;
    if (savedAt) return { at: savedAt, has: true };
    // 老文件可能还没有 savedAt 字段，退回文件时间。
    try { return { at: statSync(file).mtimeMs || 0, has: true }; }
    catch { return { at: 0, has: true }; }
  };

  let best = null;
  for (const candidate of candidates) {
    const seen = freshness(candidate.dir);
    if (!seen.has) continue;
    if (!best || seen.at > best.at) best = { dir: candidate.dir, source: candidate.source, at: seen.at };
  }
  if (best) return { dir: best.dir, source: best.source };
  return candidates[0];
}

function imageSize(buffer) {
  try {
    if (buffer.length > 24 && buffer[0] === 0x89 && buffer[1] === 0x50) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (buffer.length > 10 && buffer.slice(0, 3).toString('ascii') === 'GIF') {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) { offset += 1; continue; }
        const marker = buffer[offset + 1];
        const length = buffer.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
    }
  } catch { /* unknown size */ }
  return null;
}

class Workbench {
  constructor(ctx) {
    this.ctx = ctx;
    const picked = dataDirectory();
    this.dir = picked.dir;
    // 数据目录的来源（profile / home-fallback）：换启动方式导致「会话不见了」时，
    // 这是唯一能一眼看出来的线索，所以随 /status 暴露给设置面板。
    this.dataDirSource = picked.source;
    this.file = path.join(this.dir, 'sessions.json');
    this.settingsFile = path.join(this.dir, 'settings.json');
    this.mcpDir = path.join(this.dir, 'mcp');
    this.sessions = new Map();
    this.workspaces = new Map();
    this.streams = new Map();
    this.procs = new Map();
    this.approvals = new Map();
    this.deltaTimers = new Map();
    this.deltaBuffers = new Map();
    this.saveTimer = null;
    this.statusCache = { at: 0, value: null };
    this.updateCache = { at: 0, value: null };
    this.codexSandboxCache = null;
    this.codexSandboxPromise = null;
    this.compatCache = new Map();
    this.upgrading = new Set();
    this.unmountTimer = null;
    this.disposed = false;
    try { mkdirSync(this.mcpDir, { recursive: true }); } catch { /* ignore */ }
    this.settings = this.loadSettings();
    this.load();
  }

  /* ------------------------------------------------------- default modes */

  loadSettings() {
    const defaults = {
      claudeMode: 'manual',
      codexMode: 'workspace-write',
      codexSandboxBackend: 'auto',
      // 用户在这个插件里自己配过的模型（只出现在模型菜单里，不改 CLI 的全局配置）
      customModels: { claude: [], codex: [] },
    };
    try {
      if (existsSync(this.settingsFile)) {
        const parsed = JSON.parse(readFileSync(this.settingsFile, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          if (PERMISSION_MODES.has(parsed.claudeMode)) defaults.claudeMode = parsed.claudeMode;
          if (SANDBOX_MODES.has(parsed.codexMode)) defaults.codexMode = parsed.codexMode;
          if (SANDBOX_BACKENDS.has(parsed.codexSandboxBackend)) defaults.codexSandboxBackend = parsed.codexSandboxBackend;
          defaults.customModels = this.normalizeCustomModels(parsed.customModels);
        }
      }
    } catch { /* an unreadable settings file falls back to the defaults */ }
    return defaults;
  }

  /**
   * 自定义模型只接受「能安全拼进命令行」的名字：字母、数字和常见的 `.-_:/@`，
   * 最多 80 个字符、每种 CLI 最多 20 个。宁可在保存时挡掉，也不要在执行时
   * 把奇怪字符拼进 `--model`。
   */
  normalizeCustomModels(input) {
    const out = { claude: [], codex: [] };
    for (const provider of ['claude', 'codex']) {
      const list = input && Array.isArray(input[provider]) ? input[provider] : [];
      const seen = new Set();
      for (const raw of list) {
        const value = typeof raw === 'string' ? raw.trim() : '';
        if (!value || value.length > 80) continue;
        if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(value)) continue;
        const key = value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out[provider].push(value);
        if (out[provider].length >= 20) break;
      }
    }
    return out;
  }

  saveSettings() {
    try {
      mkdirSync(this.dir, { recursive: true });
      const payload = JSON.stringify({ ...this.settings }, null, 2);
      const tmp = this.settingsFile + '.tmp';
      writeFileSync(tmp, payload);
      renameSync(tmp, this.settingsFile);
    } catch { /* ignore */ }
  }

  normalizeSettings(input) {
    const next = { ...this.settings };
    if (input && PERMISSION_MODES.has(input.claudeMode)) next.claudeMode = input.claudeMode;
    if (input && SANDBOX_MODES.has(input.codexMode)) next.codexMode = input.codexMode;
    if (input && SANDBOX_BACKENDS.has(input.codexSandboxBackend)) next.codexSandboxBackend = input.codexSandboxBackend;
    if (input && input.customModels !== undefined) next.customModels = this.normalizeCustomModels(input.customModels);
    return next;
  }

  /* ---------------------------------------------------------------- store */

  load() {
    try {
      if (!existsSync(this.file)) return;
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      // A state file written before workspaces existed has no `workspaces` key
      // (as opposed to an empty list, which is a real user choice after deleting
      // every workspace). Only the missing key seeds the registry from sessions.
      const storedWorkspaces = Array.isArray(parsed.workspaces) ? parsed.workspaces : null;
      for (const raw of storedWorkspaces || []) {
        if (!raw || typeof raw !== 'object') continue;
        const dir = realCwd(text(raw.cwd));
        if (!dir) continue;
        this.workspaces.set(dir.toLowerCase(), {
          cwd: dir,
          title: text(raw.title) || path.basename(dir) || dir,
          addedAt: Number(raw.addedAt) || now(),
        });
      }
      const list = Array.isArray(parsed.sessions) ? parsed.sessions : [];
      for (const raw of list) {
        if (!raw || typeof raw !== 'object' || !raw.id) continue;
        const session = {
          id: String(raw.id),
          provider: raw.provider === 'codex' ? 'codex' : 'claude',
          cwd: realCwd(text(raw.cwd)),
          title: text(raw.title) || '未命名会话',
          createdAt: Number(raw.createdAt) || now(),
          updatedAt: Number(raw.updatedAt) || now(),
          status: raw.status === 'running' || raw.status === 'waiting' ? 'interrupted' : (raw.status || 'idle'),
          pinned: Boolean(raw.pinned),
          archived: Boolean(raw.archived),
          archivedKind: text(raw.archivedKind),
          archivedAt: Number(raw.archivedAt) || null,
          claudeSessionId: raw.claudeSessionId || null,
          codexThreadId: raw.codexThreadId || null,
          permissionMode: PERMISSION_MODES.has(raw.permissionMode) ? raw.permissionMode : 'manual',
          sandboxMode: SANDBOX_MODES.has(raw.sandboxMode) ? raw.sandboxMode : 'workspace-write',
          model: text(raw.model),
          allowedTools: Array.isArray(raw.allowedTools) ? raw.allowedTools.filter((x) => typeof x === 'string') : [],
          items: Array.isArray(raw.items) ? raw.items.slice(-MAX_ITEMS) : [],
          // 累计被裁掉的历史条数（老文件没有这个字段，按 0 处理）
          itemBase: Number(raw.itemBase) || 0,
          usage: raw.usage && typeof raw.usage === 'object' ? raw.usage : null,
          files: Array.isArray(raw.files) ? raw.files : [],
          // 运行提示（Codex 的告警等）原来只写不读，重启后整块消失；
          // 它是有用的诊断信息（比如归档命令失败），必须跟着落盘回来。
          advisories: Array.isArray(raw.advisories) ? raw.advisories.slice(-8) : [],
          error: raw.error && typeof raw.error === 'object' ? raw.error : null,
          pending: null,
          pendingQueue: [],
        };
        if (session.items.length) {
          const last = session.items[session.items.length - 1];
          if (last && last.kind === 'assistant') last.streaming = false;
          for (const item of session.items) {
            if (item && item.kind === 'tool' && item.status === 'running') item.status = 'error';
          }
        }
        this.sessions.set(session.id, session);
      }
      if (storedWorkspaces === null && this.sessions.size) {
        // First start on this build: every directory that already has a session
        // becomes a workspace, so upgrading never shuffles existing work into
        // "未分组".
        const origins = [...this.sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
        for (const session of origins) {
          const dir = text(session.cwd);
          if (!dir) continue;
          const key = dir.toLowerCase();
          if (this.workspaces.has(key)) continue;
          this.workspaces.set(key, {
            cwd: dir,
            title: path.basename(dir) || dir,
            addedAt: Number(session.createdAt) || now(),
          });
        }
        if (this.workspaces.size) this.scheduleSave();
      }
    } catch (error) {
      try {
        if (existsSync(this.file)) renameSync(this.file, this.file + '.broken-' + now());
      } catch { /* ignore */ }
    }
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 400);
  }

  save() {
    try {
      mkdirSync(this.dir, { recursive: true });
      const sessions = [...this.sessions.values()].map((session) => {
        // 内存态与持久态必须分开：session 上挂着 _reapTimer（Timeout 对象，含循环
        // 引用）、_mcpToken、_textIds 等私有字段，直接展开会让 JSON.stringify 抛异常，
        // 而异常被下面的 catch 吞掉 → 整份 sessions.json 静默停止更新（删掉的会话
        // 重启后复活、退出时丢全部会话）。这里按前缀统一剥离，新增私有字段无需再记清单。
        const copy = { ...session };
        for (const key of Object.keys(copy)) {
          if (key.charCodeAt(0) === 95 /* _ */) delete copy[key];
        }
        copy.pending = null;
        copy.pendingQueue = [];
        copy.items = session.items.slice(-MAX_ITEMS);
        return copy;
      });
      const payload = JSON.stringify({ version: 2, savedAt: now(), workspaces: this.workspaceList(), sessions });
      const tmp = this.file + '.tmp';
      writeFileSync(tmp, payload);
      renameSync(tmp, this.file);
      this.saveError = null;
    } catch (error) {
      // 写盘失败不能打断一回合，但也不能一声不吭——把原因留下来供 /status 查看。
      this.saveError = String(error && error.message ? error.message : error);
    }
  }

  /* ------------------------------------------------------------- lifecycle */

  /**
   * 宿主回收插件（dispose）会杀掉所有 CLI 进程。用户从「其它」面板切回来、或者
   * 只是短暂离开，都会触发一次回收，于是发出消息的一瞬间 CLI 就不在了——界面上
   * 表现为「CLI 连接中断，本轮已停止」。
   *
   * 现在的门槛是「有没有活要保」：仍在跑的任务、等着审批的调用、正在开着的事件流
   * 都算。有活就推迟到 IDLE_UNMOUNT_MS 再看一次；没活才真正回收。这样既不会在
   * 任务进行中拔电源，也不会让没有任何活动的插件赖着不走。真正卸载插件 / DSH 退出
   * 时 dispose 会立刻执行，不受这里的推迟影响。
   */
  scheduleIdleUnmount() {
    if (this.unmountTimer !== null) {
      clearTimeout(this.unmountTimer);
      this.unmountTimer = null;
    }
    this.unmountTimer = setTimeout(() => {
      this.unmountTimer = null;
      if (this.hasLiveWork()) {
        this.scheduleIdleUnmount();
        return;
      }
      this.dispose();
    }, IDLE_UNMOUNT_MS);
    // 计时器不该拖住 DSH 退出
    if (this.unmountTimer && typeof this.unmountTimer.unref === 'function') this.unmountTimer.unref();
  }

  /** 有没有不能被打断的活：跑着的回合、等审批、开着的事件流、正在升级 CLI。 */
  hasLiveWork() {
    if (this.approvals.size > 0) return true;
    if (this.upgrading.size > 0) return true;
    for (const set of this.streams.values()) if (set && set.size > 0) return true;
    for (const session of this.sessions.values()) {
      if (session && (session._turnActive || session.status === 'running' || session.status === 'waiting')) return true;
    }
    return false;
  }

  /** 取消已排期的回收（客户端重新挂载时调用）。 */
  cancelIdleUnmount() {
    if (this.unmountTimer === null) return false;
    clearTimeout(this.unmountTimer);
    this.unmountTimer = null;
    return true;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.unmountTimer !== null) { clearTimeout(this.unmountTimer); this.unmountTimer = null; }
    for (const timer of this.deltaTimers.values()) clearTimeout(timer);
    this.deltaTimers.clear();
    for (const { resolve, timer } of this.approvals.values()) {
      clearTimeout(timer);
      try { resolve({ behavior: 'deny', message: '工作台已卸载。' }); } catch { /* ignore */ }
    }
    this.approvals.clear();
    for (const session of this.sessions.values()) this.clearReap(session);
    for (const child of this.procs.values()) killTree(child);
    this.procs.clear();
    try { rmSync(this.mcpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    for (const set of this.streams.values()) {
      for (const res of set) { try { res.end(); } catch { /* ignore */ } }
    }
    this.streams.clear();
    this.save();
  }

  session(id) {
    return this.sessions.get(id) || null;
  }

  /* ----------------------------------------------------------- workspaces */

  workspaceList() {
    return [...this.workspaces.values()]
      .sort((a, b) => a.addedAt - b.addedAt)
      .map((entry) => ({ cwd: entry.cwd, title: entry.title, addedAt: entry.addedAt }));
  }

  ensureWorkspace(dir) {
    const cwd = realCwd(text(dir));
    if (!cwd) return null;
    const existing = this.workspaces.get(cwd.toLowerCase());
    if (existing) return existing;
    const entry = { cwd, title: path.basename(cwd) || cwd, addedAt: now() };
    this.workspaces.set(cwd.toLowerCase(), entry);
    // 用户的一次显式操作：立刻落盘，避免 debounce 窗口里崩掉丢掉工作区增删。
    this.save();
    return entry;
  }

  /**
   * Remove a directory from the workbench's workspace list. The folder and its
   * sessions are untouched: like DSH, the sessions fall back to "未分组" and can
   * re-register the workspace by starting a new session there.
   */
  removeWorkspace(dir) {
    const cwd = realCwd(text(dir));
    const entry = cwd ? this.workspaces.get(cwd.toLowerCase()) : null;
    if (!entry) return false;
    this.workspaces.delete(entry.cwd.toLowerCase());
    this.save();
    return true;
  }

  publicSession(session) {
    return {
      id: session.id,
      provider: session.provider,
      cwd: session.cwd,
      title: session.title,
      status: session.status,
      pinned: session.pinned,
      archived: session.archived,
      archivedKind: session.archivedKind,
      archivedAt: Number(session.archivedAt) || null,
      claudeSessionId: session.claudeSessionId,
      codexThreadId: session.codexThreadId,
      permissionMode: session.permissionMode,
      sandboxMode: session.sandboxMode,
      model: session.model,
      allowedTools: session.allowedTools,
      usage: session.usage,
      files: session.files,
      error: session.error,
      // 「正在干什么」的真实阶段：spawn（拉起进程）→ waiting（等首字）→ streaming / tool。
      // 冷启动实测要 5 秒左右，没有这个字段的话界面只能笼统显示「运行中」。
      turnPhase: session._turnPhase || null,
      turnStartedAt: Number(session._turnStartedAt) || null,
      // 被 MAX_ITEMS 裁掉的历史条数；0 表示界面显示的就是全部。
      omittedItems: Number(session.itemBase) || 0,
      advisories: Array.isArray(session.advisories) ? session.advisories.slice(-8) : [],
      pending: session.pending
        ? {
          requestId: session.pending.requestId,
          toolName: session.pending.toolName,
          input: session.pending.input,
          impact: session.pending.impact,
          toolUseId: session.pending.toolUseId,
          createdAt: session.pending.createdAt,
          expiresAt: session.pending.expiresAt,
        }
        : null,
      pendingCount: session.pendingQueue.length + (session.pending ? 1 : 0),
      updatedAt: session.updatedAt,
      createdAt: session.createdAt,
      itemCount: session.items.length,
    };
  }

  touch(session) {
    session.updatedAt = now();
    this.scheduleSave();
  }

  push(session, item) {
    // 回合阶段：客户端用它区分「还在拉起 CLI」「已连上等首字」「在执行工具」。
    // 只有真正产出内容的两种条目推进它，user/notice/error 不改状态。
    if (item.kind === 'tool') {
      session._turnPhase = 'tool';
      session._turnSteps = (Number(session._turnSteps) || 0) + 1;
    }
    else if (item.kind === 'assistant' || item.kind === 'thinking') session._turnPhase = 'streaming';
    session.items.push(item);
    if (session.items.length > MAX_ITEMS) {
      const dropped = session.items.length - MAX_ITEMS;
      session.items.splice(0, dropped);
      // 记下累计裁掉的条数：界面要如实说「更早的 N 条没显示」，
      // 否则长会话看起来像是凭空从中间开始的。
      session.itemBase = (Number(session.itemBase) || 0) + dropped;
    }
    this.emit(session, { type: 'item', item });
    this.touch(session);
    return item;
  }

  patch(session, id, patch) {
    const item = session.items.find((entry) => entry.id === id);
    if (!item) return;
    Object.assign(item, patch);
    this.emit(session, { type: 'item-patch', id, patch });
    this.touch(session);
  }

  sessionEvent(session) {
    this.emit(session, { type: 'session', session: this.publicSession(session) });
  }

  emit(session, event) {
    const set = this.streams.get(session.id);
    if (!set || set.size === 0) return;
    const payload = 'data: ' + JSON.stringify(event) + '\n\n';
    for (const res of set) {
      // 对已断开的连接调用 write 是**异步**报错，try/catch 拦不住；没有 error 监听
      // 就会以 uncaughtException 击穿整个宿主。先看状态，剩余异常由 attachStream 兜底。
      if (res.writableEnded || res.destroyed) { set.delete(res); continue; }
      try { res.write(payload); } catch { set.delete(res); }
    }
  }

  queueDelta(session, id, chunk) {
    const current = this.deltaBuffers.get(session.id);
    if (current && current.id === id) current.text += chunk;
    else this.deltaBuffers.set(session.id, { id, text: chunk });
    if (this.deltaTimers.has(session.id)) return;
    this.deltaTimers.set(session.id, setTimeout(() => {
      this.deltaTimers.delete(session.id);
      const buffer = this.deltaBuffers.get(session.id);
      this.deltaBuffers.delete(session.id);
      if (buffer && buffer.text) this.emit(session, { type: 'delta', id: buffer.id, text: buffer.text });
    }, 40));
  }

  /* -------------------------------------------------------------- snapshot */

  snapshot(session) {
    return { type: 'snapshot', session: this.publicSession(session), items: session.items };
  }

  /* -------------------------------------------------------------- routing */

  /**
   * 拒绝跨站写请求。
   *
   * 这些路由没有会话鉴权，而本机任意网页都能用 `Content-Type: text/plain` 的
   * no-cors 请求绕过 CORS 预检直接打进来（改写 CLAUDE.md、驱动 /open 等都是这个口子）。
   * 浏览器对跨站请求一定带 Origin / Sec-Fetch-Site，非浏览器客户端（审批桥、curl）
   * 不带 —— 所以：带了 Origin 且不是本机同端口，就拒绝。
   */
  crossSite(req) {
    if (req.headers['sec-fetch-site'] === 'cross-site') return true;
    const origin = req.headers.origin;
    if (!origin) return false;
    try {
      const parsed = new URL(origin);
      const self = new URL(this.ctx.webServer.getOrigin());
      const loopback = (host) => host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
      // 本机回环之间只比端口：用户可能用 localhost 打开、插件注册的是 127.0.0.1。
      if (loopback(parsed.hostname) && loopback(self.hostname)) return parsed.port !== self.port;
      return parsed.origin !== self.origin;
    } catch {
      return true;
    }
  }

  async handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      res.statusCode = 400; res.end(); return;
    }
    if (!url.pathname.startsWith(API)) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    // 只拦写操作：GET 的响应没有 CORS 头，跨站读不到内容，改动它反而容易误伤。
    if (req.method !== 'GET' && req.method !== 'HEAD' && this.crossSite(req)) {
      try { json(res, 403, { error: '跨站请求已拒绝' }); } catch { /* headers sent */ }
      return;
    }
    const route = url.pathname.slice(API.length) || '/';
    try {
      await this.route(req, res, url, route);
    } catch (error) {
      const message = String(error && error.message || error);
      // 请求体超限是一个明确的客户端错误，别混成 500
      const status = message === 'body too large' ? 413 : 500;
      try { json(res, status, { error: status === 413 ? '请求体超过 4MB' : message }); } catch { /* headers sent */ }
    }
  }

  async route(req, res, url, route) {
    const method = req.method || 'GET';
    /* 宿主在最后一个面板卸载后约 1s 就回收插件；切走再切回来（甚至只是从别的
       面板点回来）都会走到这里。回收 = 杀 CLI，正在跑的任务会被一刀切断，界面上
       表现为「CLI 连接中断」。所以只有「确实没活」时才允许回收：
       - 有跑着的回合 / 等审批 / 开着的事件流 → 推迟，稍后再看；
       - 什么都没在跑 → 照常回收，不赖着不走。
       客户端挂载时的 /unmount-cancel 仍然保留，作为额外的提前信号。 */
    if (!this.hasLiveWork()) this.scheduleIdleUnmount();
    if (route === '/unmount-cancel' && method === 'POST') {
      if (this.unmountTimer !== null) { clearTimeout(this.unmountTimer); this.unmountTimer = null; }
      return json(res, 200, { ok: true });
    }
    if (route === '/status' && method === 'GET') {
      return json(res, 200, await this.status());
    }
    if (route === '/settings' && method === 'GET') {
      return json(res, 200, this.settings);
    }
    if (route === '/settings' && method === 'POST') {
      const body = await readBody(req);
      this.settings = this.normalizeSettings(body);
      this.saveSettings();
      // The backend choice changes the sandbox probe, so drop the cached results.
      this.codexSandboxCache = null;
      this.statusCache = { at: 0, value: null };
      return json(res, 200, this.settings);
    }
    if (route === '/models' && method === 'GET') {
      return json(res, 200, this.models());
    }
    if (route === '/updates' && method === 'GET') {
      return json(res, 200, await this.updates(url.searchParams.get('force') === '1'));
    }
    if (route === '/skills' && method === 'GET') {
      const cwd = text(url.searchParams.get('cwd') || '');
      return json(res, 200, this.skills(cwd));
    }
    if (route === '/rules' && method === 'GET') {
      const cwd = text(url.searchParams.get('cwd') || '');
      const provider = text(url.searchParams.get('provider') || '');
      return json(res, 200, { files: this.rulesFiles(cwd, provider) });
    }
    if (route === '/rules' && method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, await this.writeRules(body));
    }
    if (route === '/preview' && method === 'GET') {
      const file = text(url.searchParams.get('path') || '');
      const lines = Number(url.searchParams.get('lines')) || 0;
      // 带 session 时按会话工作区边界校验；不带时要求落在任一已注册工作区内。
      // 否则这个端点能读本机任意文件（和 /fs/file 的 403 边界不一致）。
      const sessionId = text(url.searchParams.get('session') || '');
      if (sessionId) {
        const session = this.session(sessionId);
        if (!session) return json(res, 404, { error: 'session not found' });
        const safe = this.safePath(session, file);
        if (!safe) return json(res, 403, { error: 'path outside workspace' });
        return json(res, 200, this.previewAny(safe, lines));
      }
      if (!this.withinAnyWorkspace(file)) return json(res, 403, { error: 'path outside workspace' });
      return json(res, 200, this.previewAny(file, lines));
    }
    if (route === '/sessions' && method === 'GET') {
      return json(res, 200, { sessions: this.list() });
    }
    if (route === '/workspaces' && method === 'GET') {
      return json(res, 200, { workspaces: this.workspaceList() });
    }
    if (route === '/workspaces' && method === 'PATCH') {
      const body = await readBody(req);
      const cwd = realCwd(text(body.cwd || ''));
      const title = text(body.title || '').trim();
      if (!cwd) return json(res, 400, { error: 'cwd required' });
      if (!title) return json(res, 400, { error: '工作区名称不能为空' });
      if (title.length > 60) return json(res, 400, { error: '工作区名称最长 60 个字符' });
      const entry = this.workspaces.get(cwd.toLowerCase());
      if (!entry) return json(res, 404, { error: '工作区不存在：' + cwd });
      // 只改左栏的显示名，磁盘目录与目录里的会话都不动
      entry.title = title;
      this.save();
      return json(res, 200, { ok: true, workspaces: this.workspaceList() });
    }
    if (route === '/workspaces' && method === 'DELETE') {
      const cwd = text(url.searchParams.get('cwd') || '');
      if (!cwd) return json(res, 400, { error: 'cwd required' });
      if (!this.removeWorkspace(cwd)) return json(res, 404, { error: '工作区不存在：' + cwd });
      return json(res, 200, { ok: true, workspaces: this.workspaceList() });
    }
    if (route === '/sessions' && method === 'POST') {
      const body = await readBody(req);
      const provider = body.provider === 'codex' ? 'codex' : body.provider === 'claude' ? 'claude' : null;
      if (!provider) return json(res, 400, { error: 'unknown provider' });
      const cwd = realCwd(text(body.cwd).trim());
      if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
        return json(res, 400, { error: '工作目录不存在：' + cwd });
      }
      const session = {
        id: idOf('cw'),
        provider,
        cwd,
        title: '新会话',
        createdAt: now(),
        updatedAt: now(),
        status: 'idle',
        pinned: false,
        archived: false,
        archivedKind: '',
        claudeSessionId: null,
        codexThreadId: null,
        permissionMode: body.permissionMode && PERMISSION_MODES.has(body.permissionMode)
          ? body.permissionMode
          : this.settings.claudeMode,
        sandboxMode: body.sandboxMode && SANDBOX_MODES.has(body.sandboxMode)
          ? body.sandboxMode
          : this.settings.codexMode,
        model: '',
        allowedTools: [],
        items: [],
        usage: null,
        files: [],
        error: null,
        pending: null,
        pendingQueue: [],
      };
      this.sessions.set(session.id, session);
      this.ensureWorkspace(cwd);
      this.scheduleSave();
      return json(res, 200, { session: this.publicSession(session), items: [], workspaces: this.workspaceList() });
    }
    const sessionMatch = route.match(/^\/sessions\/([\w.-]+)(\/[a-z]+)?$/);
    if (sessionMatch) {
      const session = this.session(sessionMatch[1]);
      if (!session) return json(res, 404, { error: 'session not found' });
      const action = sessionMatch[2] || '';
      if (!action && method === 'GET') {
        return json(res, 200, { session: this.publicSession(session), items: session.items });
      }
      if (!action && method === 'PATCH') {
        const body = await readBody(req);
        return json(res, 200, { session: this.publicSession(await this.updateSession(session, body)) });
      }
      if (!action && method === 'DELETE') {
        await this.deleteSession(session);
        return json(res, 200, { ok: true });
      }
      if (action === '/message' && method === 'POST') {
        const body = await readBody(req);
        const content = text(body.text).trim();
        if (!content) return json(res, 400, { error: 'empty message' });
        if (session.status === 'running' || session.status === 'waiting') {
          return json(res, 409, { error: '该会话正在运行，先停止或等待完成' });
        }
        // 客户端只落 `/技能名` 短令牌，正文在这里展开（与 DSH 的 pre-step 一致）
        await this.send(session, this.expandSkillTokens(content, session.cwd, session.provider));
        return json(res, 200, { ok: true, session: this.publicSession(session) });
      }
      if (action === '/stop' && method === 'POST') {
        await this.stop(session);
        return json(res, 200, { ok: true, session: this.publicSession(session) });
      }
      if (action === '/approve' && method === 'POST') {
        const body = await readBody(req);
        const decision = body.decision === 'allow' || body.decision === 'always' || body.decision === 'deny'
          ? body.decision : null;
        if (!decision) return json(res, 400, { error: 'bad decision' });
        const ok = this.resolveApproval(session, text(body.requestId), decision, text(body.reason));
        return json(res, ok ? 200 : 404, ok
        ? { ok, session: this.publicSession(session) }
        : { ok, error: '审批已失效或已处理（可能已超时）', session: this.publicSession(session) });
      }
      if (action === '/stream' && method === 'GET') {
        this.attachStream(session, req, res);
        return undefined;
      }
    }
    if (route === '/permission' && method === 'POST') {
      const body = await readBody(req);
      return this.handlePermission(req, res, body);
    }
    if (route === '/permission/cancel' && method === 'POST') {
      const body = await readBody(req);
      return this.cancelPermission(req, res, body);
    }
    if (route === '/fs/tree' && method === 'GET') {
      const session = this.session(url.searchParams.get('session') || '');
      if (!session) return json(res, 404, { error: 'session not found' });
      const dir = text(url.searchParams.get('path')) || session.cwd;
      const safe = this.safePath(session, dir);
      if (!safe) return json(res, 403, { error: 'path outside workspace' });
      return json(res, 200, this.tree(session, safe, Number(url.searchParams.get('depth') || 2)));
    }
    if (route === '/fs/file' && method === 'GET') {
      const session = this.session(url.searchParams.get('session') || '');
      if (!session) return json(res, 404, { error: 'session not found' });
      const target = this.safePath(session, text(url.searchParams.get('path')));
      if (!target) return json(res, 403, { error: 'path outside workspace' });
      return json(res, 200, this.preview(target));
    }
    if (route === '/open' && method === 'POST') {
      const body = await readBody(req);
      const target = text(body.target);
      const session = body.session ? this.session(text(body.session)) : null;
      if (session && body.locate) {
        const safe = this.safePath(session, target);
        if (!safe) return json(res, 403, { error: 'path outside workspace' });
        spawn('explorer.exe', ['/select,', safe], { detached: true, windowsHide: true }).unref();
        return json(res, 200, { ok: true });
      }
      if (!target) return json(res, 400, { error: 'empty target' });
      if (!openTarget(target)) return json(res, 400, { error: '无法打开该路径' });
      return json(res, 200, { ok: true });
    }
    if (route === '/upgrade' && method === 'POST') {
      const body = await readBody(req);
      const provider = body.provider === 'codex' ? 'codex' : body.provider === 'claude' ? 'claude' : null;
      if (!provider) return json(res, 400, { error: 'unknown provider' });
      if (this.upgrading.has(provider)) return json(res, 409, { error: '升级已在进行中' });
      this.upgrading.add(provider);
      try {
        const result = await this.upgrade(provider);
        this.statusCache = { at: 0, value: null };
        this.updateCache = { at: 0, value: null };
        return json(res, 200, result);
      } finally {
        this.upgrading.delete(provider);
      }
    }
    return json(res, 404, { error: 'not found' });
  }

  list() {
    return [...this.sessions.values()]
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.updatedAt - a.updatedAt;
      })
      .map((session) => this.publicSession(session));
  }

  async updateSession(session, body) {
    const before = { permissionMode: session.permissionMode, model: session.model };
    if (typeof body.title === 'string' && body.title.trim()) session.title = oneLine(body.title.trim(), 60);
    if (typeof body.pinned === 'boolean') session.pinned = body.pinned;
    if (typeof body.model === 'string') session.model = body.model.trim();
    if (typeof body.permissionMode === 'string' && PERMISSION_MODES.has(body.permissionMode)) {
      session.permissionMode = body.permissionMode;
    }
    if (typeof body.sandboxMode === 'string' && SANDBOX_MODES.has(body.sandboxMode)) {
      session.sandboxMode = body.sandboxMode;
    }
    if (Array.isArray(body.allowedTools)) {
      session.allowedTools = body.allowedTools.filter((name) => typeof name === 'string').slice(0, 40);
    }
    if (session.provider === 'claude' && !session._turnActive &&
      (before.permissionMode !== session.permissionMode || before.model !== session.model)) {
      const child = this.procs.get(session.id);
      if (child) {
        killTree(child);
        this.procs.delete(session.id);
      }
    }
    if (typeof body.archived === 'boolean' && body.archived !== session.archived) {
      session.archived = body.archived;
      // 归档时间：界面按它排序和分层（「今天刚归档」不该掉进「更早」）。
      // 原来 Host 从不写这个字段，客户端只能退回 updatedAt，排序就失真了。
      session.archivedAt = body.archived ? now() : null;
      const native = session.provider === 'codex' && Boolean(session.codexThreadId);
      if (body.archived) {
        session.archivedKind = native ? '原生归档 · codex archive' : '软归档 · CLI resume 仍可见';
        if (native) {
          // 原生命令可能根本不存在（旧版 Codex）或执行失败。原来 .catch(() => {}) 吞掉，
          // 界面却照旧写「原生归档」。这里按真实结果回填，失败就说清楚是软归档。
          const thread = session.codexThreadId;
          run('codex archive "' + thread + '"').then((result) => {
            if (result && result.code === 0) return;
            session.archivedKind = '软归档 · 原生命令失败';
            session.advisories = (Array.isArray(session.advisories) ? session.advisories : [])
              .concat([{ kind: 'archive', text: 'codex archive 未成功：' + oneLine(text(result && result.stderr) || '无输出', 160), at: now() }])
              .slice(-8);
          }).catch(() => {
            session.archivedKind = '软归档 · 原生命令失败';
          }).finally(() => {
            this.sessionEvent(session);
            this.save();
          });
        }
      } else {
        session.archivedKind = '';
        if (native) {
          const thread = session.codexThreadId;
          run('codex unarchive "' + thread + '"').then((result) => {
            if (result && result.code === 0) return;
            session.advisories = (Array.isArray(session.advisories) ? session.advisories : [])
              .concat([{ kind: 'archive', text: 'codex unarchive 未成功：' + oneLine(text(result && result.stderr) || '无输出', 160), at: now() }])
              .slice(-8);
          }).catch(() => {}).finally(() => {
            this.sessionEvent(session);
            this.save();
          });
        }
      }
    }
    this.touch(session);
    this.sessionEvent(session);
    return session;
  }

  async deleteSession(session) {
    await this.stop(session);
    const child = this.procs.get(session.id);
    if (child) {
      killTree(child);
      this.procs.delete(session.id);
    }
    try { rmSync(path.join(this.mcpDir, session.id + '.mcp.json'), { force: true }); } catch { /* ignore */ }
    if (session.provider === 'codex' && session.codexThreadId) {
      run('codex delete "' + session.codexThreadId + '"').catch(() => {});
    }
    this.sessions.delete(session.id);
    const set = this.streams.get(session.id);
    if (set) { for (const res of set) { try { res.end(); } catch { /* ignore */ } } this.streams.delete(session.id); }
    this.scheduleSave();
  }

  /* --------------------------------------------------------------- status */

  async detect(provider) {
    const command = provider + ' --version';
    const result = await run(command);
    const version = parseVersion(result.stdout) || parseVersion(result.stderr);
    const info = {
      id: provider,
      label: PROVIDERS[provider].label,
      installed: result.code === 0 && Boolean(version),
      version,
      error: result.code === 0 ? '' : oneLine(result.stderr || result.stdout, 200),
    };
    if (info.installed) info.compat = await this.cliCompat(provider);
    if (provider === 'codex' && info.installed) info.sandbox = await this.codexSandbox();
    return info;
  }

  /**
   * Probe the CLI's `--help` for the flags this workbench passes. Cached because
   * `--help` costs a few hundred milliseconds and rarely changes.
   */
  async cliCompat(provider) {
    const cached = this.compatCache.get(provider);
    if (cached && now() - cached.at < COMPAT_CACHE_MS) return cached.value;
    const spec = CLI_CAPABILITIES[provider];
    const main = await run(spec.help);
    const mainText = main.stdout + '\n' + main.stderr;
    const missing = spec.required.filter((item) => !mainText.includes(item.flag));
    let topText = '';
    if (spec.topHelp) {
      const top = await run(spec.topHelp);
      topText = top.stdout + '\n' + top.stderr;
    }
    const degraded = topText ? spec.optional.filter((item) => !topText.includes(item.flag)) : [];
    const value = {
      ok: main.code === 0 && missing.length === 0,
      checked: spec.required.length,
      missing: missing.map((item) => ({ flag: item.flag, use: item.use })),
      degraded: degraded.map((item) => ({ flag: item.flag, use: item.use })),
      probedAt: now(),
    };
    this.compatCache.set(provider, { at: now(), value });
    return value;
  }

  /**
   * Ask `codex doctor` which sandbox backend this machine resolves to. The plain
   * output carries a `sandbox backend  <name>` line; a `windows.sandbox` override
   * makes it print `<redacted>`, which still proves the key was honored.
   */
  async codexDoctorBackend(override) {
    const command = 'codex '
      + (override ? '-c windows.sandbox="' + override + '" ' : '')
      + 'doctor';
    const result = await run(command);
    const output = (result.stdout + '\n' + result.stderr).replace(/\u001b\[[0-9;]*m/g, '');
    const json = output.match(/"sandbox backend"\s*:\s*"([^"]*)"/i);
    const plain = output.match(/sandbox backend\s+(\S+)/i);
    const raw = json ? json[1] : plain ? plain[1] : '';
    return String(raw).trim().toLowerCase() || 'unknown';
  }

  /**
   * Whether this machine can actually run Codex's sandbox, and which
   * `-c windows.sandbox=...` override (if any) makes it work.
   *
   * Codex 0.170 resolves the Windows backend to `disabled` for non-interactive
   * `codex exec`, and a disabled backend refuses to start any child process — even
   * in read-only. Selecting `unelevated` restores a real restricted-token sandbox
   * without admin rights. The probe is per-machine, so an installation whose Codex
   * already has a working backend keeps using it untouched.
   */
  async codexSandbox() {
    if (this.codexSandboxCache && now() - this.codexSandboxCache.at < COMPAT_CACHE_MS) {
      return this.codexSandboxCache.value;
    }
    if (this.codexSandboxPromise) return this.codexSandboxPromise;
    this.codexSandboxPromise = this.probeCodexSandbox().finally(() => {
      this.codexSandboxPromise = null;
    });
    return this.codexSandboxPromise;
  }

  async probeCodexSandbox() {
    const windows = process.platform === 'win32';
    const preference = SANDBOX_BACKENDS.has(this.settings.codexSandboxBackend)
      ? this.settings.codexSandboxBackend : 'auto';
    let base = 'unknown';
    try {
      base = await this.codexDoctorBackend(null);
    } catch { /* doctor missing or crashed; keep unknown */ }

    // `auto` only overrides a disabled backend, and only with the tier that needs no
    // administrator rights. A machine whose Codex is already configured is left alone.
    let override = null;
    if (windows) {
      if (preference === 'elevated' || preference === 'unelevated') override = preference;
      else if (base === 'disabled') override = 'unelevated';
    }

    let effective = base;
    if (override) {
      try {
        effective = await this.codexDoctorBackend(override);
      } catch {
        effective = 'unknown';
      }
    }

    const healthy = (value) => Boolean(value) && value !== 'disabled' && value !== 'unknown';
    const usable = windows ? healthy(effective) : effective !== 'disabled';
    const applied = usable && override ? override : null;
    // `codex doctor` redacts the unelevated backend name; report what we actually
    // asked for instead of showing「<redacted>」in the UI.
    const backendLabel = usable
      ? (effective === '<redacted>' ? (applied || 'unelevated') : effective)
      : base;
    const value = {
      backend: backendLabel,
      baseBackend: base,
      requested: preference,
      override: applied,
      // A disabled backend also breaks read-only on Windows, because Codex refuses
      // to spawn commands at all when it cannot sandbox them.
      workspaceWriteUsable: windows ? usable : effective !== 'disabled',
      readOnlyUsable: windows ? usable : true,
      detail: '',
    };
    if (windows && !usable) {
      const tried = 'windows.sandbox="' + (override || 'unelevated') + '"';
      value.detail = '本机 Codex 沙箱后端不可用（codex doctor 报告 ' + base
        + '，尝试 ' + tried + ' 后仍未启用）。只读与工作区写入都无法真正执行命令；'
        + '请改用「完全访问」，或在 Codex 配置 / 系统策略里启用 Windows 沙箱。';
    } else if (applied === 'unelevated' && preference === 'auto') {
      value.detail = '本机默认沙箱后端为 disabled；工作台已自动追加 -c windows.sandbox="unelevated"，'
        + '「工作区写入」使用受限令牌沙箱（无需管理员）。';
    } else if (applied === 'elevated') {
      value.detail = '已按要求强制使用 elevated 沙箱：首次运行会走 Codex 的管理员授权流程，需要能弹 UAC。';
    } else if (applied === 'unelevated') {
      value.detail = '已按要求强制使用 unelevated 沙箱（受限令牌，无需管理员）。';
    }
    // Do not cache 'unknown': it usually means codex is not installed or doctor
    // crashed, and both can change without a restart.
    if (base !== 'unknown' || applied) this.codexSandboxCache = { at: now(), value };
    return value;
  }

  async status() {
    if (this.statusCache.value && now() - this.statusCache.at < 30000) {
      // 落盘状态是「当前态」，不能被 30 秒缓存冻住：每次都从实例上刷新。
      this.statusCache.value.storage.saveError = this.saveError || null;
      return this.statusCache.value;
    }
    const [claude, codex] = await Promise.all([this.detect('claude'), this.detect('codex')]);
    const working = this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('workingDirectory') : null;
    const value = {
      providers: { claude, codex },
      defaultCwd: (working && working.defaultDirectory) || process.cwd(),
      workspaces: this.workspaceList(),
      dataDir: this.dir,
      // 'profile' = 用了 <DSH_PROFILE_DIR>/cli-workbench；'home-fallback' = 用了 ~/.dsh/cli-workbench。
      // 两种启动方式不同时会指向不同目录，这个字段让「会话看起来没了」有据可查。
      dataDirSource: this.dataDirSource,
      // 最近一次 sessions.json 写盘失败的原因（成功时为 null）。写盘失败不会打断
      // 回合，但必须能查到——否则「改了没保住」只会表现为重启后数据回退。
      storage: { saveError: this.saveError || null },
    };
    this.statusCache = { at: now(), value };
    return value;
  }

  models() {
    const claude = { default: '', model: '', source: '', from: '', landed: '', alias: false, custom: [] };
    const codex = { default: '', model: '', source: '', from: '', landed: '', alias: false, custom: [] };
    const custom = this.normalizeCustomModels(this.settings && this.settings.customModels);
    claude.custom = custom.claude;
    codex.custom = custom.codex;
    try {
      const file = path.join(os.homedir(), '.claude', 'settings.json');
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (parsed && typeof parsed.model === 'string') {
          claude.model = parsed.model;
          claude.source = 'settings.model';
          claude.from = '~/.claude/settings.json 的 model';
        }
        if (parsed && parsed.env && typeof parsed.env.ANTHROPIC_MODEL === 'string') {
          claude.model = parsed.env.ANTHROPIC_MODEL;
          claude.source = 'env.ANTHROPIC_MODEL';
          claude.from = '~/.claude/settings.json 里 env.ANTHROPIC_MODEL';
        }
        if (claude.model) {
          claude.alias = this.isClaudeAlias(claude.model);
          claude.landed = claude.alias ? this.claudeAliasTarget(claude.model) : '';
        }
      }
    } catch { /* unreadable config */ }
    try {
      const file = path.join(os.homedir(), '.codex', 'config.toml');
      if (existsSync(file)) {
        const raw = readFileSync(file, 'utf8');
        const match = raw.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
        if (match) {
          codex.model = match[1];
          codex.source = 'model';
          codex.from = '~/.codex/config.toml 的 model';
        }
      }
    } catch { /* unreadable config */ }
    return { claude, codex };
  }

  /** Claude Code 的 `sonnet` / `opus` / `haiku` / `default` 是官方别名，不是具体型号。 */
  isClaudeAlias(alias) {
    return /^(sonnet|opus|haiku|default)$/i.test(text(alias).trim());
  }

  /**
   * Claude Code 的模型别名（sonnet / opus / haiku …）在 CLI 启动时才解析成具体型号，
   * 这里不做网络查询，只在 `~/.claude.json` 里找同一轮启动时 CLI 自己记下的
   * 具体型号（lastModelUsage），找不到就留空——绝不编造一个型号名。
   * @param {string} alias 配置里写的模型名
   * @returns {string} 具体型号，或空字符串
   */
  claudeAliasTarget(alias) {
    const name = text(alias).trim().toLowerCase();
    if (!this.isClaudeAlias(name)) return '';
    try {
      const file = path.join(os.homedir(), '.claude.json');
      if (!existsSync(file)) return '';
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      const buckets = [];
      if (parsed && parsed.lastModelUsage && typeof parsed.lastModelUsage === 'object') buckets.push(parsed.lastModelUsage);
      for (const project of Object.values(parsed && parsed.projects ? parsed.projects : {})) {
        if (project && project.lastModelUsage) buckets.push(project.lastModelUsage);
      }
      for (const bucket of buckets) {
        for (const key of Object.keys(bucket || {})) {
          if (key.toLowerCase().startsWith(name + '-') || key.toLowerCase().startsWith('claude-' + name)) return key;
        }
      }
    } catch { /* ignore */ }
    return '';
  }

  async updates(force) {
    if (!force && this.updateCache.value && now() - this.updateCache.at < 10 * 60 * 1000) {
      return this.updateCache.value;
    }
    const entries = {};
    for (const [id, meta] of Object.entries(PROVIDERS)) {
      // No quotes: cmd.exe's /d /s /c rewrites `"pkg"` into `""pkg""`, which npm
      // rejects as EINVALIDPACKAGENAME. Package names come from PROVIDERS, so the
      // string is fixed ASCII and never needs shell quoting.
      const result = await run('npm view ' + meta.pkg + ' version --json --loglevel=error');
      let latest = '';
      if (result.code === 0) {
        try {
          const parsed = JSON.parse(result.stdout.trim());
          latest = typeof parsed === 'string' ? parsed : Array.isArray(parsed) ? parsed[parsed.length - 1] : '';
        } catch {
          latest = parseVersion(result.stdout);
        }
      }
      entries[id] = { latest, checkedAt: now(), error: result.code === 0 ? '' : npmError(result) };
    }
    const value = { fetchedAt: now(), entries };
    this.updateCache = { at: now(), value };
    return value;
  }

  async upgrade(provider) {
    const result = await run('npm install -g ' + PROVIDERS[provider].pkg + '@latest --loglevel=error');
    if (result.code === 0) {
      // A new CLI release can change the flags and the sandbox backend, so the next
      // status request must probe again instead of reusing pre-upgrade answers.
      this.statusCache = { at: 0, value: null };
      this.updateCache = { at: 0, value: null };
      this.compatCache.clear();
      this.codexSandboxCache = null;
    }
    return {
      ok: result.code === 0,
      provider,
      output: result.code === 0 ? oneLine(result.stdout, 400) : npmError(result),
    };
  }

  /* --------------------------------------------------------------- streams */

  attachStream(session, req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    let set = this.streams.get(session.id);
    if (!set) { set = new Set(); this.streams.set(session.id, set); }
    set.add(res);
    res.write('data: ' + JSON.stringify(this.snapshot(session)) + '\n\n');
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* closed */ }
    }, 20000);
    const close = () => {
      clearInterval(heartbeat);
      const current = this.streams.get(session.id);
      if (current) {
        current.delete(res);
        if (current.size === 0) this.streams.delete(session.id);
      }
    };
    req.on('close', close);
    res.on('close', close);
    // 断连后 write 的失败是异步 error 事件；这个监听必须存在，否则就是 uncaughtException。
    res.on('error', close);
  }

  /* ------------------------------------------------------------ send/stop */

  /**
   * 扫本机两个 CLI 的技能目录。只在本地列清单、读完 frontmatter 就返回，不调任何
   * 网络接口，也不替 CLI 编造调用协议——点选后由客户端把说明插进输入框，发不发、
   * 怎么用，仍然按 CLI 自己的规矩来。
   * @param {string} cwd 当前会话的工作目录（用来找工作区级技能）
   * @returns {{skills: Array<object>, dirs: Array<object>}}
   */
  skills(cwd) {
    const home = os.homedir();
    const dir = realCwd(text(cwd || ''));
    const roots = [
      { provider: 'claude', scope: 'user', label: '~/.claude/skills', root: path.join(home, '.claude', 'skills') },
      { provider: 'codex', scope: 'user', label: '~/.codex/skills', root: path.join(home, '.codex', 'skills') },
      dir ? { provider: 'claude', scope: 'workspace', label: '.claude/skills', root: path.join(dir, '.claude', 'skills') } : null,
      dir ? { provider: 'codex', scope: 'workspace', label: '.codex/skills', root: path.join(dir, '.codex', 'skills') } : null,
    ].filter(Boolean);
    const seen = new Set();
    const skills = [];
    const dirs = [];
    for (const entry of roots) {
      const exists = existsSync(entry.root);
      const info = { provider: entry.provider, scope: entry.scope, label: entry.label, path: entry.root, exists, count: 0, truncated: false, error: '' };
      dirs.push(info);
      if (!exists) continue;
      let scanned;
      try {
        scanned = collectSkillFiles(entry.root, 2);
      } catch (error) {
        info.error = String(error && error.message || error);
        continue;
      }
      info.truncated = Boolean(scanned.truncated);
      for (const found of scanned.files) {
        const key = entry.provider + '|' + found.file.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        let meta = { name: '', description: '' };
        let size = 0;
        let readError = '';
        try {
          const raw = readFileSync(found.file, 'utf8');
          size = raw.length;
          meta = parseSkillFrontmatter(raw);
        } catch (error) {
          readError = String(error && error.message || error);
        }
        // 目录链接：告诉用户这个技能是链接进来的，以及链到哪
        let link = '';
        try { if (lstatSync(found.dir).isSymbolicLink()) link = realpathSync(found.dir); } catch { /* not a link */ }
        // Codex 自带技能放在 `.codex/skills/.system`，标出来别让用户以为是自己装的。
        // 判定必须只看**技能根目录下的第一层**：原来用 includes(sep + '.') 判断，
        // 而工作区技能本身就长在 `<cwd>\.claude\skills\...` 下，于是全被误标成内置。
        let builtin = false;
        if (entry.root) {
          const rel = path.relative(entry.root, found.dir);
          const top = rel && !rel.startsWith('..') ? rel.split(path.sep)[0] : '';
          builtin = Boolean(top) && top.startsWith('.');
        }
        info.count += 1;
        skills.push({
          provider: entry.provider,
          scope: entry.scope,
          name: meta.name || found.dirName,
          description: clipText(meta.description || '', 220),
          hasDescription: Boolean(meta.description),
          path: found.file,
          dir: found.dir,
          link,
          builtin,
          size,
          readError,
        });
      }
    }
    skills.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    return { skills, dirs };
  }

  /** 计划模式指令前缀：两个 CLI 都靠 prompt 驱动，不是开关。 */
  planPrefix(provider, title) {
    if (provider === 'codex') {
      return [
        '【计划模式】这一轮只做计划和调研，不要修改任何文件、不要执行会改变状态的命令。',
        '- 先读相关代码，再给出一份分步骤的实施计划：要改哪些文件、每步做什么、风险与回滚方式。',
        '- 结尾列出需要我确认的问题；我确认后再按计划执行。',
        title ? '任务：' + title : '',
      ].filter(Boolean).join('\n');
    }
    return '在动手之前先把方案讲清楚：列出一份分步骤计划（要改哪些文件、每步做什么、风险），等我确认后再执行；这一轮不要修改文件。';
  }

  /**
   * 点选技能时发出去的引用。不是「替 CLI 调用」，而是把技能说明和指令交给
   * Claude 的 Skill 工具 / Codex 的 skill 自己决定怎么用。
   */
  skillMessage(skill) {
    const provider = skill.provider === 'codex' ? 'codex' : 'claude';
    const intro = provider === 'codex'
      ? '请使用技能「' + skill.name + '」（Codex skill，位置：' + skill.path + '）来完成下面的任务：'
      : '请使用技能「' + skill.name + '」（Skill 位置：' + skill.path + '）来完成下面的任务：';
    return intro + '\n\n（技能说明：' + (skill.description || '见 SKILL.md') + '）';
  }

  /**
   * 把消息里的 `/技能名` 令牌就地展开成「使用技能 X + 位置 + 说明」。
   *
   * 这是照 DSH 的做法：客户端只落一个短令牌（渲染成技能卡片，输入框不被正文淹没），
   * 真正的正文在**发送时**由这一侧补上。只认按名字 / 路径能在本机找到的 SKILL.md，
   * 认不出来的 `/xxx` 原样保留（它可能只是路径或斜杠命令的一部分）。
   * @param {string} content 用户消息原文
   * @param {string} cwd 会话工作目录（用于工作区级技能）
   * @param {string} provider 会话绑定的助手：同名技能两个 CLI 都装了（比如
   *   `a-share-daily-review`），只能取**本会话这个 CLI 自己的那份**，否则 Codex 会被
   *   塞上一份 `~/.claude/skills/...` 的路径。
   */
  expandSkillTokens(content, cwd, provider) {
    const raw = String(content || '');
    // 技能目录名可能含点（如 my.skill）：原来的 [\w-]* 认不出，令牌会原样发给 CLI。
    const tokens = [...raw.matchAll(/(^|\s)\/([A-Za-z0-9][\w.-]*)(?=\s|$)/g)];
    if (!tokens.length) return raw;
    const mine = provider === 'codex' ? 'codex' : provider === 'claude' ? 'claude' : '';
    let catalog = null;
    const info = (skillRef) => {
      if (!catalog) {
        const all = this.skills(cwd).skills;
        // 先按本会话的 CLI 过滤；过滤后仍按名字取第一个
        catalog = mine ? all.filter(entry => entry.provider === mine) : all;
      }
      return catalog.find(entry => entry.name === skillRef) || null;
    };
    let out = '';
    let cursor = 0;
    for (const token of tokens) {
      const name = token[2];
      const skill = info(name);
      if (!skill) continue;
      const start = token.index + token[1].length;
      out += raw.slice(cursor, start) + '（' + this.skillMessage(skill).replace(/\n+/g, ' ') + '）';
      cursor = start + name.length + 1;
    }
    return out + raw.slice(cursor);
  }

  /** 校验客户端传回来的技能引用只能指向本地真实存在的 SKILL.md。 */
  resolveSkill(input) {
    const file = realCwd(text(input && input.path ? input.path : ''));
    if (!file || path.basename(file).toUpperCase() !== 'SKILL.MD' || !existsSync(file)) return null;
    const provider = input.provider === 'codex' ? 'codex' : 'claude';
    let name = text(input.name || '');
    let description = text(input.description || '');
    if (!name || !description) {
      try {
        const meta = parseSkillFrontmatter(readFileSync(file, 'utf8'));
        name = name || meta.name || path.basename(path.dirname(file));
        description = description || meta.description;
      } catch { /* ignore */ }
    }
    return { provider, name: name || path.basename(path.dirname(file)), description, path: file };
  }

  async send(session, content) {
    session.error = null;
    session.status = 'running';
    session._turnActive = true;
    session._turnStartedAt = now();
    session._turnPhase = 'spawn';
    session._turnSteps = 0;
    // 上一轮「停止」留下的强杀定时器必须作废，否则它会杀掉这一轮的新进程。
    if (session._interruptTimer) { clearTimeout(session._interruptTimer); session._interruptTimer = null; }
    session._turnTiming = { decodeMs: 0, ttftMs: null, blockStart: null };
    const title = session.title === '新会话' || !session.title;
    if (title) session.title = oneLine(content, 36);
    this.push(session, { id: idOf('user'), kind: 'user', text: content, at: now() });
    this.sessionEvent(session);
    if (session.provider === 'claude') {
      try {
        this.clearReap(session);
        const child = this.ensureClaude(session);
        // 同步那半：进程可能在上面的 ensureClaude 返回前后才退出，此时 write 会直接
        // 抛 ERR_STREAM_DESTROYED。先拦住，走回合失败而不是让异常冒到调用方。
        if (!child.stdin || child.stdin.destroyed || !child.stdin.writable || child.exitCode != null) {
          this.failTurn(session, '启动', 'CLI 进程已退出', '发消息时 claude 进程已结束，请重新发送。');
          return;
        }
        child.stdin.write(JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: content }] },
        }) + '\n');
      } catch (error) {
        this.failTurn(session, '启动', 'CLI 进程启动失败', String(error));
      }
      return;
    }
    // A codex turn may wait for the sandbox probe before spawning; tag it so a
    // stop-then-resend race cannot spawn the previous turn's process.
    const seq = session._turnSeq = (session._turnSeq || 0) + 1;
    this.startCodex(session, content, seq).catch((error) => {
      this.failTurn(session, '启动', '无法启动 codex', String(error));
    });
  }

  async stop(session) {
    this.cancelApprovals(session, '本轮已停止，审批取消。');
    const child = this.procs.get(session.id);
    if (session.provider === 'claude' && child && child.stdin.writable) {
      try {
        child.stdin.write(JSON.stringify({
          type: 'control_request', request_id: idOf('int'), request: { subtype: 'interrupt' },
        }) + '\n');
      } catch { /* fall through to kill */ }
      // 句柄挂在 session 上，下一条消息会取消它：否则「停止」后 2.5 秒内续发，
      // 这个定时器会把正在跑新回合的进程直接杀掉，新回合无辜报「进程异常退出」。
      clearTimeout(session._interruptTimer);
      session._interruptTimer = setTimeout(() => {
        session._interruptTimer = null;
        if (child.exitCode == null) {
          killTree(child);
          if (this.procs.get(session.id) === child) this.procs.delete(session.id);
        }
      }, 2500);
    } else if (child) {
      killTree(child);
      this.procs.delete(session.id);
    }
    if (session._turnActive) {
      session._turnActive = false;
      session._turnPhase = null;
      session.status = 'idle';
      this.push(session, { id: idOf('notice'), kind: 'notice', text: '已停止本轮执行。', at: now() });
      this.sessionEvent(session);
    } else {
      session.status = 'idle';
      this.sessionEvent(session);
    }
  }

  failTurn(session, phase, category, detail) {
    session._turnActive = false;
    session._turnPhase = null;
    session.status = 'error';
    session.error = { phase, category, detail: oneLine(detail, 600), at: now() };
    this.cancelApprovals(session, '本轮失败，审批取消。');
    this.push(session, {
      id: idOf('err'), kind: 'error', phase, category, detail: oneLine(detail, 600), at: now(),
    });
    this.sessionEvent(session);
  }

  /** Keep at most one idle CLI process per session: reap it after a quiet period. */
  scheduleReap(session) {
    if (session.provider !== 'claude') return;
    if (session._reapTimer) clearTimeout(session._reapTimer);
    session._reapTimer = setTimeout(() => {
      session._reapTimer = null;
      if (session._turnActive) return;
      const child = this.procs.get(session.id);
      if (child) {
        killTree(child);
        this.procs.delete(session.id);
      }
      // 最后一个热进程回收掉之后，如果确实没有活要保（没有事件流、没有待审批），
      // 立刻走一次空闲回收，不用再等满一个 30 分钟的周期。
      if (!this.hasLiveWork()) {
        if (this.unmountTimer !== null) { clearTimeout(this.unmountTimer); this.unmountTimer = null; }
        this.scheduleIdleUnmount();
      }
    }, 10 * 60 * 1000);
    // 这个定时器不该拖住宿主退出（与 unmountTimer 一致）
    if (session._reapTimer && typeof session._reapTimer.unref === 'function') session._reapTimer.unref();
  }

  clearReap(session) {
    if (session._reapTimer) {
      clearTimeout(session._reapTimer);
      session._reapTimer = null;
    }
  }

  /* ---------------------------------------------------------------- claude */

  ensureClaude(session) {
    const existing = this.procs.get(session.id);
    if (existing && existing.exitCode == null) return existing;
    const token = randomBytes(16).toString('hex');
    session._mcpToken = token;
    const configPath = path.join(this.mcpDir, session.id + '.mcp.json');
    const origin = this.ctx.webServer.getOrigin();
    const config = {
      mcpServers: {
        cliworkbench: {
          command: process.execPath,
          args: [MCP_SCRIPT],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            CLI_WB_ENDPOINT: origin + API + '/permission',
            CLI_WB_TOKEN: token,
            CLI_WB_SESSION: session.id,
          },
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const mode = PERMISSION_MODES.has(session.permissionMode) ? session.permissionMode : 'manual';
    const parts = [
      'claude -p',
      '--input-format stream-json',
      '--output-format stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode ' + mode,
      '--permission-prompts host',
      '--mcp-config ' + configPath,
      '--permission-prompt-tool mcp__cliworkbench__approval_prompt',
    ];
    if (session.claudeSessionId) parts.push('--resume ' + session.claudeSessionId);
    if (session.model) parts.push('--model ' + session.model.trim().split(/\s+/)[0]);
    const child = spawn('cmd.exe', ['/d', '/s', '/c', parts.join(' ')], {
      cwd: realCwd(session.cwd),
      windowsHide: true,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.procs.set(session.id, child);
    // 进程已拉起，接下来是 CLI 读上下文、请求模型——这段通常比 spawn 本身更久。
    session._turnPhase = 'waiting';
    session._sawText = false;
    session._sawThinking = false;
    session._openText = null;
    session._openThink = null;
    let buffer = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        try { this.handleClaude(session, event); } catch { /* one malformed event must not kill the turn */ }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on('error', (error) => {
      this.procs.delete(session.id);
      this.failTurn(session, '启动', '无法启动 claude', String(error));
    });
    // 进程在「写入瞬间」退出时，往 stdin 写会先同步抛错、再异步发出 EPIPE/EOF。
    // 异步那半没有监听就是 uncaughtException —— Host 跑在 DSH 宿主进程里，等于整个
    // 应用崩溃。兜住它，让它走正常的回合失败路径。
    child.stdin.on('error', (error) => {
      if (this.procs.get(session.id) === child) this.procs.delete(session.id);
      if (session._turnActive) {
        this.failTurn(session, '工具执行', 'CLI 进程已退出，消息未送达', String(error));
      }
    });
    child.on('close', (code) => {
      if (this.procs.get(session.id) === child) this.procs.delete(session.id);
      if (session._turnActive) {
        const detail = stderr.trim() || ('claude 进程退出，退出码 ' + code);
        this.failTurn(session, '工具执行', '进程异常退出（code ' + code + '）', detail);
      }
    });
    return child;
  }

  handleClaude(session, event) {
    const type = event.type;
    if (type === 'system') {
      if (event.subtype === 'init') {
        session.claudeSessionId = event.session_id || session.claudeSessionId;
        if (event.model && !session.model) session.model = event.model;
        this.sessionEvent(session);
        this.scheduleSave();
      } else if (event.subtype === 'thinking_tokens') {
        // 这个计数据历史遗留，两端都没有人读；留着一个每事件广播的活字段只会误导。
      } else if (event.subtype === 'error') {
        this.push(session, {
          id: idOf('err'), kind: 'error', phase: 'CLI', category: 'CLI 报告错误',
          detail: text(event.error || event.message), at: now(),
        });
      }
      return;
    }
    if (type === 'stream_event') {
      this.handleStreamEvent(session, event.event || {});
      return;
    }
    if (type === 'assistant') {
      const message = event.message || {};
      if (message.model) session.model = message.model;
      const blocks = Array.isArray(message.content) ? message.content : [];
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          const openId = session._textIds && session._textIds.shift();
          if (openId) {
            this.patch(session, openId, { text: block.text, streaming: false });
          } else {
            this.push(session, {
              id: idOf('asst'), kind: 'assistant', text: block.text, at: now(), streaming: false,
            });
          }
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          const duration = Number(event.thinking_duration_ms) || 0;
          const openId = session._thinkIds && session._thinkIds.shift();
          if (openId) {
            this.patch(session, openId, { text: block.thinking, streaming: false, durationMs: duration });
          } else {
            this.push(session, {
              id: idOf('think'), kind: 'thinking', text: block.thinking, durationMs: duration,
              at: now(), streaming: false,
            });
          }
        } else if (block.type === 'tool_use') {
          const item = {
            id: idOf('tool'),
            kind: 'tool',
            toolId: block.id,
            name: block.name || 'Tool',
            input: block.input && typeof block.input === 'object' ? block.input : {},
            target: toolTarget(block.name, block.input),
            category: toolCategory(block.name),
            verb: toolVerb(block.name),
            status: 'running',
            startedAt: now(),
            at: now(),
            diff: diffOf(block.name, block.input),
            output: '',
            isError: false,
          };
          this.push(session, item);
          session._toolSteps = (Number(session._toolSteps) || 0) + 1;
          if (item.diff && item.diff.path) this.noteFile(session, item.diff);
        }
      }
      return;
    }
    if (type === 'user') {
      const content = event.message && event.message.content;
      const metas = Array.isArray(event.tool_result_meta) ? event.tool_result_meta : [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || block.type !== 'tool_result') continue;
          const target = [...session.items].reverse().find((item) => item.kind === 'tool' && item.toolId === block.tool_use_id);
          if (!target) continue;
          const meta = metas.find((entry) => entry && entry.id === block.tool_use_id) || metas[0] || null;
          const decision = meta && meta.permission_decision ? meta.permission_decision : null;
          this.patch(session, target.id, {
            status: block.is_error ? 'error' : 'done',
            isError: Boolean(block.is_error),
            output: contentToText(block.content),
            endedAt: now(),
            decision: decision ? { decision: decision.decision, source: decision.source, reason: decision.reason_type || '' } : null,
          });
        }
      }
      return;
    }
    if (type === 'result') {
      const usage = event.usage || {};
      const modelUsage = event.modelUsage || {};
      const modelKey = Object.keys(modelUsage)[0] || session.model;
      const contextWindow = modelKey && modelUsage[modelKey] ? Number(modelUsage[modelKey].contextWindow) || 0 : 0;
      const turn = session._turnTiming || null;
      session.usage = {
        input: Number(usage.input_tokens) || 0,
        output: Number(usage.output_tokens) || 0,
        cacheRead: Number(usage.cache_read_input_tokens) || 0,
        thinking: Number(usage.output_tokens_details && usage.output_tokens_details.thinking_tokens) || 0,
        costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null,
        durationMs: Number(event.duration_ms) || 0,
        contextWindow,
        contextUsed: (Number(usage.input_tokens) || 0) + (Number(usage.cache_read_input_tokens) || 0),
        model: modelKey || session.model,
        // Real decode wall time and first-token latency, measured from the stream
        // itself: tokens/second is only shown when this exists, never guessed.
        decodeMs: turn ? Math.round(turn.decodeMs) : 0,
        ttftMs: turn && turn.ttftMs != null ? Math.round(turn.ttftMs) : null,
        // 本轮序号 = 已完成的轮数 + 1（原来的写法在自增之前取值，第二轮起永远少 1）
        turns: (Number(session._turns) || 0) + 1,
        steps: Number(session._turnSteps) || 0,
      };
      session._turnActive = false;
      session._turnPhase = null;
      session.status = 'idle';
      session._turns = (Number(session._turns) || 0) + 1;
      this.cancelApprovals(session, '本轮已结束，未处理的审批已取消。');
      this.patchOpenStreaming(session);
      this.sessionEvent(session);
      this.scheduleReap(session);
      this.emit(session, { type: 'turn-end' });
      return;
    }
    if (type === 'control_request') {
      return;
    }
  }

  patchOpenStreaming(session) {
    if (session._openText) this.patch(session, session._openText, { streaming: false });
    if (session._openThink) this.patch(session, session._openThink, { streaming: false });
    session._openText = null;
    session._openThink = null;
  }

  handleStreamEvent(session, streamEvent) {
    const type = streamEvent.type;
    // Decode timing: accumulate only the spans where the model is actually
    // emitting (thinking + text blocks), so tokens/second excludes tool waits.
    if (!session._turnTiming) session._turnTiming = { decodeMs: 0, ttftMs: null, blockStart: null };
    const timing = session._turnTiming;
    if (type === 'message_start') {
      session._sawText = false;
      session._sawThinking = false;
      session._openText = null;
      session._openThink = null;
      session._textIds = [];
      session._thinkIds = [];
      // No TTFT: the CLI buffers message_start and the first content block into the
      // same tick, so any figure derived from them would be a fake 0ms.
      return;
    }
    if (type === 'content_block_start') {
      const block = streamEvent.content_block || {};
      timing.blockStart = Date.now();
      if (block.type === 'text') {
        session._sawText = true;
        const item = {
          id: idOf('asst'), kind: 'assistant', text: '', at: now(), streaming: true,
        };
        session._openText = item.id;
        session._textIds.push(item.id);
        this.push(session, item);
      } else if (block.type === 'thinking') {
        session._sawThinking = true;
        const item = {
          id: idOf('think'), kind: 'thinking', text: '', at: now(), streaming: true, durationMs: 0,
        };
        session._openThink = item.id;
        session._thinkIds.push(item.id);
        this.push(session, item);
      }
      return;
    }
    if (type === 'content_block_delta') {
      const delta = streamEvent.delta || {};
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        if (!session._openText) {
          const item = { id: idOf('asst'), kind: 'assistant', text: '', at: now(), streaming: true };
          session._openText = item.id;
          this.push(session, item);
        }
        const item = session.items.find((entry) => entry.id === session._openText);
        if (item) { item.text += delta.text; this.touch(session); }
        this.queueDelta(session, session._openText, delta.text);
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        if (!session._openThink) {
          const item = { id: idOf('think'), kind: 'thinking', text: '', at: now(), streaming: true, durationMs: 0 };
          session._openThink = item.id;
          this.push(session, item);
        }
        const item = session.items.find((entry) => entry.id === session._openThink);
        if (item) { item.text += delta.thinking; this.touch(session); }
        this.queueDelta(session, session._openThink, delta.thinking);
      }
      return;
    }
    if (type === 'content_block_stop') {
      if (timing.blockStart != null) {
        timing.decodeMs += Math.max(0, Date.now() - timing.blockStart);
        timing.blockStart = null;
      }
      if (session._openText) {
        this.patch(session, session._openText, { streaming: false });
        session._openText = null;
      }
      if (session._openThink) {
        const item = session.items.find((entry) => entry.id === session._openThink);
        const duration = item ? now() - (item.at || now()) : 0;
        this.patch(session, session._openThink, { streaming: false, durationMs: duration });
        session._openThink = null;
      }
    }
  }

  noteFile(session, diff) {
    const existing = session.files.find((file) => file.path === diff.path);
    if (existing) {
      existing.added += diff.added;
      existing.removed += diff.removed;
      existing.at = now();
    } else {
      session.files.push({ path: diff.path, added: diff.added, removed: diff.removed, at: now() });
    }
    if (session.files.length > 80) session.files.splice(0, session.files.length - 80);
    this.sessionEvent(session);
  }

  /* ----------------------------------------------------------------- codex */

  async startCodex(session, content, seq) {
    const thread = session.codexThreadId;
    const sandbox = SANDBOX_MODES.has(session.sandboxMode) ? session.sandboxMode : 'workspace-write';
    // Codex 0.170 defaults the Windows backend to `disabled`, which makes every
    // sandboxed tier refuse to start commands. The probe decides whether a
    // `-c windows.sandbox="..."` override is needed on this machine.
    let backendOverride = null;
    if (sandbox !== 'bypass') {
      const state = await this.codexSandbox().catch(() => null);
      backendOverride = state && state.override ? state.override : null;
    }
    if (!session._turnActive || seq !== session._turnSeq) return; // stopped or superseded meanwhile
    const parts = [];
    if (thread) {
      parts.push('codex exec resume ' + thread);
    } else {
      parts.push('codex exec');
    }
    parts.push('--json', '--skip-git-repo-check');
    if (!thread) parts.push('--color never');
    // `codex exec` is non-interactive: it has no channel to ask the user, so pin the
    // approval policy. Otherwise a user config with on-request would hang forever.
    parts.push('-c approval_policy="never"');
    if (backendOverride) parts.push('-c windows.sandbox="' + backendOverride + '"');
    if (sandbox === 'bypass') {
      // The UI label is Codex's own「完全访问」= danger-full-access, not the blunter
      // --dangerously-bypass flag: keep the sandbox wrapper, drop its restrictions.
      parts.push(thread ? '-c sandbox_mode="danger-full-access"' : '--sandbox danger-full-access');
    } else if (thread) {
      parts.push('-c sandbox_mode=' + sandbox);
    } else {
      parts.push('--sandbox ' + sandbox);
    }
    if (session.model) parts.push('--model ' + session.model.trim().split(/\s+/)[0]);
    parts.push('-');
    const child = spawn('cmd.exe', ['/d', '/s', '/c', parts.join(' ')], {
      cwd: realCwd(session.cwd),
      windowsHide: true,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.procs.set(session.id, child);
    session._turnPhase = 'waiting';
    session._codexTurn = { completed: false, started: now() };
    let buffer = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        try { this.handleCodex(session, event); } catch { /* ignore */ }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on('error', (error) => {
      this.procs.delete(session.id);
      this.failTurn(session, '启动', '无法启动 codex', String(error));
    });
    child.on('close', (code) => {
      if (this.procs.get(session.id) === child) this.procs.delete(session.id);
      if (session._turnActive && seq === session._turnSeq) {
        const sandboxHint = /CreateProcessAsUserW|CreateProcessWithLogonW|sandbox backend|blocked by policy/i.test(stderr)
          ? '\n\n提示：这类错误通常来自 Codex 的 Windows 沙箱后端未能启动。工作台会自动探测并追加 '
            + '-c windows.sandbox="unelevated"；如果仍失败，请改用「完全访问」，或在 Codex 配置 / 系统策略里启用沙箱。'
          : '';
        const detail = (stderr.trim() || ('codex 进程退出，退出码 ' + code)) + sandboxHint;
        this.failTurn(session, '工具执行', '进程异常退出（code ' + code + '）', detail);
      }
    });
    try {
      child.stdin.end(content);
    } catch (error) {
      this.failTurn(session, '输入', '无法写入 codex 输入', String(error));
    }
  }

  /**
   * Codex 的上下文窗口只出现在它自己的 rollout 记录里。
   *
   * `codex exec --json` 的 stdout 事件（thread.started / item.* / turn.completed）
   * 只给 token 数，没有窗口大小；但 Codex 自己会把每一轮追加进
   * `~/.codex/sessions/年/月/日/rollout-<时间>-<thread_id>.jsonl`，其中的
   * `task_started` / `token_count` 事件带 `model_context_window`。
   * 这里只读这份 CLI 自己写下的记录——没有就返回 null，绝不用模型名去猜窗口。
   *
   * @param {string} threadId Codex 会话 id（thread.started 事件里给的）
   * @returns {{contextWindow:number, contextUsed:number}|null}
   */
  codexRolloutContext(threadId) {
    const id = String(threadId || '').trim();
    if (!id) return null;
    const home = process.env.USERPROFILE || process.env.HOME || '';
    if (!home) return null;
    const root = path.join(home, '.codex', 'sessions');
    // Rollout 目录按日期分层：只翻今天和昨天，不做全盘扫描。
    const days = [];
    for (let offset = 0; offset < 2; offset += 1) {
      const day = new Date(Date.now() - offset * 86400000);
      const month = String(day.getMonth() + 1).padStart(2, '0');
      const date = String(day.getDate()).padStart(2, '0');
      days.push(path.join(root, String(day.getFullYear()), month, date));
    }
    for (const dir of days) {
      let names = [];
      try { names = readdirSync(dir); } catch { continue; }
      const hit = names.filter((name) => name.startsWith('rollout-') && name.endsWith('-' + id + '.jsonl'));
      if (!hit.length) continue;
      let body = '';
      try { body = readFileSync(path.join(dir, hit[hit.length - 1]), 'utf8'); } catch { return null; }
      const lines = body.split(/\r?\n/);
      // 从后往前找：最后一个带窗口大小的 token_count 就是当前占用。
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (!lines[index] || lines[index].indexOf('model_context_window') < 0) continue;
        let entry = null;
        try { entry = JSON.parse(lines[index]); } catch { continue; }
        const payload = entry && entry.payload ? entry.payload : {};
        const info = payload.info && typeof payload.info === 'object' ? payload.info : {};
        const window = Number(info.model_context_window) || Number(payload.model_context_window) || 0;
        if (!window) continue;
        const last = info.last_token_usage && typeof info.last_token_usage === 'object' ? info.last_token_usage : null;
        // 上下文占用看最后一次请求的输入侧 token（Codex 的 input_tokens 已含缓存命中部分）。
        const used = last ? (Number(last.input_tokens) || 0) : 0;
        return { contextWindow: window, contextUsed: used };
      }
      return null;
    }
    return null;
  }

  handleCodex(session, event) {
    const type = event.type;
    if (type === 'thread.started') {
      session.codexThreadId = event.thread_id || session.codexThreadId;
      this.sessionEvent(session);
      this.scheduleSave();
      return;
    }
    if (type === 'turn.started') return;
    if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
      this.handleCodexItem(session, event.item || {}, type === 'item.completed');
      return;
    }
    if (type === 'turn.completed') {
      const usage = event.usage || {};
      const context = this.codexRolloutContext(session.codexThreadId);
      session.usage = {
        input: Number(usage.input_tokens) || 0,
        output: Number(usage.output_tokens) || 0,
        cacheRead: Number(usage.cached_input_tokens) || 0,
        cacheWrite: Number(usage.cache_write_input_tokens) || 0,
        thinking: Number(usage.reasoning_output_tokens) || 0,
        costUsd: null,
        durationMs: session._codexTurn ? now() - session._codexTurn.started : 0,
        contextWindow: context ? context.contextWindow : 0,
        contextUsed: context ? context.contextUsed : 0,
        model: session.model,
        // Codex exec reports no per-step decode timing, so tokens/second stays
        // absent rather than being derived from wall time that includes tools.
        decodeMs: 0,
        ttftMs: null,
        turns: (Number(session._codexTurns) || 0) + 1,
        steps: Number(session._turnSteps) || 0,
      };
      session._turnActive = false;
      session._turnPhase = null;
      session.status = 'idle';
      session._codexTurns = (Number(session._codexTurns) || 0) + 1;
      this.sessionEvent(session);
      this.emit(session, { type: 'turn-end' });
      // rollout 文件是 CLI 边跑边写的：偶尔比 turn.completed 晚几毫秒落地。
      // 这一次没读到窗口就再补一次读取（读到就补播一次会话快照，不轮询）。
      if (!context && session.codexThreadId) {
        const key = session.codexThreadId;
        const timer = setTimeout(() => {
          if (session.codexThreadId !== key || !session.usage) return;
          if (Number(session.usage.contextWindow) > 0) return;
          const late = this.codexRolloutContext(key);
          if (!late) return;
          session.usage.contextWindow = late.contextWindow;
          session.usage.contextUsed = late.contextUsed;
          this.sessionEvent(session);
        }, 1200);
        if (timer && typeof timer.unref === 'function') timer.unref();
      }
      return;
    }
    if (type === 'turn.failed') {
      this.failTurn(session, '工具执行', 'Codex 执行失败', text(event.error && event.error.message || event.message));
      return;
    }
    if (type === 'error') {
      this.push(session, { id: idOf('err'), kind: 'error', phase: 'CLI', category: 'Codex 报告错误', detail: text(event.message), at: now() });
    }
  }

  handleCodexItem(session, item, completed) {
    const id = text(item.id) || idOf('codexitem');
    const kind = text(item.type);
    const existing = session.items.find((entry) => entry.id === 'codex-' + id);
    if (kind === 'reasoning') {
      if (!completed || existing) return;
      this.push(session, { id: 'codex-' + id, kind: 'thinking', text: text(item.text), at: now(), durationMs: 0, streaming: false });
      return;
    }
    if (kind === 'agent_message') {
      if (!completed) return;
      this.push(session, { id: 'codex-' + id, kind: 'assistant', text: text(item.text), at: now(), streaming: false });
      return;
    }
    if (kind === 'command_execution') {
      if (!existing) {
        this.push(session, {
          id: 'codex-' + id,
          kind: 'tool',
          toolId: id,
          name: 'Bash',
          input: { command: item.command },
          target: oneLine(item.command, 200),
          category: 'terminal',
          verb: '命令',
          status: item.status === 'completed' ? (item.exit_code === 0 ? 'done' : 'error') : 'running',
          startedAt: now(),
          at: now(),
          output: text(item.aggregated_output),
          isError: typeof item.exit_code === 'number' && item.exit_code !== 0,
          exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
          audit: true,
          diff: null,
          decision: null,
        });
        session._toolSteps = (Number(session._toolSteps) || 0) + 1;
      }
      if (completed || item.status === 'completed') {
        this.patch(session, 'codex-' + id, {
          status: item.exit_code === 0 ? 'done' : 'error',
          output: text(item.aggregated_output),
          isError: typeof item.exit_code === 'number' && item.exit_code !== 0,
          exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
          endedAt: now(),
        });
      } else {
        this.patch(session, 'codex-' + id, { output: text(item.aggregated_output) });
      }
      return;
    }
    if (kind === 'file_change') {
      if (!completed) return;
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes.map((change) => text(change.path)).filter(Boolean);
      for (const change of changes) {
        const filePath = text(change.path);
        if (!filePath) continue;
        // Codex 的 file_change 只说「这个文件变了」，不给增删行数。
        // 原来按 kind 编了个 +1，删除还会被记成 +1 新增、removed 永远是 0。
        // 这里只如实记录变化种类，不编造行数（界面上只用文件数，不展示 ±N）。
        const kind = text(change.kind) || 'update';
        const existingFile = session.files.find((file) => file.path === filePath);
        if (existingFile) { existingFile.kind = kind; existingFile.at = now(); }
        else session.files.push({ path: filePath, kind, at: now() });
      }
      this.push(session, {
        id: 'codex-' + id, kind: 'filechange', files: paths, status: item.status === 'completed' ? 'done' : 'running',
        at: now(), completed: true,
      });
      this.sessionEvent(session);
      return;
    }
    if (kind === 'mcp_tool_call') {
      /* 失败时 Codex 把正文放在 item.error 里，result 是空的。以前只记了
         `isError: Boolean(item.error)`，等于把「为什么失败」丢掉了——界面上那张卡
         展开后只剩「没有更多诊断信息」。现在把 error.message / error 原文一起收。 */
      const failure = codexFailureText(item.error);
      if (!existing) {
        this.push(session, {
          id: 'codex-' + id, kind: 'tool', toolId: id, name: text(item.tool) || 'MCP',
          input: item.arguments || {}, target: oneLine(item.tool, 120), category: 'wrench', verb: '工具',
          status: item.status === 'completed' ? (failure ? 'error' : 'done') : 'running',
          startedAt: now(), at: now(),
          output: contentToText(item.result),
          errorText: failure,
          isError: Boolean(failure), audit: true, diff: null, decision: null,
        });
      } else if (completed) {
        this.patch(session, 'codex-' + id, {
          status: failure ? 'error' : 'done',
          output: contentToText(item.result) || (existing ? existing.output : ''),
          errorText: failure || (existing ? existing.errorText : ''),
          isError: Boolean(failure), endedAt: now(),
        });
      }
      return;
    }
    if (kind === 'error') {
      /* CLI 自己关于「实验性功能未启用完」之类的警告，不是这一轮失败了。
         它每轮都会出现，塞进对话里就变成一条红色错误卡，看起来像任务挂了。
         这类提示挪进右栏「运行提示」，会话状态不受影响。 */
      const message = text(item.message);
      if (isAdvisoryMessage(message)) {
        session.advisories = [...(Array.isArray(session.advisories) ? session.advisories : []), { text: clipText(message, 400), at: now() }].slice(-8);
        this.sessionEvent(session);
        return;
      }
      this.push(session, { id: idOf('err'), kind: 'error', phase: '工具执行', category: 'Codex 报告错误', detail: message, at: now() });
    }
  }

  /* ------------------------------------------------------------ approvals */

  /**
   * CLI 侧取消了某个工具调用（notifications/cancelled）时，把对应的审批一并作废。
   * 不做这件事，用户会看到一张已经没有意义的审批卡，并且要等满 APPROVAL_TIMEOUT
   * （5 分钟）才被自动拒绝，期间队列里后面的审批也轮不到。
   */
  cancelPermission(req, res, body) {
    const session = this.session(text(body.sessionId));
    if (!session) return json(res, 404, { ok: false });
    const token = req.headers['x-cli-wb-token'];
    if (session._mcpToken && token !== session._mcpToken) {
      return json(res, 403, { ok: false, error: '审批令牌无效' });
    }
    const toolUseId = text(body.toolUseId);
    const candidates = [session.pending, ...session.pendingQueue].filter(Boolean);
    const found = toolUseId
      ? candidates.find((entry) => entry.toolUseId === toolUseId)
      : candidates[0];
    if (!found) return json(res, 200, { ok: false, reason: 'no pending approval' });
    const entry = this.approvals.get(found.requestId);
    if (entry) {
      clearTimeout(entry.timer);
      this.approvals.delete(found.requestId);
      entry.resolve({ behavior: 'deny', message: 'CLI 已取消这次工具调用，审批作废。' });
    }
    this.removePending(session, found.requestId);
    return json(res, 200, { ok: true });
  }

  async handlePermission(req, res, body) {
    const session = this.session(text(body.sessionId));
    if (!session) return json(res, 404, { behavior: 'deny', message: '会话不存在。' });
    const token = req.headers['x-cli-wb-token'];
    if (session._mcpToken && token !== session._mcpToken) {
      return json(res, 403, { behavior: 'deny', message: '审批令牌无效。' });
    }
    const toolName = text(body.toolName) || 'Tool';
    if (session.allowedTools.includes(toolName)) {
      this.push(session, {
        id: idOf('notice'), kind: 'notice',
        text: '本会话已允许 ' + toolName + '，这次未再询问。', at: now(),
      });
      return json(res, 200, { behavior: 'allow', updatedInput: body.input || {} });
    }
    const pending = {
      requestId: idOf('ap'),
      toolName,
      input: body.input && typeof body.input === 'object' ? body.input : {},
      toolUseId: text(body.toolUseId),
      createdAt: now(),
      expiresAt: now() + APPROVAL_TIMEOUT,
      impact: humanImpact(toolName, body.input || {}),
    };
    session.pendingQueue.push(pending);
    if (!session.pending) {
      session.pending = session.pendingQueue.shift();
      session.status = 'waiting';
      this.sessionEvent(session);
      this.emit(session, { type: 'approval', pending: session.pending, pendingCount: session.pendingQueue.length + (session.pending ? 1 : 0) });
    }
    const decision = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.approvals.delete(pending.requestId);
        this.removePending(session, pending.requestId);
        this.push(session, { id: idOf('notice'), kind: 'notice', text: '审批超时，已自动拒绝：' + toolName, at: now() });
        resolve({ behavior: 'deny', message: '审批超时，已自动拒绝。' });
      }, APPROVAL_TIMEOUT);
      this.approvals.set(pending.requestId, {
        resolve, timer, sessionId: session.id, toolName, input: pending.input,
      });
    });
    return json(res, 200, decision);
  }

  removePending(session, requestId) {
    session.pendingQueue = session.pendingQueue.filter((entry) => entry.requestId !== requestId);
    if (session.pending && session.pending.requestId === requestId) {
      session.pending = session.pendingQueue.shift() || null;
    }
    if (!session.pending && session.status === 'waiting') {
      session.status = session._turnActive ? 'running' : 'idle';
    }
    this.sessionEvent(session);
    this.emit(session, { type: 'approval', pending: session.pending });
  }

  resolveApproval(session, requestId, decision, reason) {
    const entry = this.approvals.get(requestId);
    if (!entry) return false;
    const pending = session.pending && session.pending.requestId === requestId
      ? session.pending
      : session.pendingQueue.find((item) => item.requestId === requestId) || null;
    clearTimeout(entry.timer);
    this.approvals.delete(requestId);
    this.removePending(session, requestId);
    if (decision === 'deny') {
      entry.resolve({ behavior: 'deny', message: reason || '用户拒绝了这次工具调用。' });
      return true;
    }
    if (decision === 'always') {
      const toolName = entry.toolName || (pending && pending.toolName) || '';
      if (toolName && !session.allowedTools.includes(toolName)) {
        session.allowedTools.push(toolName);
        this.scheduleSave();
      }
    }
    entry.resolve({ behavior: 'allow', updatedInput: (pending && pending.input) || entry.input || {} });
    return true;
  }

  cancelApprovals(session, message) {
    let touched = false;
    for (const [requestId, entry] of [...this.approvals.entries()]) {
      if (entry.sessionId !== session.id) continue;
      clearTimeout(entry.timer);
      this.approvals.delete(requestId);
      try { entry.resolve({ behavior: 'deny', message }); } catch { /* already settled */ }
      touched = true;
    }
    if (session.pending || session.pendingQueue.length) {
      session.pending = null;
      session.pendingQueue = [];
      touched = true;
    }
    if (touched) this.emit(session, { type: 'approval', pending: null, pendingCount: session.pendingQueue.length });
  }

  /* ----------------------------------------------------------------- files */

  safePath(session, input) {
    const raw = text(input);
    if (!raw) return null;
    const root = path.resolve(session.cwd);
    // 界面里传过来的常常是相对路径（文件树里的 relative），按会话工作目录解析
    const base = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
    /* Windows 上同一目录可能有 8.3 短路径（ADMINI~1）与长路径两种写法，
       也可能差一个大小写；比较之前先把两边都归一化。 */
    const norm = (value) => {
      let out = path.resolve(value).toLowerCase();
      try { out = realpathSync.native ? realpathSync.native(value).toLowerCase() : realpathSync(value).toLowerCase(); } catch { /* 文件可能还不存在 */ }
      return out;
    };
    const rootNorm = norm(root);
    const baseNorm = norm(base);
    if (baseNorm === rootNorm) return base;
    if (baseNorm.startsWith(rootNorm + path.sep)) return base;
    return null;
  }

  /** /preview 没带 session 时的兜底边界：目标必须落在某个已注册工作区目录内。 */
  withinAnyWorkspace(input) {
    const raw = text(input);
    if (!raw) return false;
    let target;
    try { target = realpathSync.native ? realpathSync.native(raw) : realpathSync(raw); } catch { return false; }
    const lower = target.toLowerCase();
    for (const entry of this.workspaces.values()) {
      const root = String(entry.cwd || '');
      if (!root) continue;
      let rootReal;
      try { rootReal = realpathSync.native ? realpathSync.native(root) : realpathSync(root); } catch { rootReal = path.resolve(root); }
      const rootLower = rootReal.toLowerCase();
      if (lower === rootLower || lower.startsWith(rootLower + path.sep)) return true;
    }
    return false;
  }

  tree(session, root, depth) {
    const entries = [];
    const maxDepth = Math.min(Math.max(depth, 1), 4);
    const limit = 400;
    const walk = (dir, level) => {
      if (entries.length >= limit) return;
      let children;
      try { children = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      children.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      for (const child of children) {
        if (entries.length >= limit) return;
        if (child.name.startsWith('.git') || SKIP_DIRS.has(child.name)) continue;
        const full = path.join(dir, child.name);
        const relative = path.relative(session.cwd, full);
        const isNew = session.files.some((file) => path.resolve(file.path) === path.resolve(full));
        entries.push({
          name: child.name,
          path: full,
          relative,
          depth: level,
          type: child.isDirectory() ? 'dir' : 'file',
          isNew,
        });
        if (child.isDirectory() && level < maxDepth) walk(full, level + 1);
      }
    };
    walk(root, 0);
    return {
      root,
      rootName: path.basename(root) || root,
      entries,
      newCount: session.files.length,
      memory: {
        claude: existsSync(path.join(session.cwd, 'CLAUDE.md')),
        agents: existsSync(path.join(session.cwd, 'AGENTS.md')),
      },
      rules: this.rulesFiles(session.cwd, session.provider),
    };
  }

  /* ------------------------------------------------------------- rules */

  /**
   * 项目指令文件的位置。两个 CLI 都读「就近的、同名的那一份」：
   * Claude 读 CLAUDE.md，Codex 读 AGENTS.md；用户级放在各自的配置目录里。
   * 这里只如实列出各自的路径与是否存在，不猜优先级。
   * @param {string} cwd 工作目录
   */
  rulesFiles(cwd, provider) {
    const home = os.homedir();
    const dir = realCwd(text(cwd || ''));
    const only = provider === 'claude' || provider === 'codex' ? provider : '';
    /* CLAUDE.md 只给 Claude 读、AGENTS.md 只给 Codex 读——界面上也跟着当前助手走，
       不把另一个 CLI 的文件摆在这个会话里当噪音。 */
    const all = [
      dir ? { id: 'ws-claude', provider: 'claude', scope: 'workspace', label: 'CLAUDE.md', file: path.join(dir, 'CLAUDE.md') } : null,
      dir ? { id: 'ws-agents', provider: 'codex', scope: 'workspace', label: 'AGENTS.md', file: path.join(dir, 'AGENTS.md') } : null,
      { id: 'user-claude', provider: 'claude', scope: 'user', label: '~/.claude/CLAUDE.md', file: path.join(home, '.claude', 'CLAUDE.md') },
      { id: 'user-agents', provider: 'codex', scope: 'user', label: '~/.codex/AGENTS.md', file: path.join(home, '.codex', 'AGENTS.md') },
    ].filter(Boolean);
    const list = only ? all.filter((entry) => entry.provider === only) : all;
    return list.map((entry) => {
      let exists = false;
      let size = 0;
      let modifiedAt = 0;
      let preview = '';
      try {
        const stat = statSync(entry.file);
        exists = stat.isFile();
        size = stat.size;
        modifiedAt = stat.mtimeMs;
        if (exists) preview = readFileSync(entry.file, 'utf8').slice(0, 20000);
      } catch { /* missing or unreadable: report as absent */ }
      return { ...entry, exists, size, modifiedAt, preview };
    });
  }

  /**
   * 写项目指令文件。只允许写 rulesFiles() 列出的四个位置——这既是安全边界，
   * 也避免用户从界面里顺手改坏别处的文件。内容原样写入，不做任何「自动改写」：
   * 插件不替用户和他的 CLI 编造语气，只做一个方便的写入入口。
   */
  async writeRules(body) {
    const id = text(body && body.id || '');
    const found = this.rulesFiles(body && body.cwd).find((entry) => entry.id === id);
    if (!found) return { ok: false, error: '未知的指令文件：' + id };
    const content = String(body && body.content != null ? body.content : '');
    if (content.length > 200000) return { ok: false, error: '内容超过 20 万字符，请拆开写' };
    try {
      mkdirSync(path.dirname(found.file), { recursive: true });
      writeFileSync(found.file, content, 'utf8');
    } catch (error) {
      return { ok: false, error: '写入失败：' + String(error && error.message || error) };
    }
    return { ok: true, file: found.file, files: this.rulesFiles(body && body.cwd, found.provider) };
  }

  /**
   * 预览任意本地文件（右侧检查器用）。图片内嵌成 data URL，HTML 走
   * 「页面」标签，其余按文本展示；目录返回两层清单。
   */
  previewAny(target, maxLines) {
    const file = text(target || '');
    if (!file) return { error: '没有指定文件' };
    let resolved;
    try { resolved = realpathSync(file); } catch { return { name: path.basename(file), path: file, error: '文件不存在' }; }
    let stat;
    try { stat = statSync(resolved); } catch (error) { return { name: path.basename(resolved), path: resolved, error: '文件不可读：' + String(error) }; }
    if (stat.isDirectory()) {
      let children = [];
      try { children = readdirSync(resolved, { withFileTypes: true }).slice(0, 200); } catch { /* unreadable */ }
      return {
        name: path.basename(resolved) || resolved, path: resolved, kind: 'directory',
        entries: children.map((child) => ({ name: child.name, type: child.isDirectory() ? 'dir' : 'file' })),
      };
    }
    const result = this.preview(resolved);
    if (maxLines && result && typeof result.text === 'string') {
      const lines = result.text.split('\n');
      result.truncated = lines.length > maxLines;
      result.text = lines.slice(0, maxLines).join('\n');
    }
    return result;
  }

  preview(target) {
    let stat;
    try { stat = statSync(target); } catch (error) {
      return { error: '文件不可读：' + String(error) };
    }
    if (stat.isDirectory()) return { error: '这是一个目录' };
    const ext = path.extname(target).toLowerCase();
    const name = path.basename(target);
    const size = stat.size;
    const imageExt = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg']);
    if (imageExt.has(ext)) {
      if (size > 8 * 1024 * 1024) return { name, path: target, size, kind: 'image', error: '图片超过 8MB，未内嵌预览' };
      const buffer = readFileSync(target);
      const mime = ext === '.svg' ? 'image/svg+xml'
        : ext === '.png' ? 'image/png'
          : ext === '.gif' ? 'image/gif'
            : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      const dims = imageSize(buffer);
      return {
        name, path: target, size, kind: 'image',
        mime, dataUrl: 'data:' + mime + ';base64,' + buffer.toString('base64'),
        width: dims ? dims.width : null, height: dims ? dims.height : null,
      };
    }
    // 明确的二进制扩展名直接判死，不再靠「里面有没有 0x00」猜——小文件的
    // 前几个字节可能恰好没有 0，会被误当文本吐一堆乱码（.exe/.zip 都踩过）。
    if (BINARY_EXT.has(ext)) return { name, path: target, size, kind: 'binary', error: '这是二进制文件，无法预览为文本' };
    if (size > 1024 * 1024) return { name, path: target, size, kind: 'binary', error: '文件超过 1MB，不做文本预览' };
    const buffer = readFileSync(target);
    if (buffer.includes(0) || looksBinary(buffer)) return { name, path: target, size, kind: 'binary', error: '内容像二进制，不做文本预览' };
    const isHtml = ext === '.html' || ext === '.htm';
    const isMarkdown = ext === '.md' || ext === '.markdown';
    return {
      name, path: target, size, kind: isHtml ? 'html' : isMarkdown ? 'markdown' : 'text',
      lang: langOf(ext),
      text: buffer.toString('utf8').slice(0, 300000),
    };
  }
}

export const inject = ['webServer'];

/* 客户端全部卸载后，多久才真正回收插件（等于杀 CLI）。要长于宿主自己的回收延迟，
   也要留给「切走→切回来」的时间；期间重新挂载会被 /unmount-cancel 取消。 */
const IDLE_UNMOUNT_MS = 30 * 60 * 1000;

export function apply(ctx) {
  const workbench = new Workbench(ctx);
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API,
    handler: (req, res) => workbench.handle(req, res),
  }), 'cli-workbench: http');
  /* 宿主回收插件时的清理由 scheduleIdleUnmount 排期执行，保证「短暂切走」不会
     打断正在跑的 CLI；真想收尾（插件被卸载 / DSH 退出）时 dispose 会立刻跑。 */
  ctx.effect(() => () => workbench.scheduleIdleUnmount(), 'cli-workbench: processes');
  // Warm the sandbox probe so the first Codex message does not wait for two
  // `codex doctor` runs. Errors surface through /status, not here.
  workbench.codexSandbox().catch(() => {});
}
