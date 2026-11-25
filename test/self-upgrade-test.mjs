/**
 * 「立即升级」的前置检查：本机解析不到 dsh 命令时，按钮灰掉并说明去哪装。
 *
 * 背景：升级是跑 `dsh plugin add`，靠 PATH 找命令；而 DSH 桌面版**默认不把 dsh
 * 写进 PATH**（要在「应用 → 管理 dsh 命令…」里手动装）。没有这一步时，用户点下去
 * 只会得到一句 cmd 的「'dsh' 不是内部或外部命令」——在那台机器上实测过。
 *
 * hasDsh() 是**抽真实源码**跑的，不是复制一份逻辑：改了实现这里会跟着变。
 */
import fs from 'node:fs';
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

const methodBlock = sliceBlock(src, 'async hasDsh() {');
ok('抽到 hasDsh 方法体', Boolean(methodBlock));

/* 用 index.js 里同一段源码建一个独立函数；run / now / process 换成假的。 */
const build = (platform, answer) => {
  const body = methodBlock.slice(methodBlock.indexOf('{') + 1, methodBlock.lastIndexOf('}'));
  const calls = [];
  let clock = 1000000;
  const probe = new Function('run', 'now', 'process', 'return async function hasDsh() {' + body + '};')(
    async (command) => { calls.push(command); return answer; },
    () => clock,
    { platform },
  );
  const state = { dshCache: null };
  return {
    probe: () => probe.call(state),
    calls,
    advance: (ms) => { clock += ms; },
  };
};

console.log('\n[1] 有 dsh 命令');
{
  const harness = build('win32', { code: 0, stdout: 'C:\\bin\\dsh.cmd\r\nC:\\other\\dsh.cmd\r\n', stderr: '' });
  const value = await harness.probe();
  ok('判定为可用', value.ok === true, JSON.stringify(value));
  ok('path 取第一行（多行输出只认第一个）', value.path === 'C:\\bin\\dsh.cmd', JSON.stringify(value.path));
  ok('Windows 用 where dsh', harness.calls[0] === 'where dsh', harness.calls.join(' | '));
}

console.log('\n[2] 解析不到');
{
  const harness = build('win32', { code: 1, stdout: '', stderr: "'dsh' is not recognized" });
  const value = await harness.probe();
  ok('判定为不可用', value.ok === false, JSON.stringify(value));
  ok('path 是空串，不是报错文本', value.path === '', JSON.stringify(value.path));
}

console.log('\n[3] 缓存 10 分钟，过期重探');
{
  const harness = build('win32', { code: 0, stdout: 'C:\\bin\\dsh.cmd\r\n', stderr: '' });
  await harness.probe();
  await harness.probe();
  ok('缓存期内不重复跑命令', harness.calls.length === 1, String(harness.calls.length));
  harness.advance(11 * 60 * 1000);
  await harness.probe();
  ok('过期后会重探', harness.calls.length === 2, String(harness.calls.length));
}

console.log('\n[4] 非 Windows 的探测命令');
{
  const harness = build('linux', { code: 0, stdout: '/usr/local/bin/dsh\n', stderr: '' });
  const value = await harness.probe();
  ok('用 command -v dsh', harness.calls[0] === 'command -v dsh', harness.calls.join(' | '));
  ok('照样取到路径', value.ok === true && value.path === '/usr/local/bin/dsh', JSON.stringify(value));
}

console.log('\n[5] Host 接线');
{
  ok('构造函数里有 dshCache', /this\.dshCache = null;/.test(src));
  ok('「重新检测」会连 dsh 缓存一起清', /if \(force\) this\.dshCache = null;/.test(src));
  ok('版本接口带上 dsh 状态', /dsh: await this\.hasDsh\(\),/.test(src));
  ok('升级前先判定，不跑注定失败的命令', src.indexOf("reason: 'no-dsh'") > 0
    && src.indexOf("reason: 'no-dsh'") < src.indexOf("run(command, { timeout: 180000 })"));
  ok('失败文案指向「管理 dsh 命令」', /还没有 dsh 命令：打开「应用 → 管理 dsh 命令…」点安装/.test(src));
}

console.log('\n[6] 客户端接线');
{
  ok('算出了 selfNoDsh', /const selfNoDsh = Boolean\(selfVersion && selfVersion\.install === 'package'/.test(clientSrc));
  ok('按钮在没装时灰掉', /disabled: \(selfUpgrade && selfUpgrade\.phase === 'running'\) \|\| selfNoDsh/.test(clientSrc));
  ok('底部说明用危险色', /className: 'cw-upd-compat' \+ \(selfNoDsh \? ' bad' : ''\)/.test(clientSrc));
  ok('说明写着去哪装', /这台机器还没装 dsh 命令：打开「应用 → 管理 dsh 命令…」点安装，重启 DSH 后再升级。/.test(clientSrc));
  ok('按钮 tooltip 与说明一致', /先到「应用 → 管理 dsh 命令…」安装 dsh/.test(clientSrc));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);