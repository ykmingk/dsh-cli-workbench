# 版本兼容矩阵

CLI 工作台把三个**独立发行、独立升级**的东西粘在一起：DeepSeek Harness（DSH）、Claude Code、Codex。任何一方升级都可能改掉插件依赖的接口。这份文档说清楚：依赖哪些接口、在哪些版本上实测通过、升级后怎么复测、不兼容时插件会怎么表现。

## 一、三道防线

### 1. DSH：安装期硬门槛（机器可读）

`package.json`（插件包根）：

```json
"engines": { "dsh": ">=0.2.2-rc.5 <0.3.0" }
```

- 版本不满足时，DSH 在安装/启用阶段直接拒绝并指出所需范围，不会出现「装上了但打不开」。
- 为什么卡 `<0.3.0`：插件依赖 Host 的 `ctx.webServer.register`、`ctx.effect`、客户端模块加载契约，这些是 0.2.x 的稳定面；0.3 可能改签名。
- 想在更新的 DSH 上先试：用 `plugin_manager` 的 `set_version_exemption` 显式放行（它要求先确认风险）。这是唯一绕过门槛的口子，不会自动放宽。

### 2. Claude Code / Codex：运行期能力探测

插件启动后对每个**已安装**的 CLI 执行 `--version` 和 `--help`，核对它实际会传的参数（清单见第三节）。结果缓存在进程内 10 分钟，升级后（`/upgrade` 成功）立即失效重探。

- 缺**必需**参数 → `compat.ok = false`，「设置 → CLI 版本与升级」标红列出缺哪个、影响什么；打开工作台时提示一次。
- 缺**可选**参数 → 只标「降级」，主流程不受影响。
- 探测的是**参数是否存在**，不是版本号：所以小版本升级只要参数没被删改名就照常工作，不需要改代码，也不需要你逐台机器打补丁。

### 3. Codex 的 Windows 沙箱：单独探测 + 自动修复

Codex 0.170 / 0.171 在非交互的 `codex exec` 里把 Windows 沙箱后端默认解析成 `disabled`。后端不可用时 Codex 拒绝启动**任何**子进程——连只读档位都跑不了命令。

工作台的处理：

1. 跑 `codex doctor`，读 `sandbox backend`；
2. 若为 `disabled`，自动给命令追加 `-c windows.sandbox="unelevated"`（受限令牌沙箱，**不需要管理员**），再跑一次 `codex doctor -c …` 确认这个键真的被识别；
3. 探测结果随 `/status` 返回，界面上显示实际后端；强制项见设置面板的「Codex 沙箱后端」。

分机器行为：

| 机器状态 | 工作台行为 |
|---|---|
| Codex 沙箱本来就正常 | 不追加任何参数，用用户自己的配置 |
| 默认解析成 `disabled` | 自动改用 `unelevated`，实测可读写工作区 |
| `unelevated` 也被策略禁掉 | 只读/工作区写入标灰并说明，提示改用「完全访问」 |
| 用户手动选 `elevated` | 强制 `elevated`（隔离更强，首次运行需管理员授权/UAC） |

另外，工作目录若是 8.3 短路径（`C:\Users\ADMINI~1\...`），unelevated 会因「split writable root sets」拒绝执行；工作台在建会话时用 `realpath.native` 展开成长路径。

## 二、当前实测矩阵

| 组件 | 实测版本 | 平台 | 结论 |
|---|---|---|---|
| DSH | 0.2.2-rc.5 | Windows 10 Pro 19045 | 通过 |
| Claude Code | 2.1.330 | 同上 | 通过（9/9 必需参数） |
| Codex | 0.171.0 | 同上 | 通过（6/6 必需 + 3/3 可选参数；沙箱自动修复为 `unelevated`） |

最近一次复测：**2026-11-23，DSH 从 0.2.2-rc.3 升到 0.2.2-rc.5 之后**。rc.5 的升级指南（`docs/upgrade-guide/`）里没有任何涉及本插件所用接口的条目，实测结论：

- 插件在 desktop profile 里仍是 active，没有 `incompatible-version`（`engines.dsh` 已同步抬到 `>=0.2.2-rc.5`）；
- `node test/run-all.mjs`：251 通过 / 0 失败；
- `GET /cli-workbench/api/status` 正常返回两个 CLI 的版本与探测结果（上表）；
- 在**已安装的插件**上跑通一轮真实会话：建会话 → SSE `snapshot` → 发消息 → 真实 usage → 文件树（130 条）→ 删会话，结束后会话数回到原值。

