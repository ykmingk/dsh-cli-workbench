/**
 * 用户报的四个 bug 的回归测试（静态断言 + 真实调用）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcIndex = [path.join(BASE, 'index.js'), ...fs.readdirSync(path.join(BASE, 'lib')).filter((n) => n.endsWith('.js')).sort().map((n) => path.join(BASE, 'lib', n))].map((p) => fs.readFileSync(p, 'utf8')).join('\n');
const srcClient = fs.readFileSync(path.join(BASE, 'client.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

console.log('\n[删除会话] 右键菜单没反应');
{
  // 根因：调用了不存在的 setConfirm（状态实际叫 confirmBox）
  ok('不再调用不存在的 setConfirm', !/setConfirm\(/.test(srcClient));
  ok('改为 setConfirmBox', srcClient.includes('setConfirmBox({\n          kind: \'delete\''));
  // 确认框确实被渲染
  ok('确认框有渲染入口', srcClient.includes('confirmBox ? h(ConfirmDialog'));
}

console.log('\n[置顶] 点击后卡顿');
{
  ok('patchSession 支持 railOnly 跳过对话重渲染',
    srcClient.includes('if (!(options && options.railOnly))') && srcClient.includes('{ railOnly: true }'));
}

console.log('\n[打开文件夹] 不可用');
{
  // 不再经过 cmd（会按控制台代码页解释参数，中文路径静默失败）
  ok('Host 不再用 cmd start 打开', !srcIndex.includes("cmd.exe', ['/d', '/s', '/c', 'start"));
  ok('目录/文件走 explorer.exe', srcIndex.includes("spawn('explorer.exe', [value]"));
  ok('URL 走 rundll32 FileProtocolHandler', srcIndex.includes("'url.dll,FileProtocolHandler'"));
  ok('仍拒绝控制字符与引号', srcIndex.includes('/[\\u0000-\\u001f\\u007f"]/'));
  // 客户端失败不再静默
  ok('客户端 /open 有 try/catch', srcClient.includes("catch (error) { showToast('打开文件夹失败：' + error.message); }"));
}

console.log('\n[删除工作区] 删了还在 + 右键没反应');
{
  ok('工作区清单可信度有独立状态',
    srcClient.includes('const [registryReady, setRegistryReady] = useState(false)'));
  ok('统一走 applyWorkspaces', srcClient.includes('const applyWorkspaces = (list) =>'));
  ok('Rail 接收 registryReady', srcClient.includes('sessions, workspaces, registryReady, currentId'));
  // 关键：清单可信时不再按目录伪造「工作区」分组
  ok('清单可信时未登记会话落「未分组」',
    srcClient.includes('else if (registryReady || registry.size) loose.push(session);'));
  ok('删除后重新拉取两个列表',
    srcClient.includes("api('/workspaces').catch(() => null)")
    && srcClient.includes("api('/sessions').catch(() => null)"));

  // 用真实数据模拟分组：清单里没有的目录不该长出「工作区」
  const fakeSessions = [
    { id: 'a', cwd: 'D:\\w1', provider: 'claude', archived: false },
    { id: 'b', cwd: 'D:\\w2', provider: 'claude', archived: false },
  ];
  const group = (sessions, workspaces, registryReady) => {
    const registry = new Map(workspaces.map((entry) => [String(entry.cwd).toLowerCase(), entry]));
    const groups = [];
    const groupOf = (key, cwd, title, workspace) => {
      const found = groups.find((e) => e.key.toLowerCase() === key.toLowerCase());
      if (found) return found;
      const g = { key, cwd, title, workspace, sessions: [] };
      groups.push(g);
      return g;
    };
    const loose = [];
    for (const session of sessions) {
      const entry = registry.get(String(session.cwd).toLowerCase());
      if (entry) groupOf(String(entry.cwd), entry.cwd, entry.title, true).sessions.push(session);
      else if (registryReady || registry.size) loose.push(session);
      else groupOf(session.cwd, session.cwd, 'x', false).sessions.push(session);
    }
    return { groups, loose };
  };

  const withAll = group(fakeSessions, [{ cwd: 'D:\\w1', title: 'w1' }, { cwd: 'D:\\w2', title: 'w2' }], true);
  ok('两个工作区时都归组', withAll.groups.length === 2 && withAll.loose.length === 0);

  const afterDelete = group(fakeSessions, [{ cwd: 'D:\\w1', title: 'w1' }], true);
  ok('删掉一个后：留下的是真工作区', afterDelete.groups.length === 1 && afterDelete.groups[0].workspace === true);
  ok('删掉的那个目录的会话进「未分组」', afterDelete.loose.length === 1 && afterDelete.loose[0].id === 'b');

  const emptyRegistry = group(fakeSessions, [], true);
  ok('删光工作区后不再伪造工作区行（全进未分组）',
    emptyRegistry.groups.length === 0 && emptyRegistry.loose.length === 2);

  const legacyHost = group(fakeSessions, [], false);
  ok('旧版 Host（清单不可信）仍按目录兜底',
    legacyHost.groups.length === 2 && legacyHost.groups.every((g) => g.workspace === false));
}

console.log('\n[新增能力] 工作区可添加 / 可撤销 / 有排查日志');
{
  ok('Host 新增 POST /workspaces', srcIndex.includes("route === '/workspaces' && method === 'POST'"));
  ok('POST 校验目录存在', srcIndex.includes("error: '目录不存在：' + cwd"));
  ok('DELETE 回传被删的那条（供撤销）', srcIndex.includes('removed: known ? { cwd: known.cwd, title: known.title } : null'));
  ok('ensureWorkspace 支持恢复原显示名', srcIndex.includes('ensureWorkspace(dir, titleOverride)'));
  ok('客户端有撤销入口', srcClient.includes("label: '撤销'") && srcClient.includes('restoreWorkspace(removed.cwd, removed.title)'));
  ok('左栏有「把目录添加为工作区」按钮', srcClient.includes("title: '把目录添加为工作区'"));
  ok('操作日志不通过接口暴露',
    srcIndex.includes("logOperation('workspace.add'")
    && !srcIndex.includes("'/log'")
    && !srcIndex.includes('operations.log') === false);
}


console.log('\n[1.0.27] Codex 配置忽略警告不算失败（用户朋友机器实测）');
{
  const srcFormat = fs.readFileSync(path.join(BASE, 'lib', 'format.js'), 'utf8');
  const body = srcFormat.slice(srcFormat.indexOf('function isAdvisoryMessage'), srcFormat.indexOf('function codexFailureText'));
  const advisory = new Function('message', body + '; return isAdvisoryMessage(message);');
  const hers = 'Codex is ignoring 1 unrecognized configuration setting. Check for typos or deprecated settings.'
    + '\nuser (C:\\Users\\Administrator\\.codex\\config.toml): `disable_response_storage` is ignored.';
  ok('她的警告判为提示（右栏运行提示）', advisory(hers) === true);
  ok('单行 is ignored 也判为提示', advisory('user (C:\\x\\.codex\\config.toml): `foo_bar` is ignored.') === true);
  ok('真错误仍然报错', advisory('stream error: connection refused') === false && advisory('Unauthorized') === false);
  ok('两个 error 分支都走白名单',
    (srcIndex.match(/isAdvisoryMessage\(message\)/g) || []).length >= 2);
}
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);