/**
 * 设置面板「CLI 记录占用」的读数据源。
 *
 * Host 侧 scanTree() 是真实源码抽出来跑的；另外断言 /disk 路由与客户端那一行
 * 都还接着（删掉任何一端都会让读数变空白）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(rootDir, 'index.js'), 'utf8');
const clientSrc = fs.readFileSync(path.join(rootDir, 'client.js'), 'utf8');

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

const block = sliceBlock(src, 'function scanTree(dirs, limit = 20000) {');
ok('抽到 scanTree()', Boolean(block));
const scanTree = new Function('readdirSync', 'statSync', 'path', 'return ' + block)(
  fs.readdirSync, fs.statSync, path,
);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-disk-'));
fs.writeFileSync(path.join(root, 'a.txt'), 'aaaaa');            // 5
fs.writeFileSync(path.join(root, 'b.txt'), 'bbbbbbb');          // 7
const nested = path.join(root, 'sub');
fs.mkdirSync(nested);
fs.writeFileSync(path.join(nested, 'c.txt'), 'ccc');            // 3

const size = scanTree([root]);
ok('统计文件数与字节数', size.files === 3 && size.bytes === 15, JSON.stringify(size));
ok('不截断时不标记 truncated', size.truncated === false);

const limited = scanTree([root], 2);
ok('超过上限就截断并标记', limited.files === 2 && limited.truncated === true, JSON.stringify(limited));

const missing = scanTree([path.join(root, 'nope')]);
ok('目录不存在时返回 0，不抛错', missing.files === 0 && missing.bytes === 0);

ok('Host 暴露 /disk 路由', src.includes("route === '/disk'") && src.includes('this.diskUsage()'));
ok('diskUsage 带 5 分钟缓存', /diskCache[\s\S]{0,200}5 \* 60 \* 1000/.test(src));
ok('统计的是 CLI 记录目录', src.includes('claudeProjectsDir()')
  && src.includes("path.join(codexDir, 'sessions')") && src.includes("'archived_sessions'"));
ok('客户端打开设置时查 /disk', clientSrc.includes("api('/disk')"));
ok('设置面板有占用读数', clientSrc.includes('CLI 记录占用：Claude ') && clientSrc.includes('Codex '));
ok('读数带删除与 30 天说明', clientSrc.includes('删除会话会一起清掉对应记录；Claude 默认只保留 30 天。'));

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);