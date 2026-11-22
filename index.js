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
  appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as claudeAdapter from './lib/claude.js';
import * as codexAdapter from './lib/codex.js';
import { contentToText, toolTarget, toolCategory, toolVerb, diffOf, humanImpact, isAdvisoryMessage, codexFailureText } from './lib/format.js';
import { now, idOf, text, clipText, oneLine, realCwd, run, killTree, PERMISSION_MODES, SANDBOX_MODES, SANDBOX_BACKENDS, MAX_ITEMS, API, json } from './lib/util.js';

const MCP_SCRIPT = fileURLToPath(new URL('./mcp-permission.mjs', import.meta.url));

/* 插件自身版本：给「检查更新」用。部署后 index.js 就在包根，读同目录 package.json。 */
const SELF_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '';
  } catch {
    return '';
  }
})();

/* 读最新版本号的几个来源，并行竞速、谁先答对用谁。
   首选 gitcode 的 contents API：国内直连、约 0.5 秒、不受 CDN 缓存影响
   （jsDelivr 对 @main 有十几小时缓存，刚发布的新版本读不到）。
   jsDelivr 的 @latest 作为备选；不用 GitHub raw —— 国内经常连不上。 */
const VERSION_SOURCES = [
  { url: 'https://gitcode.com/api/v5/repos/yk1900/dsh-cli-workbench/contents/package.json', kind: 'gitcode' },
  { url: 'https://fastly.jsdelivr.net/gh/ykmingk/dsh-cli-workbench@latest/package.json', kind: 'json' },
  { url: 'https://gcore.jsdelivr.net/gh/ykmingk/dsh-cli-workbench@latest/package.json', kind: 'json' },
];
const PROVIDERS = {
  claude: { label: 'Claude Code', pkg: '@anthropic-ai/claude-code' },
  codex: { label: 'Codex', pkg: '@openai/codex' },
};
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
const APPROVAL_TIMEOUT = 5 * 60 * 1000;
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.turbo', 'target', '.venv', 'venv',
  '__pycache__', '.idea', '.vscode', 'coverage', '.cache',
]);




/** 截断到 n 个字符，用于技能描述这种会塞进下拉项的文本。 */
;

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


/**
 * Codex 的「提醒类」输出：实验性开关、更新提示、路径建议这类，不是本轮失败。
 * 判据只在措辞上——认清它们是提示、不是错误；认不出来的一律当错误显示，不吞。
 */
















function parseVersion(output) {
  const match = text(output).match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/);
  return match ? match[0] : '';
}

/**
 * 比较两个版本号，返回 1 / 0 / -1。
 * 按数字段比，不能直接比字符串——那样 1.0.9 会大于 1.0.10。
 * 预发布后缀（-rc.1 等）视为比同号正式版旧。
 */
