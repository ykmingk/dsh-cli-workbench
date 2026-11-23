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
  .filter((name) => name.endsWith('-test.mjs'))
  .sort();

let totalPass = 0;
let totalFail = 0;
let broken = 0;

for (const name of files) {
  const result = spawnSync(process.execPath, [path.join(dir, name)], { encoding: 'utf8' });
  const output = (result.stdout || '') + (result.stderr || '');
  /* 取**最后一条**汇总行：用例自己的章节标题里也可能出现「结果：」，
     按「第一处匹配」或按行号找会被那些标题带偏（曾经把 21 项误报成 0 项）。 */
  const matches = [...output.matchAll(/结果：\s*(\d+)\s*通过\s*\/\s*(\d+)\s*失败/g)];
  const last = matches.length ? matches[matches.length - 1] : null;
  const pass = last ? Number(last[1]) : 0;
  const fail = last ? Number(last[2]) : 0;
  totalPass += pass;
  totalFail += fail;

  const line = last ? '结果：' + pass + ' 通过 / ' + fail + ' 失败' : '';
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
