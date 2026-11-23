/**
 * 扫 CLI 自己的历史记录，供「从 CLI 导入会话」用。
 *
 * 只读、只取元信息：会话 id、工作目录、首条用户消息（当标题）、时间、大小、文件路径。
 * **不读正文正文进内存**——每个文件只读头部 256KB（首条消息总在最前面）。
 * 正文永远留在 CLI 那边，导入只是登记一个指针。
 */
import { openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/* 只读文件头部：会话的 meta 与首条用户消息都在最前面，几 MB 的转录读全量是浪费。 */
const HEAD_BYTES = 256 * 1024;

function readHead(file, limit = HEAD_BYTES) {
  let fd = -1;
  try {
    const info = statSync(file);
    if (!info.isFile()) return null;
    const length = Math.min(info.size, limit);
    const buffer = Buffer.alloc(length);
    fd = openSync(file, 'r');
    readSync(fd, buffer, 0, length, 0);
    return { text: buffer.toString('utf8'), size: info.size, mtimeMs: info.mtimeMs, truncated: info.size > limit };
  } catch {
    return null;
  } finally {
    if (fd >= 0) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

/** 去掉 CLI 注入的那些尖括号块（技能说明、命令回显），只留人话。 */
function cleanTitle(value, max = 80) {
  const raw = String(value == null ? '' : value)
    .replace(/<[^>]{1,80}>/g, ' ')
    .replace(/^\s*(#+\s*)?(AGENTS\.md|CLAUDE\.md)[^\n]*/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return '';
  return raw.length > max ? raw.slice(0, max - 1) + '…' : raw;
}

/** 从 `content` 里取第一段可读文本：可能是字符串，也可能是 content block 数组。 */
function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (typeof block.text === 'string' && block.text.trim()) return block.text;
  }
  return '';
}

function eachLine(text, visit) {
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record && typeof record === 'object' && visit(record) === false) return;
  }
}

/**
 * Claude 的 `<sessionId>.jsonl`：先找 `cwd`，再找第一条**真人**用户消息。
 * 跳过 `isSidechain`（子代理的转录不该当标题）与纯附件的消息。
 */
export function parseClaudeHead(text) {
  let cwd = '';
  let title = '';
  /* 只有斜杠命令的会话（`/goal`、`/clear`）没有「人话」可当标题，
     退而求其次用命令名——总比「无标题会话」有用。 */
  let commandTitle = '';
  eachLine(text, (record) => {
    /* 子代理（sidechain）的记录既不该定 cwd、也不该当标题 */
    if (record.isSidechain === true) return undefined;
    if (!cwd && typeof record.cwd === 'string') cwd = record.cwd;
    if (title) return cwd ? false : undefined;
    if (record.type !== 'user') return undefined;
    const message = record.message;
    if (!message || message.role !== 'user') return undefined;
    const rawText = textOfContent(message.content);
    /* `/clear` 这类斜杠命令会被 CLI 记成 `<command-name>…</command-name>`，
       去掉标签只剩命令名，当标题毫无意义——跳过它，继续找下一条真人消息。 */
    if (/<command-(name|message|args)>|<local-command-/i.test(rawText)) {
      if (!commandTitle) {
        const match = /<command-name>\s*(\/[^<\s]+)\s*<\/command-name>/i.exec(rawText);
        if (match) commandTitle = match[1];
      }
      return undefined;
    }
    const candidate = cleanTitle(rawText);
    if (candidate) title = candidate;
    return undefined;
  });
  return { cwd, title: title || commandTitle };
}

/**
 * Codex 的 `rollout-<时间>-<uuid>.jsonl`：
 *   - 第一行 `session_meta` 里有 id 与 cwd；
 *   - 用户真说的话在 `event_msg / item_completed / UserMessage` 里
 *     （`response_item` 的 user 消息里混着 AGENTS.md 之类的注入内容，不能用）。
 */
export function parseCodexHead(text) {
  let nativeId = '';
  let cwd = '';
  let title = '';
  eachLine(text, (record) => {
    if (!nativeId && record.type === 'session_meta' && record.payload) {
      const payload = record.payload;
      nativeId = String(payload.id || payload.session_id || '');
      if (typeof payload.cwd === 'string') cwd = payload.cwd;
    }
    if (!title && record.type === 'event_msg') {
      const payload = record.payload || {};
      const item = payload.item || {};
      if (payload.type === 'item_completed' && item.type === 'UserMessage') {
        const candidate = cleanTitle(textOfContent(item.content));
        if (candidate) title = candidate;
      }
    }
    if (nativeId && title) return false;
    return undefined;
  });
  return { nativeId, cwd, title };
}

/** Codex 的 rollout 文件名末尾就是线程 uuid。 */
export function codexIdFromName(name) {
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(String(name || ''));
  return match ? match[1] : '';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 扫 Claude 的 `<配置目录>/projects/<目录编码>/<uuid>.jsonl`。
 * 只认文件名为纯 uuid 的（`agent-*.jsonl` 这类子代理转录跳过）。
 */
export function scanClaudeSessions(rootDir) {
  const entries = [];
  let projects = [];
  try { projects = readdirSync(rootDir, { withFileTypes: true }); } catch { return entries; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(rootDir, project.name);
    let files = [];
    try { files = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      const nativeId = file.name.slice(0, -'.jsonl'.length);
      if (!UUID.test(nativeId)) continue;
      const full = path.join(dir, file.name);
      const head = readHead(full);
      if (!head) continue;
      const parsed = parseClaudeHead(head.text);
      entries.push({
        provider: 'claude',
        nativeId,
        cwd: parsed.cwd,
        title: parsed.title || '（无标题会话）',
        updatedAt: Math.round(head.mtimeMs),
        size: head.size,
        file: full,
      });
    }
  }
  return entries;
}

/**
 * 扫 Codex 的 `~/.codex/sessions/**` 与 `~/.codex/archived_sessions/**`。
 * 归档会话单独标出来：它们在 CLI 里是「归档」状态。
 */
export function scanCodexSessions(sessionDir, archivedDir) {
  const entries = [];
  const walk = (dir, archived) => {
    let items = [];
    try { items = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) { walk(full, archived); continue; }
      if (!item.isFile() || !item.name.startsWith('rollout-') || !item.name.endsWith('.jsonl')) continue;
      const head = readHead(full);
      if (!head) continue;
      const parsed = parseCodexHead(head.text);
      const nativeId = parsed.nativeId || codexIdFromName(item.name);
      if (!UUID.test(nativeId)) continue;
      entries.push({
        provider: 'codex',
        nativeId,
        cwd: parsed.cwd,
        title: parsed.title || '（无标题会话）',
        updatedAt: Math.round(head.mtimeMs),
        size: head.size,
        file: full,
        archived: Boolean(archived),
      });
    }
  };
  walk(sessionDir, false);
  if (archivedDir) walk(archivedDir, true);
  return entries;
}