function compareVersion(left, right) {
  const split = (value) => {
    const [core, pre] = text(value).trim().replace(/^v/i, '').split('-', 2);
    const nums = core.split('.').map((part) => Number(part) || 0);
    return { nums, pre: pre || '' };
  };
  const a = split(left);
  const b = split(right);
  const length = Math.max(a.nums.length, b.nums.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a.nums[index] || 0) - (b.nums[index] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;   // 有后缀的是预发布，比正式版旧
  if (!b.pre) return -1;
  return a.pre > b.pre ? 1 : -1;
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
  /* 路径不存在时 explorer.exe 只会静默退出（退出码非 0，没有输出），
     接口却返回 200——用户看到的就是「点了没反应」。先自己判断存在性。 */
  const isUrl = /^(https?|mailto):/i.test(value);
  if (!isUrl) {
    try { statSync(value); } catch { return { ok: false, reason: 'missing' }; }
  }
  try {
    const child = isUrl
      ? spawn('rundll32.exe', ['url.dll,FileProtocolHandler', value], { detached: true, windowsHide: true })
      : spawn('explorer.exe', [value], { detached: true, windowsHide: true });
    // detached 子进程的 error 事件没人接就是 uncaughtException（Host 跑在 DSH 宿主的
    // 进程里，等于把整个应用带走）。接住它，只记一次失败。
    child.on('error', () => { /* 打开失败不该影响工作台 */ });
    child.unref();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String(error && error.message ? error.message : error) };
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
    /* 新布局：state.json 记着 savedAt。老布局是单个 sessions.json。
       两种都算「这个目录有数据」，比较的是时间戳，取新的那个。 */
    try {
      const state = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'));
      const savedAt = Number(state && state.savedAt) || 0;
      if (savedAt) return { at: savedAt, has: true };
    } catch { /* 没有新布局 */ }
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
    /* 存储布局（v3）：
         state.json           —— 工作区清单与时间戳（很小，每次写都无妨）
         sessions/<id>.json   —— 一个会话一个文件
       旧布局的单文件 sessions.json 仍会被读取，并在首次启动时迁移成新布局，
       原文件改名成 sessions.json.migrated-<时间> 留作备份，不删除。 */
    this.stateFile = path.join(this.dir, 'state.json');
    this.sessionsDir = path.join(this.dir, 'sessions');
    this.legacyFile = path.join(this.dir, 'sessions.json');
    // 每个会话上次落盘的内容：内容没变就不重写文件
    this.serialized = new Map();
    this.lastState = '';
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
    this.dirty = false;
    /* 实例标识：DSH 会在闲置后卸载插件、切回时重新挂载。写进日志就能区分
       「同一次挂载内的操作」和「某个旧实例拿着过时状态覆盖文件」。 */
    this.instanceId = idOf('wb');
    // 本实例的出生时间：save() 的 GC 用它区分「我启动前就在磁盘上的孤儿」
    // 和「并行实例刚写的文件」，后者不归我删。
    this.startedAt = Date.now() - 5000;
    // MCP 桥脚本的绝对路径：以 index.js 为基准算出来的，适配器通过实例取用
    this.mcpScript = MCP_SCRIPT;
    this.statusCache = { at: 0, value: null };
    this.updateCache = { at: 0, value: null };
    // npm 是否存在（缓存）：只影响「查最新版 / 升级」，不影响任何使用功能
    this.npmCache = null;
    // 插件自身的最新版本号（缓存 1 小时，只在用户打开设置时按需查询）
    this.versionCache = null;
    this.codexSandboxCache = null;
    this.codexSandboxPromise = null;
    this.compatCache = new Map();
    this.upgrading = new Set();
    this.unmountTimer = null;
    this.disposed = false;
    try { mkdirSync(this.mcpDir, { recursive: true }); } catch { /* ignore */ }
    this.settings = this.loadSettings();
    this.load();
    // 启动一行：数据目录来源、当前规模。排查「会话/工作区怎么不见了」时先看这条。
    this.logOperation('boot', {
      instance: this.instanceId,
      dir: this.dir,
      source: this.dataDirSource,
      sessions: this.sessions.size,
      workspaces: this.workspaces.size,
    });
  }

  /* ------------------------------------------------------- default modes */

  loadSettings() {
    const defaults = {
      claudeMode: 'manual',
      codexMode: 'workspace-write',
      codexSandboxBackend: 'auto',
    };
    try {
      if (existsSync(this.settingsFile)) {
        const parsed = JSON.parse(readFileSync(this.settingsFile, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          if (PERMISSION_MODES.has(parsed.claudeMode)) defaults.claudeMode = parsed.claudeMode;
          if (SANDBOX_MODES.has(parsed.codexMode)) defaults.codexMode = parsed.codexMode;
          if (SANDBOX_BACKENDS.has(parsed.codexSandboxBackend)) defaults.codexSandboxBackend = parsed.codexSandboxBackend;
        }
      }
    } catch { /* an unreadable settings file falls back to the defaults */ }
    return defaults;
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
    return next;
  }

  /* ---------------------------------------------------------------- store */

  load() {
    try {
      /* 先读新布局。一个会话一个文件：单个文件坏了只丢那一个会话，
         不会像旧布局那样整份解析失败、连累全部。 */
      let storedWorkspaces = null;
      if (existsSync(this.stateFile)) {
        const state = JSON.parse(readFileSync(this.stateFile, 'utf8'));
        if (state && Array.isArray(state.workspaces)) storedWorkspaces = state.workspaces;
      }
      const list = [];
      let legacy = null;
      if (existsSync(this.sessionsDir)) {
        for (const name of readdirSync(this.sessionsDir)) {
          if (!name.endsWith('.json')) continue;
          const full = path.join(this.sessionsDir, name);
          try { list.push(JSON.parse(readFileSync(full, 'utf8'))); }
          catch { try { renameSync(full, full + '.broken-' + now()); } catch { /* ignore */ } }
        }
      }
      // 旧布局（单文件）：读出来之后走一次迁移
      if (!list.length && existsSync(this.legacyFile)) {
        legacy = JSON.parse(readFileSync(this.legacyFile, 'utf8'));
        if (Array.isArray(legacy.sessions)) list.push(...legacy.sessions);
        if (storedWorkspaces === null && Array.isArray(legacy.workspaces)) storedWorkspaces = legacy.workspaces;
      }
      // A state file written before workspaces existed has no `workspaces` key
      // (as opposed to an empty list, which is a real user choice after deleting
      // every workspace). Only the missing key seeds the registry from sessions.
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
      for (const raw of list) {
        if (!raw || typeof raw !== 'object' || !raw.id) continue;        const session = {
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
      /* 回填 serialized：save() 靠它判断「内容变没变」。不回填的话，
         每次挂载后的第一次 save 都会把全部会话文件重写一遍。 */
      if (!legacy) {
        for (const session of this.sessions.values()) {
          this.serialized.set(session.id, JSON.stringify(this.persistCopy(session)));
        }
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
      /* 迁移：旧单文件 → 新布局。原文件改名保留（不删），
         万一新布局有问题，把 .migrated-* 改回去就能回到旧版本。 */
      if (legacy) {
        try { renameSync(this.legacyFile, this.legacyFile + '.migrated-' + now()); } catch { /* ignore */ }
        this.save(true);
        this.logOperation('migrate', { sessions: this.sessions.size, workspaces: this.workspaces.size });
      }
    } catch (error) {
      try {
        const target = existsSync(this.stateFile) ? this.stateFile : this.legacyFile;
        if (existsSync(target)) renameSync(target, target + '.broken-' + now());
      } catch { /* ignore */ }
    }
  }

  scheduleSave() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 400);
  }

  /**
   * 内存态 → 持久态的投影。
   *
   * session 上挂着 _reapTimer（Timeout 对象，含循环引用）、_mcpToken、_textIds 等
   * 私有字段，直接展开会让 JSON.stringify 抛异常，而异常被吞掉就会静默停止更新
   * （删掉的会话重启后复活、退出时丢全部会话）。这里按前缀统一剥离。
   */
  persistCopy(session) {
    const copy = { ...session };
    for (const key of Object.keys(copy)) {
      if (key.charCodeAt(0) === 95 /* _ */) delete copy[key];
    }
    copy.pending = null;
    copy.pendingQueue = [];
    copy.items = session.items.slice(-MAX_ITEMS);
    return copy;
  }

  /**
   * 落盘。新布局下：
   *   - 每个会话一个文件，**内容没变就不重写**（serialized 里存着上次的文本）；
   *   - 已经删掉的会话，对应文件也删掉；
   *   - 工作区等全局状态写进 state.json（很小，每次都写）。
   * @param {boolean} [force] 无视内容比对，全部重写（迁移/修复时用）
   */
  save(force) {
    try {
      this.dirty = false;
      mkdirSync(this.sessionsDir, { recursive: true });
      /* 多实例保护：GC 只清理**本实例启动之前**就存在的孤儿。
         DSH 会在闲置后卸载/重挂插件，可能同时有两个实例：旧实例的内存里没有
         新实例刚建的会话，无条件清理会把别人刚写的文件当垃圾删掉
         （表现就是「刚建的会话重启后消失」）。 */
      const gcFloor = this.startedAt;
      for (const session of this.sessions.values()) {
        const payload = JSON.stringify(this.persistCopy(session));
        if (!force && this.serialized.get(session.id) === payload) continue;
        const target = path.join(this.sessionsDir, session.id + '.json');
        const tmp = target + '.tmp';
        writeFileSync(tmp, payload);
        renameSync(tmp, target);
        this.serialized.set(session.id, payload);
      }
      try {
        for (const name of readdirSync(this.sessionsDir)) {
          if (!name.endsWith('.json')) continue;
          const full = path.join(this.sessionsDir, name);
          const id = name.slice(0, -'.json'.length);
          if (this.sessions.has(id)) continue;
          // 文件比本实例新 → 是并行实例写的，别动它
          try { if (!force && statSync(full).mtimeMs > gcFloor) continue; } catch { /* 读不到就按旧规则走 */ }
          rmSync(full, { force: true });
          this.serialized.delete(id);
        }
      } catch { /* 清理失败不影响本次写入 */ }
      const state = JSON.stringify({ version: 3, savedAt: now(), workspaces: this.workspaceList() }, null, 2);
      if (force || state !== this.lastState) {
        const tmp = this.stateFile + '.tmp';
        writeFileSync(tmp, state);
        renameSync(tmp, this.stateFile);
        this.lastState = state;
      }
      this.saveError = null;
    } catch (error) {
      // 写盘失败不能打断一回合，但也不能一声不吭——把原因留下来供 /status 查看。
      this.saveError = String(error && error.message ? error.message : error);
    }
  }

  /* ------------------------------------------- 协议适配器（实现见 lib/claude.js / lib/codex.js）
     方法体已搬走，这里只留一层委托：调用点、日志、栈回溯都还在原位置。 */
  ensureClaude(session) { return claudeAdapter.ensureClaude(this, session); }
  handleClaude(session, event) { return claudeAdapter.handleClaude(this, session, event); }
  handleStreamEvent(session, streamEvent) { return claudeAdapter.handleStreamEvent(this, session, streamEvent); }
  patchOpenStreaming(session) { return claudeAdapter.patchOpenStreaming(this, session); }
  startCodex(session, content, seq) { return codexAdapter.startCodex(this, session, content, seq); }
  handleCodex(session, event) { return codexAdapter.handleCodex(this, session, event); }
  handleCodexItem(session, item, completed) { return codexAdapter.handleCodexItem(this, session, item, completed); }
  codexRolloutContext(threadId) { return codexAdapter.codexRolloutContext(this, threadId); }

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
    if (this.saveTimer !== null) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    /* 只有确实有待落盘的改动才写。DSH 会在闲置后卸载插件，届时可能同时存在新实例：
       无条件 save() 会让这个可能已经过时的实例把它那份内存状态覆盖到别人刚写好的
       文件上（表现出来就是「刚加的工作区又没了」）。 */
    this.logOperation('dispose', { instance: this.instanceId, dirty: Boolean(this.dirty), workspaces: this.workspaces.size });
    if (this.dirty) this.save();
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

  ensureWorkspace(dir, titleOverride) {
    const cwd = realCwd(text(dir));
    if (!cwd) return null;
    const wanted = titleOverride ? oneLine(String(titleOverride).trim(), 60) : '';
    const existing = this.workspaces.get(cwd.toLowerCase());
    if (existing) {
      // 撤销删除时会带着原名字回来：保留用户自定义的显示名
      if (wanted && existing.title !== wanted) { existing.title = wanted; this.save(); }
      return existing;
    }
    const entry = { cwd, title: wanted || path.basename(cwd) || cwd, addedAt: now() };
    this.workspaces.set(cwd.toLowerCase(), entry);
    // 用户的一次显式操作：立刻落盘，避免 debounce 窗口里崩掉丢掉工作区增删。
    this.save();
    return entry;
  }

  /**
   * 排查用的操作日志（JSONL，落在数据目录，**不通过任何接口暴露**）。
   *
   * 起因：工作区/会话的增删在界面上没有痕迹，出问题只能靠猜（「这行怎么没了」）。
   * 这里只记录改变状态的动作和时间，写失败绝不影响主流程。
   */
  logOperation(kind, detail) {
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = path.join(this.dir, 'operations.log');
      appendFileSync(file, JSON.stringify({ at: now(), kind, ...(detail || {}) }) + '\n');
      // 控制体积：超过 256KB 时只留最近 500 行
      if (statSync(file).size > 256 * 1024) {
        const lines = readFileSync(file, 'utf8').trim().split('\n');
        writeFileSync(file, lines.slice(-500).join('\n') + '\n');
      }
    } catch { /* 日志失败不能影响主流程 */ }
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
      /* 项目级规则会落到 `<cwd>/CLAUDE.md`，所以 cwd 必须在工作台范围内。
         用户级（user-claude / user-agents）写的是家目录，与 cwd 无关，不在这里卡。 */
      const id = text(body && body.id || '');
      if (!id.startsWith('user-')) {
        const cwd = realCwd(text(body && body.cwd || ''));
        if (!cwd || (!this.withinAnyWorkspace(cwd) && !this.knownCwd(cwd))) {
          return json(res, 403, { error: '只能修改工作台里的项目规则' });
        }
      }
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
    if (route === '/workspaces' && method === 'POST') {
      // 主动登记一个目录为工作区。以前只能「在那个目录里建一个会话再删掉」，
      // 误删工作区后没有任何正经的恢复入口。
      const body = await readBody(req);
      const cwd = realCwd(text(body.cwd || body.path || ''));
      if (!cwd) return json(res, 400, { error: 'cwd required' });
      let isDir = false;
      try { isDir = statSync(cwd).isDirectory(); } catch { isDir = false; }
      if (!isDir) return json(res, 400, { error: '目录不存在：' + cwd });
      const title = text(body.title || '').trim();
      if (title.length > 60) return json(res, 400, { error: '工作区名称最长 60 个字符' });
      const entry = this.ensureWorkspace(cwd, title);
      if (!entry) return json(res, 400, { error: '无法登记该目录' });
      this.logOperation('workspace.add', { cwd: entry.cwd, title: entry.title });
      return json(res, 200, { ok: true, workspaces: this.workspaceList() });
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
      this.logOperation('workspace.rename', { cwd: entry.cwd, title });
      return json(res, 200, { ok: true, workspaces: this.workspaceList() });
    }
    if (route === '/workspaces' && method === 'DELETE') {
      const cwd = text(url.searchParams.get('cwd') || '');
      if (!cwd) return json(res, 400, { error: 'cwd required' });
      const resolved = realCwd(cwd);
      const known = resolved ? this.workspaces.get(resolved.toLowerCase()) : null;
      if (!this.removeWorkspace(cwd)) return json(res, 404, { error: '工作区不存在：' + cwd });
      // 记下名字：撤销时要用原显示名重建
      this.logOperation('workspace.remove', { cwd: known ? known.cwd : resolved, title: known ? known.title : '' });
      return json(res, 200, { ok: true, removed: known ? { cwd: known.cwd, title: known.title } : null, workspaces: this.workspaceList() });
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
      this.logOperation('session.create', { id: session.id, provider, cwd, title: session.title });
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
        this.logOperation('session.delete', { id: session.id, provider: session.provider, cwd: session.cwd, title: session.title });
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
    if (route === '/version' && method === 'GET') {
      return json(res, 200, await this.pluginVersion(url.searchParams.get('force') === '1'));
    }
    if (route === '/dirs' && method === 'GET') {
        /* 插件自己的目录选择器后端。
           DSH 的 ctx.uiWorkspace.pickDirectory() 在部分装配下根本没有「弹系统选择器」
           的能力（它会装配成 browse 后端），于是「浏览」按钮点了没反应。
           这里直接列目录：只读、只返回文件夹名，不读文件内容。 */
        const raw = text(url.searchParams.get('path') || '');
        if (!raw) {
          /* 起点不给「扫描所有盘符」：盘符可能是断开的网络映射，statSync 会卡住
             整个事件循环（实测让后续请求全部超时）。这里只给确定的几处：
             系统盘、用户主目录、已知工作区。要别的路径直接在上面输入。 */
          const roots = [];
          const addRoot = (value) => {
            const item = text(value).trim();
            if (item && !roots.some((root) => root.toLowerCase() === item.toLowerCase())) roots.push(item);
          };
          if (process.platform === 'win32') addRoot((process.env.SystemDrive || 'C:') + '\\');
          else addRoot('/');
          addRoot(os.homedir());
          for (const entry of this.workspaces.values()) addRoot(entry.cwd);
          return json(res, 200, { path: '', parent: null, roots, entries: [] });
        }
        const dir = path.resolve(raw);
        let isDir = false;
        try { isDir = statSync(dir).isDirectory(); } catch { isDir = false; }
        if (!isDir) return json(res, 400, { error: '目录不存在：' + dir });
        const entries = [];
        let truncated = false;
        try {
          for (const child of readdirSync(dir, { withFileTypes: true })) {
            if (!child.isDirectory()) continue;
            if (entries.length >= 500) { truncated = true; break; }
            entries.push({ name: child.name, path: path.join(dir, child.name) });
          }
        } catch (error) {
          return json(res, 403, { error: '无法读取该目录：' + (error && error.message ? error.message : error) });
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        const parent = path.dirname(dir) === dir ? null : path.dirname(dir);
        return json(res, 200, { path: dir, parent, roots: [], entries, truncated });
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
        const child = spawn('explorer.exe', ['/select,', safe], { detached: true, windowsHide: true });
        child.on('error', () => { /* 打开失败不该影响工作台 */ });
        child.unref();
        return json(res, 200, { ok: true });
      }
      if (!target) return json(res, 400, { error: 'empty target' });
      /* 先判存在性再看归属：路径不存在与「越界」是两回事，报错要说清楚。
         （顺序反了会把「目录被删了」说成「只能打开工作台里的路径」。） */
      if (!/^(https?|mailto):/i.test(target)) {
        let exists = false;
        try { exists = Boolean(statSync(target)); } catch { exists = false; }
        if (!exists) return json(res, 400, { error: '路径不存在：' + target });
      }
      /* 只允许打开「工作台知道的路径」：已登记的工作区、某个会话的工作目录，
         或（带 session 时）该会话作用域内的文件。
         原来任意路径都会交给系统打开——参数虽然已经消毒，但能力本身没有边界。 */
      const allowed = this.withinAnyWorkspace(target)
        || (session ? Boolean(this.safePath(session, target)) : false)
        || this.knownCwd(target);
      if (!allowed) return json(res, 403, { error: '只能打开工作台里的路径' });
      const opened = openTarget(target);
      if (!opened.ok) {
        return json(res, 400, {
          error: opened.reason === 'missing' ? '路径不存在：' + target : ('无法打开该路径：' + (opened.reason || '未知原因')),
        });
      }
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
    // 会话文件立刻删除，不等下一次延迟写盘（否则期间崩溃会让它「复活」）
    try {
      rmSync(path.join(this.sessionsDir, session.id + '.json'), { force: true });
      this.serialized.delete(session.id);
    } catch { /* ignore */ }
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
      // 最近一次写盘失败的原因（成功时为 null）。写盘失败不会打断
      // 回合，但必须能查到——否则「改了没保住」只会表现为重启后数据回退。
      storage: {
        saveError: this.saveError || null,
        // 实例号：同一进程里若出现两个实例，它们各自持有内存状态并互相覆盖文件。
        // 连续两次请求对比它，就能确认是不是同一个实例在服务。
        instance: this.instanceId,
        layout: 3,
      },
    };
    this.statusCache = { at: now(), value };
    return value;
  }

  /**
   * 模型选择器需要的数据，只有两项：
   *   model   —— 本机 CLI 配置里当前用的模型（「默认」那一行右侧要写它）
   *   aliases —— 可选项清单 [{ alias: 传给 --model 的值, model: 说明/具体模型 }]
   * 其余字段（来源、是否别名、解析结果…）已经没有任何界面在读了，不再下发。
   */
  models() {
    const claude = { model: '', aliases: [] };
    const codex = { model: '', aliases: [] };
    try {
      const file = path.join(os.homedir(), '.claude', 'settings.json');
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (parsed && typeof parsed.model === 'string') claude.model = parsed.model;
        /* 别名 → 具体模型。CLI 用 env 里的 ANTHROPIC_DEFAULT_<别名>_MODEL 定义这条映射，
           这是唯一能知道「sonnet 到底是哪个模型」的地方（--help 只列名字，不给目标）。 */
        if (parsed && parsed.env && typeof parsed.env === 'object') {
          const order = ['sonnet', 'opus', 'fable', 'haiku'];
          const found = [];
          for (const [key, value] of Object.entries(parsed.env)) {
            const match = /^ANTHROPIC_DEFAULT_([A-Z0-9]+)_MODEL$/.exec(key);
            if (!match) continue;
            if (typeof value !== 'string' || !value.trim()) continue;
            found.push({ alias: match[1].toLowerCase(), model: value.trim() });
          }
          claude.aliases = found.sort((a, b) => {
            const ia = order.indexOf(a.alias);
            const ib = order.indexOf(b.alias);
            return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.alias.localeCompare(b.alias);
          });
        }
        if (parsed && parsed.env && typeof parsed.env.ANTHROPIC_MODEL === 'string') {
          claude.model = parsed.env.ANTHROPIC_MODEL;
        }
      }
    } catch { /* unreadable config */ }
    try {
      const dir = path.join(os.homedir(), '.codex');
      const file = path.join(dir, 'config.toml');
      if (existsSync(file)) {
        const raw = readFileSync(file, 'utf8');
        const match = raw.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
        if (match) codex.model = match[1];
        /* Codex 没有 `models` 子命令，但它支持 model_catalog_json 指向一份模型目录。
           配了目录就能列出全部可选项（slug 直接喂给 --model），没配就只剩默认。 */
        const catalogMatch = raw.match(/^\s*model_catalog_json\s*=\s*["']([^"']+)["']/m);
        if (catalogMatch && catalogMatch[1].trim()) {
          const raw2 = catalogMatch[1].trim();
          const catalogFile = path.isAbsolute(raw2) ? raw2 : path.join(dir, raw2);
          if (existsSync(catalogFile)) {
            const catalog = JSON.parse(readFileSync(catalogFile, 'utf8'));
            const list = Array.isArray(catalog && catalog.models) ? catalog.models : [];
            codex.aliases = list
              .filter((entry) => entry && typeof entry.slug === 'string' && entry.slug.trim())
              .filter((entry) => !entry.visibility || entry.visibility === 'list')
              .map((entry) => ({ alias: entry.slug.trim(), model: text(entry.display_name) || '' }))
              .slice(0, 80);
          }
        }
      }
    } catch { /* unreadable config */ }
    return { claude, codex };
  }

  async updates(force) {
    if (!force && this.updateCache.value && now() - this.updateCache.at < 10 * 60 * 1000) {
      return this.updateCache.value;
    }
    const entries = {};
    // npm 只是「查最新版 / 用 npm 升级」的一条路，不是使用前提。
    // 没装 Node.js 的机器上它不存在，这时不该把整块状态显示成「检测失败」。
    const hasNpm = await this.hasNpm();
    for (const [id, meta] of Object.entries(PROVIDERS)) {
      // No quotes: cmd.exe's /d /s /c rewrites `"pkg"` into `""pkg""`, which npm
      // rejects as EINVALIDPACKAGENAME. Package names come from PROVIDERS, so the
      // string is fixed ASCII and never needs shell quoting.
      const result = hasNpm
        ? await run('npm view ' + meta.pkg + ' version --json --loglevel=error')
        : { code: -1, stdout: '', stderr: '' };
      let latest = '';
      if (result.code === 0) {
        try {
          const parsed = JSON.parse(result.stdout.trim());
          latest = typeof parsed === 'string' ? parsed : Array.isArray(parsed) ? parsed[parsed.length - 1] : '';
        } catch {
          latest = parseVersion(result.stdout);
        }
      }
      entries[id] = {
        latest,
        checkedAt: now(),
        error: result.code === 0 ? '' : npmError(result),
        npm: hasNpm,
        // 两个 CLI 都自带 update 子命令：没有 npm 也能升级，用它替代 npm install -g
        updater: id === 'claude' ? 'claude update' : 'codex update',
      };
    }
    const value = { fetchedAt: now(), entries };
    this.updateCache = { at: now(), value };
    return value;
  }

  /** npm 是否可用（缓存 10 分钟：它只影响「查/升最新版」这一件事）。 */
  async hasNpm() {
    if (this.npmCache && now() - this.npmCache.at < 10 * 60 * 1000) return this.npmCache.ok;
    const result = await run('npm --version');
    const ok = result.code === 0 && /\d+\.\d+/.test(result.stdout);
    this.npmCache = { at: now(), ok };
    return ok;
  }

  /**
   * 插件自身的最新版本号。
   *
   * 本地目录安装的插件，DSH 的插件页不会提示更新（它只认 catalog 与 npm）。
   * 这里自己读一次仓库里的 package.json：命中就告诉用户「有新版本，去下载」。
   * 只在用户打开设置时按需调用，结果缓存 1 小时——不轮询。
   */
  async pluginVersion(force) {
    if (!force && this.versionCache && now() - this.versionCache.at < 60 * 60 * 1000) {
      return this.versionCache.value;
    }
    let latest = '';
    let source = '';
    let error = '';
    /* 几个镜像并行问，谁先答对就用谁：串行的话最慢那个会把总耗时拖到 8 秒以上
       （实测 fastly 超时后 gcore 才返回）。Promise.any 拿到第一个成功的即可。 */
    try {
      const answers = await Promise.any(VERSION_SOURCES.map(async (source) => {
        const response = await fetch(source.url, { signal: AbortSignal.timeout(6000) });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const body = await response.json();
        /* gitcode 的 contents API 把文件内容放在 base64 里；jsDelivr 直接给 package.json */
        let version = '';
        if (source.kind === 'gitcode') {
          const decoded = Buffer.from(String(body.content || ''), 'base64').toString('utf8');
          const pkg = JSON.parse(decoded);
          version = pkg && typeof pkg.version === 'string' ? pkg.version : '';
        } else {
          version = body && typeof body.version === 'string' ? body.version : '';
        }
        if (!/^\d+\.\d+/.test(version)) throw new Error('返回内容里没有版本号');
        return { latest: version, source: source.url };
      }));
      latest = answers.latest;
      source = answers.source;
    } catch (failure) {
      // Promise.any 失败时是 AggregateError，逐个来源的原因对排查更有用
      const reasons = failure && Array.isArray(failure.errors) ? failure.errors : [failure];
      error = reasons.map((item) => String(item && item.message ? item.message : item)).join('; ');
    }
    const value = {
      current: SELF_VERSION,
      latest,
      source,
      error: latest ? '' : (error || '无法读取最新版本号'),
      // 只比较数字段，避免 1.0.9 被 1.0.10 判成「更新」这种字符串比较错误
      hasUpdate: Boolean(latest) && compareVersion(latest, SELF_VERSION) > 0,
      checkedAt: now(),
    };
    this.versionCache = { at: now(), value };
    return value;
  }

  async upgrade(provider) {
    /* 优先 npm（行为稳定、能装到全局），没有 npm 时退回 CLI 自带的 update 子命令。
       只用 npm 会让没装 Node.js 的机器完全无法升级——而两个 CLI 都自带更新器。 */
    const useNpm = await this.hasNpm();
    const command = useNpm
      ? 'npm install -g ' + PROVIDERS[provider].pkg + '@latest --loglevel=error'
      : (provider === 'claude' ? 'claude update' : 'codex update');
    const result = await run(command);
    if (result.code === 0) {
      // A new CLI release can change the flags and the sandbox backend, so the next
      // status request must probe again instead of reusing pre-upgrade answers.
      this.statusCache = { at: 0, value: null };
      this.updateCache = { at: 0, value: null };
      this.npmCache = null;
      this.compatCache.clear();
      this.codexSandboxCache = null;
    }
    return {
      ok: result.code === 0,
      provider,
      via: useNpm ? 'npm' : command,
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
    /* 路径还不存在时（比如要新建的目录）realpath 会抛错，原来直接返回 false
       ——于是「工作区里一个不存在的子目录」被报成「只能打开工作台里的路径」。
       拿不到真实路径就退回解析后的绝对路径，路径归属的判断靠前缀就够了。 */
    let target;
    try { target = realpathSync.native ? realpathSync.native(raw) : realpathSync(raw); } catch { target = path.resolve(raw); }
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

  /**
   * 这个路径是不是某个会话的工作目录。
   * 工作区被移除后，未分组会话所在的目录仍然允许打开——它仍是工作台里的东西。
   */
  knownCwd(input) {
    const raw = text(input);
    if (!raw) return false;
    let target;
    try { target = realpathSync.native ? realpathSync.native(raw) : realpathSync(raw); } catch { return false; }
    const lower = target.toLowerCase();
    for (const session of this.sessions.values()) {
      if (!session.cwd) continue;
      let cwd;
      try { cwd = realpathSync.native ? realpathSync.native(session.cwd) : realpathSync(session.cwd); } catch { cwd = path.resolve(session.cwd); }
      if (String(cwd).toLowerCase() === lower) return true;
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
