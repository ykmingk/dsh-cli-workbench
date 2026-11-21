/**
 * 把两个 CLI 的原始事件变成人能看懂的一行话。
 * 纯函数，无副作用；从 index.js 原样搬出。
 */
import { text, oneLine } from './util.js';

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

function isAdvisoryMessage(message) {
  const value = String(message || '').trim();
  if (!value) return false;
  return /^Under-development features enabled/i.test(value)
    || /suppress_unstable_features_warning/i.test(value)
    || /^Tip:\s/i.test(value);
}

function codexFailureText(error) {
  if (!error) return '';
  if (typeof error === 'string') return error.trim();
  if (typeof error.message === 'string' && error.message.trim()) return error.message.trim();
  try { return JSON.stringify(error); } catch { return String(error); }
}

export { contentToText, toolTarget, toolCategory, toolVerb, diffOf, humanImpact, isAdvisoryMessage, codexFailureText };
