/**
 * 输入框附件（图片 / 文件）的 Host 侧校验 + 客户端接线断言。
 *
 * Host 的几个工具函数与 saveAttachments 方法都是**抽出真实源码**来跑的，
 * 不是复制一份逻辑：改了实现这里会跟着变。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(rootDir, 'index.js'), 'utf8');
const clientSrc = fs.readFileSync(path.join(rootDir, 'client.js'), 'utf8');
const claudeSrc = fs.readFileSync(path.join(rootDir, 'lib', 'claude.js'), 'utf8');
const codexSrc = fs.readFileSync(path.join(rootDir, 'lib', 'codex.js'), 'utf8');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

/* —— 抽出大括号配对的函数体 —— */
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

const helpersStart = src.indexOf('const ATTACH_IMAGE_TYPES');
const helpersEnd = src.indexOf('class Workbench');
const helperSrc = helpersStart >= 0 && helpersEnd > helpersStart ? src.slice(helpersStart, helpersEnd) : '';
ok('抽到附件工具函数源码', helperSrc.includes('function attachmentFileName') && helperSrc.includes('function attachmentNote'));

const methodBlock = sliceBlock(src, 'saveAttachments(session, list) {');
ok('抽到 saveAttachments 方法体', Boolean(methodBlock));

/* 把工具函数 + 方法体拼成一个独立函数来跑：作用域里就是 index.js 的同一段源码。 */
const buildSave = () => {
  const body = methodBlock.slice(methodBlock.indexOf('{') + 1, methodBlock.lastIndexOf('}'));
  const factory = new Function(
    'path', 'mkdirSync', 'writeFileSync', 'statSync', 'randomBytes', 'text',
    helperSrc + '\n return function saveAttachments(session, list) {' + body + '};',
  );
  return factory(
    path, fs.mkdirSync, fs.writeFileSync, fs.statSync, randomBytes,
    (value) => (value == null ? '' : String(value)),
  );
};

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-attach-'));
const save = buildSave();
const workbench = { attachmentsDir: dir };
const session = { id: 'cw_attach_test' };

/* —— 正常路径：PNG + 文本文件 —— */
const saved = save.call(workbench, session, [
  { name: '截图 2026.png', mediaType: 'image/png', data: PNG.toString('base64') },
  { name: '需求.txt', mediaType: 'text/plain', data: Buffer.from('hello').toString('base64') },
]);
ok('两个附件都落盘', saved.length === 2, JSON.stringify(saved.map((item) => item.kind)));
ok('PNG 识别为图片', saved[0].kind === 'image' && saved[0].mediaType === 'image/png');
ok('图片文件真的写出来了', fs.existsSync(saved[0].path) && fs.readFileSync(saved[0].path).equals(PNG));
ok('文本识别为文件', saved[1].kind === 'file' && saved[1].size === 5);
ok('附件落在会话目录里', path.dirname(saved[0].path) === path.join(dir, session.id));

/* —— 名字不可信：路径分隔符只能当 basename —— */
const traversal = save.call(workbench, session, [
  { name: '../../evil.png', mediaType: 'image/png', data: PNG.toString('base64') },
]);
ok('目录穿越被压成 basename', path.basename(traversal[0].path).endsWith('evil.png')
  && path.dirname(traversal[0].path) === path.join(dir, session.id));

/* —— 声称是图片但字节不是：按文件处理（不能把任意字节内联给 CLI） —— */
const fake = save.call(workbench, session, [
  { name: 'fake.png', mediaType: 'image/png', data: Buffer.from('not really a png at all').toString('base64') },
]);
ok('伪造的图片降级成文件', fake[0].kind === 'file');

/* —— 上限 —— */
let tooBig = '';
try {
  /* 真的带 PNG 文件头，只是把体积撑到 9MB：这样才能走到「图片」那档上限 */
  const big = Buffer.alloc(9 * 1024 * 1024, 0);
  Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(big, 0);
  save.call(workbench, session, [{ name: 'big.png', mediaType: 'image/png', data: big.toString('base64') }]);
} catch (error) { tooBig = error.message; }
ok('超过 8MB 的图片被拒', /太大/.test(tooBig), tooBig);

let tooMany = '';
try {
  const many = Array.from({ length: 11 }, (_, index) => ({ name: 'a' + index + '.txt', mediaType: 'text/plain', data: 'eA==' }));
  save.call(workbench, session, many);
} catch (error) { tooMany = error.message; }
ok('超过 10 个附件被拒', /最多 10 个/.test(tooMany), tooMany);