实测覆盖的功能：

- Claude：双向 `stream-json` 逐字流、真实 usage/费用、MCP 审批链路（弹卡 → 允许 → 工具执行 → `permission_decision`）。
- Codex：`exec --json` 审计条目、`exec resume` 续聊（同一 thread id）、`workspace-write` 下命令 exit 0、`read-only` 下只读命令可执行。
- 沙箱探测：本机 `codex doctor` 报 `disabled`，追加覆盖后 `workspace-write` 实测跑通；未覆盖时确定性失败（同一命令报 `cannot enforce split writable root sets` 或拒绝启动）。
- 附件：Claude 的内联图片实测被模型看到（回答出图中颜色），按路径读到了附件文本；Codex 首轮与 `exec resume` 带 `--image` 都跑通（本机模型无视觉能力，只验参数链路）；`GET /attachment` 回放 200 + 路径穿越 400，删会话后附件目录一起清。
- 接口：`/status`、建会话 → SSE → 发消息 → 结束 → 删会话全链路。

**未实测**：macOS/Linux；插件设置里强制 `elevated` 的完整 UI 路径（命令行已验证 elevated 可写入）。

## 三、插件依赖的具体接口

### Claude Code

| 参数 | 用途 | 缺失后果 |
|---|---|---|
| `--output-format stream-json` | 解析逐字流与 usage | 无法工作（必需） |
| `--input-format stream-json` | 多轮输入 | 无法工作（必需） |
| `--verbose` | 逐字流前置条件 | 无法工作（必需） |
| `--permission-mode <mode>` | 权限档位 | 无法工作（必需） |
| `--permission-prompts host` | 权限请求交给宿主 | 弹不出审批卡（必需） |
| `--permission-prompt-tool …` | 指定 MCP 审批工具 | 弹不出审批卡（必需） |
| `--include-partial-messages` | 真实解码耗时/tok/s | 速度统计消失（必需，缺失即标不兼容） |
| `--mcp-config <path>` | 注册审批 MCP | 弹不出审批卡（必需） |
| `--resume <id>` | 续聊 | 无法续聊（必需） |

另依赖 MCP 约定：`tools/call` 返回 `{ behavior: 'allow' | 'deny', updatedInput | message }`。

另依赖 `stream-json` 用户消息里的图片内容块：`{ type: 'image', source: { type: 'base64', media_type, data } }`（png / jpeg / webp / gif）。图片附件靠它内联进消息；格式改掉会表现为 CLI 报错或图被静默丢掉。普通文件不走这条通道——正文给绝对路径，由 CLI 自己读。

另依赖会话记录的磁盘布局：`<配置目录>/projects/<工作目录编码>/<会话 id>.jsonl` 与同名 `tool-results/` 目录（配置目录默认 `~/.claude`，可用 `CLAUDE_CONFIG_DIR` 改）。Claude 没有「删除会话」命令，工作台删会话就是按 id 删这两个；布局变了只会表现为「删了但记录还在」。

### Codex

| 参数 / 配置 | 用途 | 缺失后果 |
|---|---|---|
| `exec --json` | JSONL 事件流 | 无法工作（必需） |
| `exec resume <thread>` | 续聊 | 无法续聊（必需） |
| `-c approval_policy="never"` | 非交互固定审批策略 | 可能挂起（必需） |
| `--sandbox <mode>` / `-c sandbox_mode=<mode>` | 沙箱档位（首轮/续聊） | 档位失效（运行时传参，不参与探测） |
| `-c windows.sandbox="…"` | Windows 后端覆盖 | 保持原样（探测到才传，运行时可选项） |
| `--skip-git-repo-check` | 非 git 目录可用 | 非 git 目录不可用（必需） |
| `--color never` | 输出稳定 | 解析可能带 ANSI（必需） |
| `--model <id>` | 模型选择 | 用默认模型（运行时传参，不参与 `--help` 探测） |
| `-i, --image <FILE>`（`exec` 与 `exec resume`） | 图片附件 | 图片发不出去（运行时传参，不参与 `--help` 探测） |
| `delete --force <uuid>` / `archive <uuid>` / `unarchive <uuid>` | 真删会话、原生归档 | 删除退化为只删索引，rollout 继续占盘；归档退化为软归档（运行时传参，不参与探测） |
| `-c approval_policy="never"` | 非交互固定审批策略 | 可能挂起（运行时传参，不参与探测） |
| `archive` / `unarchive` / `delete` | 真归档删除 | 降级为软归档（可选） |

