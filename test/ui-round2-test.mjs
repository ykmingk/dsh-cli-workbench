/**
 * 本轮五项改动的回归断言（全部静态：这些是渲染层行为，headless 下没有 DOM）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(BASE, 'client.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

console.log('\n[1] 草稿按会话隔离');
{
  ok('草稿改成按 key 存表', src.includes('const [drafts, setDrafts] = useState({});'));
  ok('key 用 currentId（未选会话用 __new__）', src.includes("const draftKey = currentId || '__new__';"));
  ok('展示值取当前会话自己的槽位', src.includes('const draft = drafts[draftKey] || \'\';'));
  ok('setDraft 保留 value/function 两种用法',
    src.includes('typeof updater === \'function\' ? updater(previous) : updater'));
  ok('切会话后输入框高度重算', src.includes('}, [draft, currentId]);'));
  ok('旧的全量 draft state 已不存在',
    !src.includes("const [draft, setDraft] = useState('');\n      const [fileRef"));
}

console.log('\n[2] 模型菜单去掉自定义模型');
{
  ok('不再有自定义模型列表', !src.includes('customModelList'));
  ok('不再有「自定义模型…」入口', !src.includes("'自定义模型…'"));
  ok('不再有自定义模型弹窗', !src.includes('addCustomModel') && !src.includes('modelBox'));
  ok('保留默认项', src.includes("onClick: () => setModel('') },"));
  ok('Claude 与 Codex 共用同一套清单渲染', src.includes('(aliasEntries()).map((entry) => h('));
  ok('Codex 读不到目录时没有可选项（不套用 Claude 别名）',
    src.includes("? ['sonnet', 'opus', 'fable'].map((alias) => ({ alias, model: '' }))")
    && src.includes(': [];'));
}

console.log('\n[3] 命令按钮与斜杠命令显示');
{
  ok('斜杠命令标签去掉前导 /（避免 //clear）',
    src.includes("picker.kind === 'slash' ? String(item.label).replace(/^\\//, '') : item.label"));
  ok('工具按钮加宽到 34px', /\.cw-tool\{\s*\n\s*width: 34px;/.test(src));
  ok('工具按钮间距 4px', src.includes('.cw-input-tools{ display: flex; align-items: center; gap: 4px;'));
}

console.log('\n[4] 指令文件显示用户级 + 项目级');
{
  ok('按 tree.rules 渲染多行', src.includes('const ruleRows = (tree && Array.isArray(tree.rules)'));
  ok('按当前助手过滤', src.includes("entry.provider === (session.provider || 'claude')"));
  ok('标明用户级 / 项目级', src.includes("(entry.scope === 'user' ? '用户级 ' : '项目级 ')"));
  ok('各自显示已加载 / 未找到', src.includes("(entry.exists ? ' 已加载' : ' 未找到')"));
  ok('不再只查项目级 memory', !src.includes('tree.memory.agents : tree.memory.claude'));
  ok('区块标题不再是「项目指令文件」', !src.includes("'项目指令文件'"));
}

console.log('\n[5] 别名 → 具体模型');
{
  const idx = fs.readFileSync(path.join(BASE, 'index.js'), 'utf8');
  ok('Host 从 settings.json 的 env 里读映射',
    idx.includes('/^ANTHROPIC_DEFAULT_([A-Z0-9]+)_MODEL$/.exec(key)'));
  ok('Claude 结果里只有 model 与 aliases', idx.includes("const claude = { model: '', aliases: [] };"));
  ok('已废弃的字段不再下发（landed/custom/source）',
    !idx.includes('claude.landed') && !idx.includes('normalizeCustomModels') && !idx.includes('claudeAliasTarget'));
  ok('客户端按 Host 给的清单渲染', src.includes('const aliasEntries = () =>'));
  ok('Claude 读不到映射时退回官方别名', src.includes("currentProvider === 'claude'"));
  ok('菜单里显示具体模型名', src.includes('(entry.model || \'别名\')'));
  ok('本机配置与别名重复时不再单列一行',
    src.includes('&& !models[currentProvider].alias') || !src.includes("'本机配置'"));
  ok('「默认」右侧写出它指向的模型', src.includes("name + ' · 当前' : name"));
  ok('选中项只写「当前」（避免长模型名被截断）',
    src.includes("? '当前'") && !src.includes("name + ' · 当前' : name) : entry.model"));
  ok('模型浮层加宽（533px 起）', src.includes('.cw-pop.cw-model-pop{') && src.includes('min-width: 533px;'));
  ok('宽度用双类选择器，避免被 .cw-pop 覆盖', src.includes('.cw-pop.cw-model-pop{'));
  ok('模型名不换行、超长省略',
    src.includes('.cw-pop.cw-model-pop .cw-pop-item .tail{') && src.includes('text-overflow: ellipsis;'));
  ok('模型名字号与左侧标签同档（13px）', src.includes('font-size: var(--cw-fs-sm); line-height: 18px;'));
  ok('模型名颜色提到正文级', src.includes('font-weight: 400; color: var(--cw-text);'));
  ok('模型浮层相对按钮居中并夹进视口',
    src.includes('ref: modelMenuRef')
    && src.includes('React.useLayoutEffect(() => {')
    && src.includes('let left = (base.width - box.width) / 2;')
    && src.includes('if (left > max) left = max;')
    && src.includes('if (left < min) left = min;'));
  ok('居中不用 transform（避免与 cw-in 的 translateY 打架）',
    src.includes("style: { bottom: 'calc(100% + 6px)', left: '0' }"));

  // 用真实配置文件验一遍解析：环境里定义了哪几个别名，就该出现哪几项
  const settingsFile = path.join(process.env.USERPROFILE || '', '.claude', 'settings.json');
  if (fs.existsSync(settingsFile)) {
    const env = (JSON.parse(fs.readFileSync(settingsFile, 'utf8')) || {}).env || {};
    const expected = Object.keys(env).filter((key) => /^ANTHROPIC_DEFAULT_([A-Z0-9]+)_MODEL$/.test(key));
    ok('本机确实定义了别名映射', expected.length > 0, '→ ' + expected.length + ' 个');
    ok('每个映射都有具体模型名', expected.every((key) => String(env[key] || '').trim().length > 0));
  } else {
    console.log('  · 本机没有 ~/.claude/settings.json，跳过真实配置检查');
  }
}

console.log('\n[6] Codex 模型目录');
{
  const idx = fs.readFileSync(path.join(BASE, 'index.js'), 'utf8');
  ok('Host 读 config.toml 的 model_catalog_json',
    idx.includes('/^\\s*model_catalog_json\\s*=\\s*["\']([^"\']+)["\']/m'));
  ok('相对路径按 ~/.codex 解析', idx.includes('path.isAbsolute(raw2) ? raw2 : path.join(dir, raw2)'));
  ok('只取 visibility=list 的条目', idx.includes("!entry.visibility || entry.visibility === 'list'"));
  ok('slug 作为可选项值、显示名作说明', idx.includes('alias: entry.slug.trim(), model: text(entry.display_name)'));
  ok('Codex 也走同一套渲染', src.includes('(aliasEntries()).map((entry) => h('));
  ok('缺目录时只留默认，浮层收窄', src.includes("? ['sonnet', 'opus', 'fable'].map((alias) => ({ alias, model: '' }))")
    && src.includes("'cw-pop cw-model-pop' + (aliasEntries().length ? '' : ' is-narrow')"));
  ok('模型太多时浮层可滚动', src.includes('max-height: 360px; overflow-y: auto;'));
  ok('窄版最小宽度 268px', src.includes('.cw-pop.cw-model-pop.is-narrow{ min-width: 268px;'));

  // 用真实配置验一遍：目录里有多少条，Host 就该返回多少条
  const dir = path.join(process.env.USERPROFILE || '', '.codex');
  const cfg = path.join(dir, 'config.toml');
  if (fs.existsSync(cfg)) {
    const raw = fs.readFileSync(cfg, 'utf8');
    const match = raw.match(/^\s*model_catalog_json\s*=\s*["']([^"']+)["']/m);
    if (match) {
      const file = path.isAbsolute(match[1]) ? match[1] : path.join(dir, match[1]);
      const list = (JSON.parse(fs.readFileSync(file, 'utf8')).models || []).filter((e) => e && e.slug);
      ok('本机目录条目数 > 1', list.length > 1, '→ ' + list.length + ' 个');
    } else {
      console.log('  · 本机未配置 model_catalog_json，跳过');
    }
  }
}


console.log('\n[1.0.30] 缩放自适应（Windows 125% / 窄窗口）');
{
  ok('输入卡底部行允许换行', /\.cw-input-foot\{ flex-wrap: wrap; row-gap: 6px;/.test(src));
  ok('药丸按钮可收缩、不会撑破整行',
    /\.cw-pillbtn, \.cw-picker\{ flex: 0 1 auto; min-width: 0; max-width: 42vw; \}/.test(src));
  ok('窄窗口下药丸只留图标', /\.cw-pillbtn \.cw-pill-text\{ display: none; \}/.test(src));
  ok('左栏宽度随窗口收敛', /\.cw-rail\{ width: clamp\(196px, 19vw, 250px\); \}/.test(src));
  ok('右栏在窄窗口下收窄', /\.cw-insp\{ width: 244px; \}/.test(src));
  ok('矮窗口少留白', /@media \(max-height: 720px\)/.test(src));
  ok('中栏可压缩（min-width: 0）', /\.cw-main\{ flex: 1; display: flex; min-height: 0; min-width: 0;/.test(src));
  ok('缩放自适应规则排在样式末尾（能覆盖前面的固定尺寸）',
    src.indexOf('.cw-pillbtn .cw-pill-text') > src.indexOf('.cw-dock{'));
}
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);