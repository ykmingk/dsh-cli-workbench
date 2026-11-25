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
  ok('DELETE 回传被删的那条（供撤销）', srcIndex.includes('removed: { cwd: result.entry.cwd, title: result.entry.title }'));
  ok('ensureWorkspace 支持恢复原显示名', srcIndex.includes('ensureWorkspace(dir, titleOverride, provider)'));
  ok('客户端有撤销入口', srcClient.includes("label: '撤销'") && srcClient.includes('restoreWorkspace(removed.cwd, removed.title, removed.provider)'));
  ok('左栏有「添加工作区」按钮（带文字，不再是无字图标）',
    srcClient.includes("'aria-label': '把目录添加为工作区'")
    && srcClient.includes("h(Icon, { name: 'folder', size: 12 }), '添加工作区'"));
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

console.log('\n[1.0.29] 朋友机器的两个问题：目录选择器 + 打开文件夹 + npm 依赖');
{
  // 1. 目录选择器不再依赖 DSH 的 pickDirectory（browse 后端会报 unavailable）
  ok('浏览优先调系统选择器，失败才回落内建列表',
    /const browse = async[\s\S]{0,400}workspaceApi\.pickDirectory\(\)[\s\S]{0,400}setPicking\(true\)/.test(srcClient));
  ok('存在插件自建的目录选择器组件', /function DirPicker\(/.test(srcClient));
  ok('浏览按钮已接回系统选择器', /const browse = async \(\) => \{/.test(srcClient));
  ok('添加工作区也走自建选择器', /setWsPickerOpen\(true\)/.test(srcClient));
  ok('Host 提供 /dirs 目录列表（只读、只列文件夹）',
    /route === '\/dirs' && method === 'GET'/.test(srcIndex)
    && /if \(!child\.isDirectory\(\)\) continue;/.test(srcIndex));

  // 2. 打开文件夹：路径不存在要明确报错，而不是返回 200 却什么都不发生
  ok('openTarget 先查存在性', /statSync\(value\)/.test(srcIndex) && /reason: 'missing'/.test(srcIndex));
  ok('/open 把失败原因回给界面', /路径不存在：' \+ target/.test(srcIndex));
  ok('detached 子进程接了 error 事件（否则未捕获异常会带走 Host）',
    /child\.on\('error', \(\) => \{ \/\* 打开失败不该影响工作台 \*\/ \}\);/.test(srcIndex));

  // 3. 没有 npm 也要能升级、且不能显示成「检测失败」
  ok('npm 可用性单独探测并缓存', /async hasNpm\(\)/.test(srcIndex));
  ok('没有 npm 时改用 CLI 自带 update', /claude update' : 'codex update/.test(srcIndex));
  ok('版本面板区分「未安装 / 无法检查更新 / 查询失败」',
    /'未安装'/.test(srcClient) && /'无法检查更新'/.test(srcClient) && /'查询失败'/.test(srcClient));
  ok('不再把「查不到最新版」写成检测失败', !/'检测失败'/.test(srcClient));
}

console.log('\n[1.0.31] 插件自带「检查更新」（本地安装没有 DSH 的更新提示）');
{
  ok('Host 有 pluginVersion 接口', /async pluginVersion\(force\) \{/.test(srcIndex));
  ok('版本来源走 jsDelivr 镜像（GitHub 直连在国内常失败）',
    /fastly\.jsdelivr\.net\/gh\/ykmingk\/dsh-cli-workbench/.test(srcIndex));
  ok('只在打开设置时查、缓存 1 小时', /60 \* 60 \* 1000/.test(srcIndex));
  ok('版本比较不能直接比字符串', /function compareVersion\(left, right\)/.test(srcIndex));
  ok('路由已挂载', /route === '\/version' && method === 'GET'/.test(srcIndex));
  ok('设置页显示插件自身版本', /cli-workbench[\s\S]{0,200}检查中|'CLI 工作台',\s*\n\s*h\('span', \{ className: 'cw-upd-badge/.test(srcClient) || /selfVersion/.test(srcClient));
    ok('「去下载」指向 gitcode（GitHub 在国内常打不开）', /gitcode\.com\/yk1900\/dsh-cli-workbench\/releases/.test(srcClient));
  ok('能判断安装形态（目录 / 包）', /const SELF_INSTALL = \(\(\) => \{/.test(srcIndex));
  ok('junction 用 lstat 识别为符号链接', /lstatSync\(dir\)\.isSymbolicLink\(\)/.test(srcIndex));
  ok('/version 返回安装形态', /install: SELF_INSTALL\.kind/.test(srcIndex));
  ok('目录安装才显示命令框（包安装直接点按钮）', /selfVersion\.command && selfVersion\.install !== 'package'/.test(srcClient) && /cw-upd-cmd/.test(srcClient));
  /* 1.0.63 起中间多了「没装 dsh 命令就灰按钮」那一支，窗口放宽到 400 字 */
  ok('包安装提示可自动升级', /selfVersion\.install === 'package'[\s\S]{0,400}这个安装方式支持直接升级/.test(srcClient));
    ok('Host 提供一键升级接口', /async selfUpgrade\(\) \{/.test(srcIndex) && /route === '\/self-upgrade'/.test(srcIndex));
  ok('只对包安装开放自动升级', /SELF_INSTALL\.kind !== 'package'/.test(srcIndex));
  ok('钉了 commit 的地址升级时去掉 commit', /replace\(\/#\.\*\$\/, ''\)/.test(srcIndex));
  /* 1.0.62：超时下沉到 run(command, { timeout })，不再在升级里手搓 Promise.race */
ok('升级有超时保护', /run\(command, \{ timeout: 180000 \}\)/.test(srcIndex)
  && /function timeoutLabel\(ms\)/.test(srcIndex) && /已终止/.test(srcIndex));
  ok('前端点按钮直接调升级接口', /api\('\/self-upgrade'/.test(srcClient));
  ok('升级后提示重启', /请重启 DSH 让新版本生效/.test(srcClient));ok('Host 按安装形态算升级命令', /function updateCommandOf\(install\)/.test(srcIndex));
  ok('自己登记的依赖 spec 从 profile 清单读', /deps\['dsh-cli-workbench'\]/.test(srcIndex));  ok('目录项不被 flex 压缩（目录一多就挤成一团）', /\.cw-diritem\{[^}]*flex: none;/.test(srcClient));
  ok('按钮文字不换行（窄容器里会竖排）', /\.cw-btn\{[\s\S]{0,300}white-space: nowrap;/.test(srcClient));
  ok('按钮行放不下时换行而不是压字', /flexWrap: 'wrap', gap: '6px', marginTop: '8px'/.test(srcClient));
  ok('浏览优先弹系统选择器', /workspaceApi\.pickDirectory\(\)/.test(srcClient));
  ok('系统选择器不可用才回落内建列表', /catch \{ \/\* 没有 native 选择器，走下面的内建列表 \*\/ \}/.test(srcClient));
  const readme = fs.readFileSync(path.join(BASE, 'README.md'), 'utf8');
  ok('README 写了 EPERM 迁移提示', /ERR_PNPM_EPERM/.test(readme));
  ok('README 说明更新来源与隐私', /唯一的外部请求/.test(readme));
  ok('README 只保留仓库地址一种安装方式', /### 用仓库地址安装/.test(readme) && !/### 从本地目录安装/.test(readme) && !/npm pack/.test(readme));
  ok('README 写明能一键升级', /立即升级/.test(readme));
}
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);