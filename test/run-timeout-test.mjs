/**
 * `run()` 的超时保护（1.0.62）。
 *
 * 以前 `run()` 没有超时：`codex doctor`、`codex delete`、`npm view` 卡住时会把
 * HTTP 请求一直挂住，Host 卸载也来不及收尾。现在默认 5 分钟、可按命令覆盖，
 * 超时用 killTree 连子进程一起收掉。
 */
import { run } from '../lib/util.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

const sleep = 'ping -n 8 127.0.0.1 >nul';

console.log('\n[1] 超时会终止命令');
{
  const started = Date.now();
  const result = await run(sleep, { timeout: 400 });
  const elapsed = Date.now() - started;
  ok('返回非 0', result.code === -1, String(result.code));
  ok('stderr 里说明超时', /超时 .* 秒，已终止/.test(result.stderr), JSON.stringify(result.stderr.slice(-40)));
  ok('没有等命令自己跑完（<3s）', elapsed < 3000, elapsed + 'ms');
}

console.log('\n[2] 普通命令不受影响');
{
  const result = await run('echo hi');
  ok('正常退出、拿到输出', result.code === 0 && /hi/.test(result.stdout), JSON.stringify(result.stdout.trim()));
  ok('没有超时提示', !/超时/.test(result.stderr), JSON.stringify(result.stderr));
}

console.log('\n[3] 调用方可以自己调大超时');
{
  const result = await run(sleep, { timeout: 20000 });
  ok('给足时间就正常结束', result.code === 0, String(result.code) + ' / ' + JSON.stringify(result.stderr.slice(-30)));
}

console.log('\n[4] 接线');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const utilSrc = fs.readFileSync(path.join(root, 'lib/util.js'), 'utf8');
  const indexSrc = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  ok('run() 有默认超时常量', /const timeout = Number\(options\.timeout\) > 0 \? Number\(options\.timeout\) : 5 \* 60 \* 1000/.test(utilSrc));
  ok('超时会 killTree', /killTree\(child\)/.test(utilSrc));
  ok('升级走 3 分钟超时', /run\(command, \{ timeout: 180000 \}\)/.test(indexSrc));
  ok('升级里不再手搓 Promise.race 超时', !/Promise\.race\(\[run\(command\)/.test(indexSrc));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);