> **探测口径**：`--help` 探测只核对上表标「必需」的 6 项
> （`--json`、`--sandbox`、`--skip-git-repo-check`、`--color`、`--config`、`resume`）。
> 标「运行时传参」的几项不参与探测——它们是启动时按会话设置拼进命令行的，不在
> `--help` 的稳定性契约里，缺了会以运行时报错的形式暴露，而不是提前判定不兼容。

另依赖事件字段：`thread.started.thread_id`、`item.completed.item.type`（`command_execution` / `file_change` / `agent_message` / `reasoning`）、`item.command`、`item.aggregated_output`、`item.exit_code`、`turn.completed.usage.*`。

### DSH

| 接口 | 用途 |
|---|---|
| `ctx.webServer.register({ kind: 'prefix', path, handler })` | 挂 `/cli-workbench/api` |
| `ctx.webServer.getOrigin()` | 审批回调地址 |
| `ctx.effect(...)` | 生命周期清理 |
| bundle patch + `dsh.client` | 注册侧栏入口与主视图 |
| 客户端 `window.__ModuleLoader__.load` 契约 | 加载 `client.js` |

## 四、升级后怎么复测（约 5 分钟）

改完 Host 代码记得重装或重启 DSH——已加载的 JS 模块不会自己换。然后按顺序看：

1. `node test/run-all.mjs` 全绿（纯静态断言 + 抽真实源码执行，不启动 DSH、不碰用户的会话数据）；
2. 打开 **设置 → CLI 版本与升级**：两个 provider 都显示版本号与探测结论，缺参数的标红并列出来；
3. 发一条真实消息走完一轮：建会话 → SSE 出字 → 真实 usage → 文件树 → 删会话，结束后会话数回到原值；
4. CLI 的升级按钮（`/upgrade`）成功后探测缓存会被清掉，`/status` 返回的是新版本结果；
5. 插件自己的「立即升级」（`/self-upgrade`）走本机 `dsh plugin add`，所以终端里 `dsh --version` 必须先通。DSH 桌面版**默认不装**这条命令：**应用 → 管理 dsh 命令… → 安装**，然后**重启 DSH**。没装时插件里那个按钮是灰的，底部写明去哪装。

跑真实 `claude` / `codex` 的全链路集成脚本属于开发机上的临时工具，没有放进仓库；上面第 1~3 步已经覆盖能自动化的部分。

## 五、不兼容时的表现（不静默出错）

| 场景 | 现象 | 处理 |
|---|---|---|
| DSH 版本不在范围 | 安装/启用被拒，提示所需范围 | 升级 DSH，或对确切版本显式设 exemption |
| 「立即升级」报 `'dsh' 不是内部或外部命令` | 桌面版没把 `dsh` 装进 PATH（默认不装），跟版本/网络/权限无关 | 应用 → 管理 dsh 命令… → 安装，重启 DSH 后重试 |
| Claude 缺必需参数 | 设置页标红 + 启动提示一次；发消息时报明确的启动错误 | 升级/降级 Claude Code，或改 `CLI_CAPABILITIES` 适配新参数 |
| Codex 缺必需参数 | 同上 | 同上 |
| Codex 缺 `archive` 等可选参数 | 仅标「降级」，归档/删除退化为软操作 | 无需处理 |
| Codex 沙箱不可用 | 只读/工作区写入标灰，说明原因 | 切「完全访问」，或在 Codex 配置/系统策略里启用沙箱 |
| 某个档位在运行中失败 | 审计条目显示真实错误 + 沙箱提示 | 按提示换档位 |
| 图片附件发不出去 | 消息照发、附件说明还在，但 CLI 没收到图 | 检查 CLI 是否还支持 `image` content block / `--image`；普通文件附件不受影响 |

## 六、已知的上游问题

- **`codex doctor` 可能误报健康**（openai/codex#43313）：它能打印后端名，但真正 `CreateProcessAsUserW` 仍可能失败。所以工作台不把 doctor 当唯一判据——真正的失败会以审计条目里的原始错误呈现，并附带换档位提示。
- **elevated 依赖沙箱账户的 Windows profile**：账户没有 profile 目录时 elevated 启动会失败，`unelevated` 不受影响。因此 `auto` 永远不主动选 `elevated`。
- **`codex exec` 的默认后端是 `disabled`**（0.170.0 与 0.171.0 均实测）：这是「工作区写入在本机不工作」的根因，不是用户的配置错误。