/**
 * P0 修复验证：把三处修复的「机制」在 Node 里跑一遍。
 * 每个用例先证明「修复前的写法确实会坏」，再证明「修复后的写法不会坏」。
 */
import { spawn } from 'node:child_process';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

/* ---------------------------------------------------------------- P0-2 */
console.log('\n[P0-2] save() 序列化私有字段（活 Timeout 会抛循环引用）');
{
  // 造一个和真实 session 同样形状的对象：挂着 _reapTimer（活 Timeout）
  const makeSession = () => {
    const session = { id: 's1', title: 't', items: [], cwd: 'C:\\x' };
    session._reapTimer = setTimeout(() => {}, 60_000);
    session._mcpToken = 'secret';
    session._textIds = ['a'];
    session._turnActive = true;
    return session;
  };

  // 修复前：直接展开
  const oldWay = (session) => ({ ...session, pending: null, pendingQueue: [], _turnActive: undefined });
  // 修复后：按 `_` 前缀剥离
  const newWay = (session) => {
    const copy = { ...session };
    for (const key of Object.keys(copy)) if (key.charCodeAt(0) === 95) delete copy[key];
    copy.pending = null; copy.pendingQueue = [];
    return copy;
  };

  const a = makeSession();
  let oldThrew = false;
  try { JSON.stringify(oldWay(a)); } catch { oldThrew = true; }
  ok('修复前确实抛异常（证明 bug 真实存在）', oldThrew);

  const b = makeSession();
  let newJson = null;
  let newThrew = false;
  try { newJson = JSON.stringify(newWay(b)); } catch { newThrew = true; }
  ok('修复后不再抛异常', !newThrew);
  ok('私有字段未落盘', newJson && !newJson.includes('_reapTimer') && !newJson.includes('_mcpToken'));
  ok('业务字段保留', newJson && newJson.includes('"id":"s1"') && newJson.includes('"cwd"'));
  clearTimeout(a._reapTimer); clearTimeout(b._reapTimer);
}

/* ---------------------------------------------------------------- P0-3 */
console.log('\n[P0-3] openTarget 命令注入');
{
  // 与 index.js 中修复后的判据一致
  const blocked = (value) => /[\u0000-\u001f\u007f"]/.test(value);

  ok('换行注入被拒', blocked('notepad\ncalc.exe'));
  ok('回车注入被拒', blocked('a\rb'));
  ok('tab 分隔被拒', blocked('a\tb'));
  ok('双引号逃逸被拒', blocked('a" \n calc'));
  ok('普通路径放行', !blocked('D:\\我的代码库\\CLI工作台'));
  ok('含空格路径放行', !blocked('C:\\Program Files\\x y'));
  ok('URL 放行', !blocked('https://gitcode.com/yk1900/dsh-cli-workbench'));
  ok('中文与 & 收在引号内放行', !blocked('D:\\a&b 目录'));

  // 修复前的写法只过滤引号，换行会活下来
  const oldSanitize = (t) => String(t).replace(/"/g, '');
  ok('修复前的过滤拦不住换行（证明 bug）', oldSanitize('a\ncalc') === 'a\ncalc');
}

/* ---------------------------------------------------------------- P0-1 */
console.log('\n[P0-1] 写已死 stdin 的 EPIPE');
await (async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /*
   * 复现条件必须精确：
   *  - 进程「已经退出」再 write → 同步抛 ERR_STREAM_DESTROYED（被 send 的 try 接住，
   *    由我新加的 writable 守卫处理）；
   *  - 进程「写时还活着、随后才死」→ 数据留在管道里等冲刷，冲刷失败是**异步**
   *    'error' 事件，没有监听就是 uncaughtException。
   * 所以这里让子进程活一小会儿再退出，并写入超过管道缓冲区的大块数据。
   */
  const big = 'x'.repeat(4 * 1024 * 1024);

  // 修复前：没有 error 监听
  const before = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 80)'], { stdio: ['pipe', 'ignore', 'ignore'] });
  let beforeUncaught = null;
  let beforeSync = null;
  const onBefore = (e) => { beforeUncaught = e; };
  process.once('uncaughtException', onBefore);
  try { before.stdin.write(big); } catch (e) { beforeSync = e; }
  await sleep(600);
  process.removeListener('uncaughtException', onBefore);
  ok('修复前以 uncaughtException 击穿进程（证明 bug）', beforeUncaught !== null,
    beforeUncaught ? '→ ' + String(beforeUncaught.code || beforeUncaught.message).slice(0, 48) : (beforeSync ? '（仅同步抛出）' : ''));

  // 修复后：挂 error 监听
  const after = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 80)'], { stdio: ['pipe', 'ignore', 'ignore'] });
  let afterCaught = null;
  let afterUncaught = null;
  let afterSync = null;
  after.stdin.on('error', (e) => { afterCaught = e; });
  const onAfter = (e) => { afterUncaught = e; };
  process.once('uncaughtException', onAfter);
  try { after.stdin.write(big); } catch (e) { afterSync = e; }
  await sleep(600);
  process.removeListener('uncaughtException', onAfter);
  ok('修复后不再 uncaught', afterUncaught === null);
  ok('错误被 error 监听接住或被同步捕获', afterCaught !== null || afterSync !== null,
    afterCaught ? '→ ' + String(afterCaught.code || afterCaught.message).slice(0, 40) : (afterSync ? '→ 同步 ' + String(afterSync.code).slice(0, 30) : ''));
})();

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);