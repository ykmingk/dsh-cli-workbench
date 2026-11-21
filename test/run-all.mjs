/**
 * 一次跑完所有回归用例。
 *
 *   node test/run-all.mjs        （或 npm test）
 *
 * 每个用例都是独立脚本，自己打印「结果：N 通过 / M 失败」，这里只负责汇总。
 * 全部是静态断言 + 抽取真实源码执行，不需要启动 DSH，也不碰用户的会话数据。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(dir)
  .filter((name) => name.endsWith('.mjs') && name !== 'run-all.mjs')
  .sort();

let totalPass = 0;
let totalFail = 0;
let broken = 0;

for (const name of files) {
  const result = spawnSync(process.execPath, [path.join(dir, name)], { encoding: 'utf8' });
  const output = (result.stdout || '') + (result.stderr || '');
  const line = (result.stdout || '').split('\n').find((text) => text.includes('结果：')) || '';
  const match = line.match(/(\d+)\s*通过\s*\/\s*(\d+)\s*失败/);
  const pass = match ? Number(match[1]) : 0;
  const fail = match ? Number(match[2]) : 0;
  totalPass += pass;
  totalFail += fail;

  const crashed = result.status !== 0 && fail === 0;
  if (crashed) broken += 1;
  const mark = crashed ? '✗' : fail > 0 ? '✗' : '✓';
  console.log(`${mark} ${name.padEnd(22)} ${line.trim() || '异常退出'}`);
  if (crashed) {
    console.log(output.trim().split('\n').slice(-6).map((text) => '    ' + text).join('\n'));
  }
}

console.log(`\n合计：${totalPass} 通过 / ${totalFail} 失败${broken ? '（' + broken + ' 个脚本异常退出）' : ''}`);
process.exit(totalFail === 0 && broken === 0 ? 0 : 1);