/* —— 桌面端拖进来的路径引用：文件夹与文件都不复制 —— */
const folder = path.join(dir, '拖进来的文件夹');
fs.mkdirSync(folder, { recursive: true });
const referenced = save.call(workbench, session, [
  { kind: 'dir', name: '拖进来的文件夹', path: folder },
]);
ok('文件夹按路径挂上，没有复制', referenced.length === 1 && referenced[0].kind === 'dir'
  && referenced[0].path === folder && referenced[0].file === '');

const looseFile = path.join(dir, '外部文件.txt');
fs.writeFileSync(looseFile, 'outside');
const fileRef = save.call(workbench, session, [{ kind: 'file', name: '外部文件.txt', path: looseFile }]);
ok('文件按路径挂上，大小取自磁盘', fileRef[0].kind === 'file' && fileRef[0].size === 7 && fileRef[0].file === '');

let relative = '';
try { save.call(workbench, session, [{ kind: 'dir', name: 'x', path: '相对\\路径' }]); }
catch (error) { relative = error.message; }
ok('相对路径被拒', /绝对路径/.test(relative), relative);

let missing = '';
try { save.call(workbench, session, [{ kind: 'dir', name: 'x', path: path.join(dir, '不存在') }]); }
catch (error) { missing = error.message; }
ok('不存在的路径被拒', /找不到/.test(missing), missing);

let wrongType = '';
try { save.call(workbench, session, [{ kind: 'dir', name: '其实是文件', path: looseFile }]); }
catch (error) { wrongType = error.message; }
ok('把文件当文件夹会被拒', /不是文件夹/.test(wrongType), wrongType);

/* —— 正文里的附件说明 —— */
const note = new Function(helperSrc + '\n return attachmentNote;')();
const withFile = note([{ name: 'a.txt', kind: 'file', path: 'C:/x/a.txt' }]);
ok('文件附件给出落盘路径', withFile.includes('a.txt') && withFile.includes('C:/x/a.txt'));
ok('Claude 正文不列图片路径', !note([{ name: 'b.png', kind: 'image', path: 'C:/x/b.png' }]).includes('b.png'));
ok('Codex 正文连图片路径一起列', note([{ name: 'b.png', kind: 'image', path: 'C:/x/b.png' }], { images: true }).includes('C:/x/b.png'));
ok('文件夹在正文里标明类型', note([{ name: 'docs', kind: 'dir', path: 'C:/x/docs' }]).includes('（文件夹）'));

/* —— 客户端接线（静态断言：这些名字是 UI 与 Host 的契约） —— */
ok('客户端有粘贴接图片', clientSrc.includes('onPaste: (event) =>') && clientSrc.includes('event.clipboardData'));
ok('客户端有拖放接文件', clientSrc.includes('onDrop: (event) =>') && clientSrc.includes('addFiles(picked.files, picked.directories)'));
ok('客户端认得出文件夹', clientSrc.includes('webkitGetAsEntry') && clientSrc.includes("kind: 'dir'"));
ok('文件夹靠桌面端路径桥', clientSrc.includes('__DSH_HOST_PATHS__') && clientSrc.includes('hostPathFor'));
ok('拖进来的文件只带路径', clientSrc.includes('const path = isImage ? \'\' : hostPathFor(file)'));
ok('文件夹卡片用文件夹图标', clientSrc.includes("item.kind === 'dir' ? 'folder' : 'file'"));
ok('客户端有圆形 + 按钮', clientSrc.includes("className: 'cw-add'") && clientSrc.includes("name: 'plus'"));
ok('客户端有隐藏的文件选择器', clientSrc.includes("ref: fileInputRef") && clientSrc.includes("type: 'file'"));
ok('附件按会话分开存', clientSrc.includes('const [attachMap, setAttachMap] = useState({})'));
ok('发送时带上附件', clientSrc.includes('attachments: wireAttachments(attachments)'));
ok('只有附件也能发', clientSrc.includes('!draft.trim() && attachments.length === 0'));
ok('聊天记录里回放图片', clientSrc.includes("'/attachment?session='"));
ok('附件按钮是 DSH 的圆形态', /\.cw-add\{[^}]*border-radius:\s*999px/.test(clientSrc) && clientSrc.includes('var(--dsw-specific-selector'));

/* —— 两个适配器的附件通道 —— */
ok('Claude 用 image content block 内联图片', claudeSrc.includes("type: 'image'") && claudeSrc.includes("type: 'base64'"));
ok('Codex 用 --image= 传图片', codexSrc.includes("'--image=' + quoteArg(image.path)") && codexSrc.includes('--image='));
ok('Codex 只挑图片附件', codexSrc.includes("attachment.kind === 'image' && attachment.path"));
ok('Host 的 /attachment 端点只回放图片', src.includes("route === '/attachment'") && src.includes("error: 'not an image'"));
ok('删会话连带清附件', src.includes("rmSync(path.join(this.attachmentsDir, session.id), { recursive: true, force: true })"));

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);