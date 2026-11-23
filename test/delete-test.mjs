/**
 * 「删会话」必须连 CLI 自己的记录一起删。
 *
 * Claude 的记录是 <配置目录>/projects/<cwd 编码>/<会话 id>.jsonl（+ 同名工具结果目录）；
 * Codex 的 rollout 要靠 `codex delete --force`（非交互环境不带 --force 只会报错退出）。
 * 这里把 removeClaudeTranscript 的真实源码抽出来，在临时目录里跑。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(rootDir, 'index.js'), 'utf8');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

const sliceBlock = (text, marker) => {
  const start = text.indexOf(marker);
  if (start < 0) return null;
  let index = text.indexOf('{', start);
  let depth = 0;
  for (; index < text.length; index++) {
    if (text[index] === '{') depth++;
    else if (text[index] === '}') { depth--; if (depth === 0) return text.slice(start, index + 1); }
  }
  return null;
};

/* —— 抽出 claudeProjectsDir + removeClaudeTranscript —— */
const helperStart = src.indexOf('function claudeProjectsDir');
const helperEnd = src.indexOf('\n}', src.indexOf('CLAUDE_CONFIG_DIR')) + 2;
const helperSrc = src.slice(helperStart, helperEnd);
const method = sliceBlock(src, 'removeClaudeTranscript(claudeSessionId) {');
ok('抽到 claudeProjectsDir()', helperSrc.includes('CLAUDE_CONFIG_DIR'));
ok('抽到 removeClaudeTranscript()', Boolean(method));

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-delete-'));
const configDir = path.join(tempHome, 'claude-config');
const projects = path.join(configDir, 'projects');
const body = method.slice(method.indexOf('{') + 1, method.lastIndexOf('}'));
const factory = new Function(
  'path', 'os', 'process', 'readdirSync', 'existsSync', 'rmSync', 'text',
  helperSrc + '\n return function removeClaudeTranscript(claudeSessionId) {' + body + '};',
);
const remove = factory(
  path,
  { homedir: () => tempHome },
  { env: { CLAUDE_CONFIG_DIR: configDir } },
  fs.readdirSync, fs.existsSync, fs.rmSync,
  (value) => (value == null ? '' : String(value)),
);

const project = path.join(projects, 'D--------CLI---');
fs.mkdirSync(project, { recursive: true });
const sessionId = randomUUID();
const otherId = randomUUID();
const transcript = path.join(project, sessionId + '.jsonl');
const sidecar = path.join(project, sessionId, 'tool-results');
fs.writeFileSync(transcript, '{}');
fs.mkdirSync(sidecar, { recursive: true });
fs.writeFileSync(path.join(sidecar, 'call_1.json'), '{}');
const other = path.join(project, otherId + '.jsonl');
fs.writeFileSync(other, '{}');

ok('删掉本会话的 jsonl 与工具结果目录', remove(sessionId) === true
  && !fs.existsSync(transcript) && !fs.existsSync(sidecar));
ok('不碰别的会话', fs.existsSync(other));
ok('不存在的 id 返回 false', remove(randomUUID()) === false);
ok('非 UUID 直接拒绝', remove('../../CLI工作台') === false && remove('') === false);

/* —— 静态断言：调用点与 codex --force —— */
ok('删会话时调用 Claude 记录清理', /session\.provider === 'claude' && session\.claudeSessionId[\s\S]{0,80}removeClaudeTranscript/.test(src));
ok('codex 删除带 --force', src.includes("run('codex delete --force ' + thread)"));
ok('codex 参数不套引号（cmd 下会被二次解析）',
  !src.includes("codex delete --force \\\"' + thread") && !src.includes('codex archive \\"" + thread'));
ok('codex 归档/取消归档同样裸放 id', src.includes("run('codex archive ' + thread)")
  && src.includes("run('codex unarchive ' + thread)"));
ok('codex 线程 id 先做 UUID 校验', src.includes('function codexSessionArg'));
ok('codex 删除失败会记日志', src.includes("this.logOperation('session.cli-delete-failed'"));

/* —— 客户端：文件选择框的活 FileList 必须先拷贝再清空 —— */
const clientSrc = fs.readFileSync(path.join(rootDir, 'client.js'), 'utf8');
ok('文件选择先拷贝再清空（否则列表被清空）',
  clientSrc.indexOf('const list = Array.from(event.target.files || []);') >= 0
  && clientSrc.indexOf('const list = Array.from(event.target.files || []);') < clientSrc.indexOf("event.target.value = '';"));

fs.rmSync(tempHome, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);