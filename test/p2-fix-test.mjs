/**
 * P2 修复验证。静态断言 + 对可抽取的函数做真实执行。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcIndex = fs.readFileSync(path.join(BASE, 'index.js'), 'utf8');
const srcClient = fs.readFileSync(path.join(BASE, 'client.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(BASE, 'package.json'), 'utf8'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

const extract = (source, signature) => {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error('找不到 ' + signature);
  let i = source.indexOf('{', start);
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start + signature.length, i); }
  }
  throw new Error('括号不配对: ' + signature);
};

/* ------------------------------------------------------- 技能扫描截断标记 */
console.log('\n[P2-15] 技能扫描的层数截断要如实上报');
{
  const body = extract(srcIndex, 'function collectSkillFiles(root, depth) {');
  const collect = new Function('path', 'readdirSync', 'existsSync', 'statSync', 'return function collectSkillFiles(root, depth) {' + body + '}')(
    path, fs.readdirSync, fs.existsSync, fs.statSync,
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-skill-'));
  // skills/a/SKILL.md           → 第 1 层，能收到
  fs.mkdirSync(path.join(root, 'a'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a', 'SKILL.md'), '---\nname: a\n---\n');
  // skills/b/c/SKILL.md         → 第 2 层，能收到
  fs.mkdirSync(path.join(root, 'b', 'c'), { recursive: true });
  fs.writeFileSync(path.join(root, 'b', 'c', 'SKILL.md'), '---\nname: c\n---\n');
  // skills/b/g/skills/x/SKILL.md → 第 3 层且中间层不是技能，超出上限
  fs.mkdirSync(path.join(root, 'b', 'g', 'skills', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'b', 'g', 'skills', 'x', 'SKILL.md'), '---\nname: x\n---\n');

  const result = collect(root, 2);
  ok('返回 files/truncated 两个字段', Array.isArray(result.files) && typeof result.truncated === 'boolean');
  ok('第 1、2 层都收进来', result.files.length === 2, '→ ' + result.files.length);
  ok('超过层数时标 truncated', result.truncated === true);

  const shallow = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-skill2-'));
  fs.mkdirSync(path.join(shallow, 'x'), { recursive: true });
  fs.writeFileSync(path.join(shallow, 'x', 'SKILL.md'), 'name: x\n');
  const r2 = collect(shallow, 2);
  ok('没有更深层时不误报', r2.truncated === false && r2.files.length === 1);

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(shallow, { recursive: true, force: true });
}

/* --------------------------------------------------------------- 静态断言 */
console.log('\n[P2] 各项改动是否就位');

// P2-1 错误边界
ok('P2-1 有 ErrorBoundary 并用它包住 App',
  srcClient.includes('class WorkbenchBoundary extends React.Component')
  && srcClient.includes('h(WorkbenchBoundary, null, h(App))')
  && srcClient.includes('}, GuardedApp));'));

// P2-2 归档回退按 provider
ok('P2-2 archive 回退按助手过滤',
  /const next = sessions\.find\(\(item\) => item\.id !== id && !item\.archived\s*\n\s*&& \(item\.provider \|\| 'claude'\) === topProvider\)/.test(srcClient));

// P2-3 全选只勾可见
ok('P2-3 全选改用可见集合', srcClient.includes('selectAll(selectable)') && srcClient.includes('const selectable = allVisible.filter'));

// P2-4 批量删除逐条容错
ok('P2-4 批量删除逐条 try', srcClient.includes("catch (error) { failed.push({ id, message: error.message }); }"));

// P2-5 首条消息失败回填草稿
ok('P2-5 建会话失败回填草稿', srcClient.includes('if (!created) {') && srcClient.includes('setDraft(composed);'));
ok('P2-5 首条消息失败回填草稿', srcClient.includes('setDraft(prompt);'));

// P2-6 内联组件改渲染函数
ok('P2-6 浮层改用渲染函数（不再创建新组件类型）',
  srcClient.includes('renderPickerPop()') && srcClient.includes('renderModelMenu()')
  && !srcClient.includes('h(PickerPop)') && !srcClient.includes('h(ModelMenu)'));

// P2-7 审批事件只改本条
ok('P2-7 审批事件不再展开旧会话对象',
  !srcClient.includes('mergeSession(list, { ...(currentSessionRef.current || {})')
  && srcClient.includes('pendingCount: typeof event.pendingCount === \'number\''));

// P2-8 拖拽监听卸载清理
ok('P2-8 拖拽监听有卸载清理', srcClient.includes('dragCleanupRef.current = onUp'));

// P2-9 advisories 回读 + liveThinking 清除
ok('P2-9 advisories 会随文件恢复', srcIndex.includes('advisories: Array.isArray(raw.advisories)'));
ok('P2-9 liveThinking 死字段已清除', !srcIndex.includes('liveThinking'));

// P2-10 archivedAt
ok('P2-10 Host 写入 archivedAt',
  srcIndex.includes('session.archivedAt = body.archived ? now() : null')
  && srcIndex.includes('archivedAt: Number(session.archivedAt) || null')
  && srcIndex.includes('archivedAt: Number(raw.archivedAt) || null'));

// P2-11 reap 定时器
ok('P2-11 reap 定时器 unref 并触发空闲回收',
  srcIndex.includes('session._reapTimer.unref') && srcIndex.includes('if (!this.hasLiveWork()) {'));

// P2-12 技能内置误标
ok('P2-12 内置判定只看第一层', srcIndex.includes('const top = rel && !rel.startsWith(\'..\') ? rel.split(path.sep)[0] : \'\'')
  && !srcIndex.includes("found.dir.includes(path.sep + '.')"));

// P2-13 readBody 按字节
ok('P2-13 请求体按字节计数', srcIndex.includes('bytes += chunk.length') && !srcIndex.includes('data.length > 4 * 1024 * 1024'));
ok('P2-13 超限返回 413', srcIndex.includes("message === 'body too large' ? 413 : 500"));

// P2-14 技能名含点
ok('P2-14 技能令牌正则接受点', srcIndex.includes('[A-Za-z0-9][\\w.-]*'));

// P2-16 审批 404 带原因
ok('P2-16 /approve 404 带 error', srcIndex.includes("error: '审批已失效或已处理（可能已超时）'"));

// P2-17 错误卡标题
ok('P2-17 错误卡按阶段给标题', srcClient.includes("item.phase === '启动' ? 'CLI 启动失败'"));

// P2-18 死路由清理
ok('P2-18 三条死路由已移除',
  !srcIndex.includes("route === '/skills/open'")
  && !srcIndex.includes("route === '/rules/open'")
  && !srcIndex.includes("action === '/events'"));

// P2-20 exports 暴露 docs
ok('P2-20 exports 增加 ./docs/*', pkg.exports['./docs/*'] === './docs/*');

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);