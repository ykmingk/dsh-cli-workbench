/**
 * 1.0.43 的四处界面收敛（用户逐条点名）：
 *
 *  1. 设置里「技能与计划模式」那段说明是写给设计者自己看的，删掉；
 *  2. 已发出的消息要有「复制 / 修改」——修改是把文字放回输入框，CLI 转录不改写；
 *  3. 左栏顶部那枚无字文件夹图标改成带文字的「添加工作区」；搜索框一直露着，
 *     重复的「聚焦搜索」图标按钮去掉；
 *  4. 批量删除的确认框不再列会话标题（列不全还撑高），只报数量。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcClient = fs.readFileSync(path.join(rootDir, 'client.js'), 'utf8');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

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

console.log('\n[1] 设置：删掉「技能与计划模式」说明');
{
  ok('设置里不再有这一节', !srcClient.includes('技能与计划模式'));
  ok('那句只有设计者关心的说明也删了', !srcClient.includes('打开计划后，下一条消息只出方案、不改文件'));
  /* 计划模式本身没删：胶囊按钮和 tooltip 还在，只是不再在设置里复述一遍。 */
  ok('计划模式按钮仍在输入框', srcClient.includes("h('span', { className: 'cw-pill-text' }, '计划')"));
}

console.log('\n[2] 已发出的消息：复制 / 修改');
{
  ok('用户消息有「复制这条消息」', srcClient.includes("'aria-label': '复制这条消息'")
    && srcClient.includes("copyText(item.text, '已复制这条消息')"));
  ok('用户消息有「修改这条消息」', srcClient.includes("'aria-label': '修改这条消息'")
    && srcClient.includes('editUserMessage(item)'));
  ok('助手回复也能复制', srcClient.includes("'aria-label': '复制这条回复'")
    && srcClient.includes("copyText(item.text, '已复制这条回复')"));
  ok('按钮悬停才显形，不抢正文', /\.cw-msg:hover \.cw-msg-acts/.test(srcClient)
    && /\.cw-msg-acts:focus-within/.test(srcClient));

  const block = sliceBlock(srcClient, 'const editUserMessage = (item) =>');
  ok('抽到 editUserMessage', Boolean(block));
  /* 1.0.49 起输入框是 contenteditable：回填后放光标用的是 Range/Selection，不再是 setSelectionRange */
  const make = () => new Function(
    'setDraft', 'showToast', 'editorRef', 'setTimeout', 'window', 'document',
    block + '; return editUserMessage;',
  );

  const seen = [];
  const toasts = [];
  const area = { focused: 0, focus() { this.focused += 1; } };
  const range = { collapsed: null, selectNodeContents(target) { this.target = target; }, collapse(value) { this.collapsed = value; } };
  const selection = { added: null, removeAllRanges() { this.removed = true; }, addRange(value) { this.added = value; } };
  const fakeWindow = { getSelection: () => selection };
  const fakeDocument = { createRange: () => range };
  const edit = make()((value) => seen.push(value), (text) => toasts.push(text), { current: area }, (fn) => fn(), fakeWindow, fakeDocument);
  edit({ text: '帮我改一下这段' });
  ok('修改：正文回填输入框', seen.length === 1 && seen[0] === '帮我改一下这段');
  ok('修改：光标落到末尾', area.focused === 1 && range.collapsed === false && selection.added === range);
  ok('修改：说清楚是发新消息，不是改历史', /新消息/.test(toasts.join('')) && !/已删除|已替换/.test(toasts.join('')));

  const seen2 = [];
  const edit2 = make()((value) => seen2.push(value), () => {}, { current: area }, (fn) => fn(), fakeWindow, fakeDocument);
  edit2({ text: '', attachments: [{ name: 'a.png' }] });
  ok('只有附件的消息不会把输入框清空', seen2.length === 0);
}

console.log('\n[3] 左栏顶部：一枚带字的「添加工作区」');
{
  ok('按钮有可见文字', srcClient.includes("h(Icon, { name: 'folder', size: 12 }), '添加工作区'"));
  ok('tooltip 说明什么时候会自动出现', srcClient.includes('在里面建过会话的目录会自动出现'));
  ok('重复的「聚焦搜索」图标已去掉', !srcClient.includes("title: '搜索', onClick: () => { const input = document.querySelector('.cw-search input')"));
  ok('搜索框本身还在（一直露着）', srcClient.includes("placeholder: '搜索会话或路径'"));
  ok('样式是带字的小按钮，不是 28px 图标', /\.cw-rail-add\{/.test(srcClient) && /\.cw-rail-add:hover/.test(srcClient));
}

console.log('\n[4] 批量删除：确认框只报数量');
{
  const block = sliceBlock(srcClient, 'const askDeleteSessions = (list) =>');
  ok('抽到 askDeleteSessions', Boolean(block));
  ok('不再传 names', Boolean(block) && !/names\s*:/.test(block));
  ok('多选标题报数量', /'删除 ' \+ ids\.length \+ ' 个会话'/.test(block || ''));
  ok('渲染时也不再读 confirmBox.names', !srcClient.includes('names: confirmBox.names'));
  ok('批量正文不逐条列，只说「这些会话」', srcClient.includes("'这些会话的聊天记录、附件，以及 CLI 那边的会话文件都会删掉，无法恢复；项目文件不受影响。'"));
  ok('不再说「改动记录」（代码改动不会被回滚）', !srcClient.includes('转录与改动记录会一起删除'));
  ok('明说项目文件不受影响', srcClient.includes('项目文件不受影响'));
  ok('单条也用自己的语义，不是 DSH 文案', srcClient.includes("'这个会话的聊天记录、附件，以及 CLI 那边的会话文件都会删掉，无法恢复；项目文件不受影响。'"));
  ok('确认框不再有标题列表结构', !srcClient.includes('cw-confirm-list'));
  ok('ConfirmDialog 里没有 names 参数了', !/function ConfirmDialog\(\{[^}]*names/.test(srcClient));
  ok('按钮仍报数量（删除 14 个）', /'删除 ' \+ confirmBox\.ids\.length \+ ' 个'/.test(srcClient));
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);