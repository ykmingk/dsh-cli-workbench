# CLI 工作台 · dsh-cli-workbench

**把本机独立安装的 `claude`（Claude Code）和 `codex`（Codex）两个命令行编程工具，变成一个三栏图形工作台。**

这是一个 [DeepSeek Harness](https://github.com/deepseek-ai) （简称 DSH）插件。装好之后，DSH 左侧栏会出现「CLI 工作台」图标，点进去就是工作台界面——不用再开终端、不用记命令。

> 说明：本插件背后是**你自己机器上**的 `claude` / `codex` 进程，不是云端服务，也不是 DSH 自带的 Claude/Codex 子智能体插件（那两个是 `@deepseek-ai/dsh-subagent-claude-code` / `-codex`）。

## 它解决什么问题

命令行工具很好用，但过程是黑盒：不知道它正在做什么、花了多少钱、改了哪些文件、这一步要不要批准。

工作台把这三件事摊开：

| 栏位 | 内容 |
|---|---|
| 左栏 | 按工作目录分组的会话列表、搜索、新建会话、归档、批量操作 |
| 中栏 | 对话正文（思考与工具过程默认折叠）、逐工具审批卡、执行审计条目 |
| 右栏 | 文件页签与预览、运行状态：真实 token / 费用 / 上下文占用 / 改动文件 |

底部是输入区：任务清单、多行输入、文件引用、斜杠命令、模型与权限档位、发送/停止，以及一行统计读数。

## 安装

### 前提

1. 已安装 **DSH 桌面版**（本插件要求 `engines.dsh` 在 `>=0.2.2-rc.3 <0.3.0` 之间）。
2. 本机已安装并登录 **Claude Code**（`claude` 命令可用）。
3. 本机已安装并登录 **Codex**（`codex` 命令可用）。

两个 CLI 至少要有一个；只装一个也能用，另一个的按钮会显示为不可用。

### 从本地目录安装（推荐，不需要 Git）

1. 在仓库页面点 **下载 ZIP**（不要用 `git clone`），解压到本地任意目录。
2. 打开 DSH → 左侧栏 **插件** → **添加插件**（Add plugin）→ 选择解压出来的 `dsh-cli-workbench` 目录（里面有 `package.json`）。
3. 等待安装完成，插件行显示为已启用。
4. **刷新 DSH 页面**（`Ctrl+R`），左侧栏出现「CLI 工作台」图标。

安装过程会写进当前 profile 的依赖与 bundle 列表，重启 DSH 后依然有效。

### 用仓库地址安装（需要先装 Git）

如果是在 **添加插件** 里直接粘贴仓库地址（`https://…/dsh-cli-workbench.git`），DSH 会把地址交给
pnpm 去 **clone**，这要求本机装有 **Git** 并能在命令行里运行 `git --version`：

- DSH 安装前会先跑一次 `git ls-remote` 探测仓库可读性；没有 Git 时这一步就失败。
- 自建 Git 服务（例如 gitcode）不在 pnpm 的内置托管商列表里，HTTPS 读不到时 DSH 会改试 SSH，
  那还需要配好 SSH 密钥。

所以没装 Git 的机器请用上面的 **下载 ZIP + 选本地目录**，效果完全一样。
另外也可以用 `.tgz` 包安装（`npm pack` 生成的压缩包，同样是本地路径，不经过 Git）。

### 检查它是否真的能用

点开工作台 → 右上角 **设置** → 「CLI 版本与升级」，这里会实时跑 `claude --help` / `codex --help`，核对插件依赖的命令行参数是否还在：

- 全部齐备 → 正常使用；
- 标红缺某项参数 → 你装的 CLI 版本和插件对不上，见下方兼容性说明。

## 使用

1. 点左侧栏「CLI 工作台」。
2. 顶部选 **Claude Code** 或 **Codex**。**这个高亮就是整个界面的范围**：左栏只列这个助手的会话，「新建会话」也只建这个助手。
3. 选一个工作目录（可以调系统目录选择器）。同一个目录下，两个助手可以各自有会话，互不混排。
4. 描述任务，`Enter` 发送，`Shift+Enter` 换行。还没有会话时直接输入回车，会用当前助手建一个会话，并把这句话作为第一句。
5. Claude 需要权限时会弹审批卡：**允许本次 / 本会话都允许 / 拒绝**（可写理由，超时自动拒绝）。Codex 没有审批通道，只显示执行后的审计条目。
6. 右栏看真实 token、费用、上下文占用、改动文件与预览。

### 权限档位（让它别再一遍遍问）

每个会话标题栏右侧有「权限：… / 沙箱：…」按钮，点开切换，选完即存：

| Claude Code | 行为 |
|---|---|
| 计划 | 先给方案，不改文件 |
| 默认 | 每个需要权限的动作都问（最啰嗦） |
| 接受编辑 | 改文件不问，其它动作仍可能问 |
| **自动** | 由 CLI 分类器判断，**实测 0 次弹卡，日常推荐** |
| 跳过 | 零询问，全部直接执行 |

| Codex | 行为 |
|---|---|
| 只读 | 可读、可跑只读命令，写入被拒 |
| 工作区写入 | 沙箱内读写工作区，系统其它位置被拒 |
| 完全访问 | 跳过沙箱，命令与写文件都直接执行 |

「所有新会话」的默认档位在设置面板里配，存进插件自己的配置文件，不影响 CLI 的全局配置。

## 两个 CLI 的真实差异

工作台不假装两者一样：

| | Claude Code | Codex |
|---|---|---|
| 输出 | 逐字流式 | item 级整段到达 |
| 审批 | 逐工具审批，卡片三个动作真实生效 | 没有审批通道，只有执行后审计条目 |
| 恢复 | `session_id` + `--resume` | `thread_id` + `codex exec resume` |
| 归档 | 插件内软归档 | 原生 `codex archive` / `unarchive` |
| 费用 | `total_cost_usd` 真实上报 | 只上报 token，**不编造费用** |

## 兼容性

插件套着三个会各自独立升级的东西：DSH、Claude Code、Codex。任何一方升级都可能改掉接口，所以做了三层防护：

| 层 | 机制 | 不兼容时的表现 |
|---|---|---|
| DSH | `package.json` 的 `engines.dsh` | 安装或启用时被 DSH 直接挡下并说明原因，不会装上一个跑不起来的插件 |
| Claude Code | 运行时跑 `claude --help`，核对 9 个必需参数 | 「设置 → CLI 版本与升级」标红列出缺哪个参数 |
| Codex | 核对 6 个必需 + 3 个可选参数，并单独探测 Windows 沙箱后端 | 缺必需参数标红；缺可选参数只标「降级」 |

探测是**运行时**做的，不写死版本号：小版本升级只要参数没变就照常工作，不需要改代码。

本插件开发与实测环境：**DSH 0.2.2-rc.3 / Claude Code 2.1.328 / Codex 0.170.0 / Windows 10 19045**。

> macOS 与 Linux 未验证。Windows 之外的平台按 `codex doctor` 的原生结果处理，未做适配测试。

## 数据存在哪

插件的数据都在 DSH 的数据目录下，不会碰 CLI 的全局配置：

```
<数据目录>/cli-workbench/
├── state.json        工作区清单与时间戳
├── sessions/         一个会话一个文件（<会话 id>.json）
├── settings.json     新建会话的默认权限 / 沙箱档位
├── operations.log    增删操作的排查日志（只在排查时看，界面不显示）
└── mcp/              Claude 审批桥运行时的临时配置
```

**一个会话一个文件**：改一个会话只重写它自己那份，单个文件损坏也只丢那一个会话。
从旧版本升级时，原来的 `sessions.json` 会被自动迁移，并改名成
`sessions.json.migrated-<时间>` 保留，不删除——想回退，把它改回 `sessions.json` 即可。

`operations.log` 每行一条 JSON，记录启动、工作区的新增 / 移除 / 改名、会话的新建 / 删除，
超过 256KB 自动只留最近 500 行。出问题想知道「这行怎么没了」时，直接看这个文件。

`<数据目录>` 按启动方式不同，可能是 `<DSH profile 目录>`，也可能是 `~/.dsh`。
工作台「设置 → 数据存放位置」会直接显示当前用的是哪一个。

这里只存**索引与界面状态**：对话本体始终在 CLI 自己的记录里
（Claude：`~/.claude/projects`，Codex：`~/.codex/sessions`），所以这个目录即使丢了，
对话也不会丢，在终端里 `claude --resume` 照样能接上。

它**不**写 `~/.claude/settings.json`、`~/.codex/config.toml`，也不配置 API Key、Base URL 或代理——那些仍然是你 CLI 自己的事。

> 界面语言：当前只有中文。`locale/*.json` 覆盖的是插件市场里显示的标题与简介，
> 界面文案不读它。

## 开发与本地调试

插件是纯 JS，无构建步骤：

```
index.js              Host 半：会话/工作区/路由/存储/审批/文件 API
lib/claude.js         Claude 适配器：启动参数 + stream-json 事件解析
lib/codex.js          Codex 适配器：codex exec --json 启动参数 + 事件解析
lib/format.js         把两个 CLI 的原始事件变成人能看懂的一行话
lib/util.js           无状态小工具（时间、id、路径、子进程、取值集合）
client.js             客户端半：三栏界面（React.createElement + 自绘 CSS）
mcp-permission.mjs    Claude 权限请求 → 工作台审批卡 的 MCP 桥
cordis.patch.yml      bundle 行声明
locale/*.json         插件标题与描述（zh / en）
docs/DETAIL.md        插件市场详情页正文
test/                 回归用例（node test/run-all.mjs）
```

改完 `index.js` 或 `client.js` 后，**已加载的 JS 模块不会自动换**：需要在插件页把本插件卸载再装一次，或重启 DSH。改 `locale`、`docs` 这类静态资源则刷新页面即可。

Host 侧的 HTTP 接口前缀是 `/cli-workbench/api`，本地联调时可以直接访问，例如：

```
http://127.0.0.1:<DSH 端口>/cli-workbench/api/status
```

返回两个 CLI 的版本与兼容性探测结果。

## 测试

回归用例在 `test/`，纯 Node、无依赖、不需要启动 DSH，也不会碰你的会话数据：

```bash
node test/run-all.mjs     # 或 npm test
```

每个用例自己打印「结果：N 通过 / M 失败」，`run-all.mjs` 汇总；有任何失败时退出码为 1。

用例的写法和普通单测不同：它们**从 `index.js` / `client.js` 里抽出真实源码再执行**（而不是复制一份逻辑），所以改实现时测试会跟着变，不会出现「测试过了但代码早就不是一个东西」。断言覆盖协议解析、路径边界、状态机、以及一批「本来会坏」的写法。

## 许可证

[MIT](LICENSE)。

## 反馈

Issues：<https://gitcode.com/yk1900/dsh-cli-workbench/issues>

提问题时请附上：DSH 版本、`claude --version`、`codex --version`、操作系统，以及工作台「设置 → CLI 版本与升级」里标红的内容（如果有）。
