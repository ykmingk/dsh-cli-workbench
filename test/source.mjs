/**
 * 测试用的源码读取器。
 *
 * 用例会「从源码里抽真实函数来执行」，而实现可能被拆到 lib/ 下。
 * 这里把 index.js + lib/*.js 拼成一份文本：断言和抽取都对着它做，
 * 以后再把代码搬到别处，用例不用跟着改路径。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function readIndex() {
  return fs.readFileSync(path.join(BASE, 'index.js'), 'utf8');
}

export function readClient() {
  return fs.readFileSync(path.join(BASE, 'client.js'), 'utf8');
}

/** index.js + lib/*.js（不含 client.js）。 */
export function readServer() {
  const libDir = path.join(BASE, 'lib');
  const libs = fs.existsSync(libDir)
    ? fs.readdirSync(libDir).filter((name) => name.endsWith('.js')).sort().map((name) => path.join(libDir, name))
    : [];
  return [path.join(BASE, 'index.js'), ...libs]
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
}
