# dsh Workbench 架构 spec

> wayfinder 地图终点产物（[地图 #1](https://github.com/zengsipei/deepseek-harness/issues/1) · [终点票 #11](https://github.com/zengsipei/deepseek-harness/issues/11)）。本文合成地图上全部已关闭票的决议；每节标注来源票号，细节争议回票里查。判据：**交给一个 agent session 即可开工写代码，无需再回来问决策。**
>
> 执行期动作：创建 repo `zengsipei/dsh-workbench`，本文件作为开山文档拷入。

---

## 0. 目标与形态

**产品名 Workbench**。一对 out-of-tree 的 dsh 插件包，在 Windows 原生终端里替代 Claude Code 跑真实编码任务，经由 **Claude Code plugin marketplace 单一入口**消费插件生态（插件内 skills / agents / commands / hooks / MCP 必须能跑）。

**验收场景**（#6，spec 完成后照此验收）：

1. **编码主线**：在一个 TS 仓库修跨 2–3 个文件的 bug —— 读代码 → 改文件 → 跑测试 → 权限审批 → commit，全程不离开 TUI。
2. **插件生态线**：经 marketplace 装用户自有的 `sdlc` 插件（hooks+skills），任务中真实触发其 skill 与 hook。
3. **MCP 线**（#19 M8.7 补）：装一个带 MCP 的插件（如 ecc）→ server 落地 → 模型真实调用一次 `mcp__*` 工具。

**硬约束**：对 fork monorepo `zengsipei/deepseek-harness` 零改动（它每 6 小时自动同步上游）。本仓源码只作为已发布 npm 包的证据库来读。

## 1. 包结构与依赖方向（#7）

| | `@dsh-workbench/host` | `@dsh-workbench/tui` |
|---|---|---|
| 定性 | Workbench 的 host 侧总包，**dsh bundle**（`"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`） | 独立 Node CLI，**非 bundle**；bin 主名 `dsw`、别名 `dsh-workbench` |
| 内容 | ① transport 行自带（restate `dsh-host-webserver` loopback+`listen(0)`、`dsh-host-apiproxy`、`cordis-host-runner`、`connection` node 半边——**不复用 `web-app` bundle**，disable 清单是反向依赖且带前端 dist 死重）② marketplace 家族（§4–§6）③ 运维行：parent-watchdog（stdio 断开自杀）+ 端口 stdout 握手 | 进程内 client runtime（钉死 rc 的浏览器 bundle + shim，§2）+ ink SlotRenderer（§3）+ 输入层/交互（§7）+ 会话入口（§8） |

- **依赖方向**：TUI → host 单向 npm 依赖，exact 钉版；两包 lockstep 同版本一起发，版本矩阵不存在。**host-only 安装成立**：web GUI 用户 `dsh plugin --profile web add @dsh-workbench/host` 即可。
- **repo** `zengsipei/dsh-workbench`，npm org `dsh-workbench`。
- **profile**：名 `workbench`，TUI 全自动管理 `$DSH_HOME/profiles/workbench`（`dsh.profile.bundles = [base, @dsh-workbench/host]` + exact 钉版），升级时同步改写。**用户扩展口 = `profiles/workbench/cordis.patch.yml`**，文档化承诺、TUI 永不改写——用户自有原生 dsh 插件、自有 MCP server（#19 M1）都走这里。
- 后续 host 端能力继续装 host 包，内聚靠内部插件划分，**不开第三包**。

## 2. client 层复用：钉版 + shim（#15 · #18 · #4）

**路线**：复用 dsh client 层（`ui-slots`/`modules`/`connection`/`runtime` 家族），消费**npm 发布产物**。除 `ui-slots`（纯 ESM 零依赖）外产物全是 `window.__ModuleLoader__.load(...)` 浏览器 bundle → TUI 进程内自建 seed 表 + shim 加载。**SDK 栈（`dsh-sdk-*`）已核算否决，不要再提**：无 cancel、approval 双端未实现、无命令分发/会话列表，`handleRequest` 封闭 switch 无扩展点。

**shim 是永久地基**（无上游轨，不提 PR/issue）：

- 钉死精确版本 **`0.1.0-rc.7`**。`latest` dist-tag 是坏的（被 `0.0.1-rc.1` 永久占位），钉版是强制要求。
- **全局垫片恰好两件**（#18 实证）：`window.__ModuleLoader__` + `globalThis.location = {origin, hostname, search:''}`（后者一次解决 `resolveBase()` 回落 / `?fixture` 误触 / loopback 信任三处）。其余零垫片，Node 22+ 原生 fetch/WebSocket 直接用。
- **seed 词表最小集**：六个非 UI bundle 的 externals 封闭集只有 `@deepseek-ai/cordis` + `@deepseek-ai/dsh-client-ui-slots`；react 不在其中。跨 bundle 引用以 `<pkg>/client` 说明符出现，shim require 做别名。
- **加载顺序**：typert → connection → gateway → remotes → runtime；**`modules` 行跳过**（其余 bundle 对 `ClientModuleSystem` 零依赖；`modules` 的 `!== 'web'` 硬编码由 TUI 壳自建 boot 清单绕过）。
- **shim 契约测试随钉版走**（#18 已交付雏形 C1–C5，6/6 绿，[probe](https://github.com/zengsipei/deepseek-harness/tree/research/shim-full-chain/probe)）：断言 bundle wrapper 形状、externals 词表、零 seed miss。升级 = 主动升 rc + 重跑；若某 rc 改了 seam：停在最后可用 rc，最后手段才 vendor 源码。
- `runtime` 的死依赖 `react@^18.2.0` 用 npm `overrides` 消化（React 19 隔离成立，#4/#12：react 不在任何 dsh 包 peerDependencies）。

**进程拓扑**（#15/#13）：TUI 单命令 spawn host 子进程（`dsh --profile workbench` 组装的应用，loopback `/api`），TUI 经 ~90 行 `NodeApiClient extends AbstractApiClient`（`@deepseek-ai/dsh-host-apiproxy` 的 `./client` 导出）+ 同构 `ConnectionController` 连接。carrier 抽象（`IApiClient`）保留 daemon 共享 / in-process 双 root 为后路。

**运维答案**（#13）：

- 生命周期：host parent-watchdog 为主——持有与 TUI 的 stdio 管道，断开即自杀（覆盖 TUI 一切死法；Windows 无父子连坐，不用 Job Object）；TUI 正常退出补显式 kill。
- 端口：`listen(0)` OS 随机分配，host 经 stdout 握手行告知 TUI。
- 多实例：每 TUI 实例自己的 host，实例间不共享。
- 启动时延：TUI 先渲染输入框、host 异步就绪，ready 前输入排队/置灰。

**mux 事实**（#18）：推送流是全会话的（无 per-session 订阅 RPC）；重连时 host 逐字重放未决 approval/question requested 帧（rpcId 复用）→ TUI 崩溃重启的 approval 恢复免费。approval 触发语义 = 沙箱升级，非逐命令确认。

## 3. TUI 渲染：SlotRenderer + ink（#2 · #13 · #16 · #18）

### 3.1 SlotRenderer 接入（#13）

TUI 作为第二个 `SlotRenderer`（唯一成员 `renderRoot(host, ownerProps): ReactNode`）装进 `ui-slots`。全部落插件侧，零本体改动：

- **锚点契约 = 去掉包装节点**，`renderOutletContent` 直接返回子树（web 的 `<div data-slot>` + `display:contents` 是 `web-react` 实现细节，非契约）。
- **可寻址性**：渲染器自持 `key → 节点/元数据` 注册表（纯 JS），**只服务测试寻址**（ink-testing-library 拿 key→输出区间）；不承诺动态样式定位，终端样式走主题 token。
- **string fallback**：渲染器对 string/number fallback 自动包 `<Text>`。
- **overlay chain 显隐**：`display:'flex' ↔ 'none'` 保 fallback 常驻不卸载（保组件 state）；显隐包装容器固定 `flexDirection:'column'; flexGrow:1`。

### 3.2 ink 形态（#16）

- **渲染架构 = inline 滚动流**：历史经 `<Static>` 一次性写进 scrollback，动态区只有尾部（输入框+状态行），不用 alternate screen。fullscreen 被否决（Windows 上每帧命中全清 scrollback 风险）。
- **原版钉死 `ink@7.1.1` + cherry-pick 恰好两个上游 PR**：[ink#917](https://github.com/vadimdemedes/ink/pull/917)（cursorUp 钳制视口高）+ [ink#936](https://github.com/vadimdemedes/ink/pull/936)（eraseScreen 保 scrollback）。`pnpm patch` 管理（`patches/` 提交进 repo，按精确版本 key）。patch 是**有到期日的负债**（上游活跃，有合并前景），与 shim 的永久地基性质相反。
- **发布载具 = bin bundle**：`patchedDependencies` 不随 npm 发布传播 → tui 的 bin 经 tsdown/esbuild 把 patched ink + react + yoga 全 bundle 进产物，ink 退出 `dependencies`。yoga WASM 是 base64 内嵌 JS，无散装资产风险（生态先例 gemini-cli）。
- **升 ink 链路**：重放 patch + 自建 Windows 渲染 gate 重跑 + 重新 bundle；不跟 `x.y.0`。
- **TTY 硬 gate + 薄逃生舱**：显式 `--no-tui` 或 `isTTY === false`（带 prompt 参数自动降级 + stderr 提示一行；无 prompt 报错指路）→ 不起 ink 不开 loopback client，以 dsh 自己的 headless 入口跑同一个 workbench profile，stdio 直通。不做交互式行模式。逃生舱不做恢复（`-c`/`-r` 与 `--no-tui` 互斥报错，#17）。TTY gate 顺带让 terminal-size 62ms 慢路径结构性不可达（不打第三个 patch）。
- **engines `^22.19 || >=24.3`**（Node 24.0–24.2 上 `Shift+Tab` 静默退化裸 `\t`）+ 启动时运行时版本检查：落洞版本打印警告（点名 Shift+Tab 失效）、**不拒启动**。
- 旧 GfW（<2.54.0）不做 `CONIN$`/`CONOUT$` 救援，报错指路「升级 ≥2.54 或 `--no-tui`」。运行时探测 `isTTY`，永不按终端身份推断。

### 3.3 conversation 定义层（#18 + 本票 Q2 裁决）

`ConversationSnapshot.nodes`/`partial` 恒空——节点定义（含 fallback）全在 `ui-conversation`（React web 包，属重写清单）。**裁决：TUI 自带一层 conversation 节点定义**——对照 `ui-conversation` 的节点类型，向 `conversationEvents`/`conversationViews` 注册终端版定义，白拿 `ConversationNodeAssembler`、token 合帧、failure display 等 runtime 投影设施；**不**走 raw event window 自拼（那等于绕开 client 层重造投影逻辑）。节点定义随钉版 rc 走契约测试。

### 3.4 重写清单

`ui-primitives`（react-dom+shiki+katex+micromark）与 30+ `ui-*` React 包全部重写终端对等物（XL，按验收清单裁剪到 v1 所需：conversation 节点、diff 渲染、approval 卡、todo/plan 面板、菜单、状态行）。`ui-input-trigger` 例外：`src/core/`（`detectTrigger`/`menuReduce`/guard-tier/空格回车仲裁）零依赖纯核心直接复用，仅 MenuView 重写（#9）。工具调用渲染尊重 render intent 三态（`generic`/`terminal`/`diff`），默认折叠单行摘要 + 按键展开（展开键位不在六交互内，样式自由，#6）。

## 4. marketplace 能力（#8，D1–D10，零本体改动）

只用公开接缝：`ctx.skills.registerProvider`、`ctx.tools.register`、`ctx.subagents.start`、`settings` namespace、cordis 动态 fiber。

**域模型**：**资产插件**（CC 形态，marketplace 管辖）vs **代码插件**（npm bundle，pnpm 管辖），两入口并列（D4）。**生态名** `plugin:asset` ⇄ **注册名** `plugin-asset`，**双射由台账持有**，不做字符串反拆。**落地** = 经公开接缝注册进运行中的 dsh。**体检** = 能力覆盖报告，只警告不阻止。

- **D1 命名**：注册名 `<plugin>-<asset>`（分隔符仅 `-`）；插件名==资产名时折叠（`impeccable:impeccable`→`impeccable`）。TUI 输入层解析 `/codex:review` 翻译成注册名；provider 正文改写把字面 `plugin:asset` 引用一并改写。跨市场同名插件禁止同时启用（mount 前拒后者）；前缀化二次冲突 mount 前台账检测，后启用者该资产拒载并告知。
- **D2 CC command = TUI 输入层概念**，不进 `ctx.commands`。host 包发现/读取 `commands/*.md`，TUI `/` 菜单并列呈现；选中后 TUI 侧模板展开（`$ARGUMENTS`、`$1..$9` v1 做；`` !`cmd` `` 走 host shell 且每次过 approval；`@path` v1 跳过、体检告知），展开结果作为普通用户消息提交。已知损失：仅 TUI 入口可用、模型不能自主触发。
- **D3 缓存自持 `$DSH_HOME/plugins/`**，镜像 CC 三层布局：`marketplaces/<mkt>/`（git checkout）+ `cache/<mkt>/<plugin>/<ver>/`（**版本目录必须是 installPath 末段**——CC 不变式，插件脚本按路径形状猜）+ `data/<plugin>-<mkt>/`（对应 `CLAUDE_PLUGIN_DATA`）。不复用 `~/.claude/plugins/`（CC 并发写台账 + GC 风险）。`importFromClaudeCode` = 拷贝 CC cache + 生成自持台账（记双射、版本、来源、gitCommitSha）。
- **D5 agents：每 CC agent 一个自写胶水委派工具**（`tool-subagent` 的 description 不可配置，实证）：description=agent 的 `description`、persona=正文、toolFilter=`tools` 逗号串、`agentOptions.model`=`model`（`inherit` 特判）；`maxTurns`/`effort`/`skills:`/`color` 丢弃进体检。
- **D6 `ctx.marketplace` v1 契约面**：`addMarketplace`/`removeMarketplace`/`updateMarketplace`（系统 git pull）/`listMarketplaces`；`browse`/`install`/`uninstall`/`update`/`list`；`enable`/`disable`；`importFromClaudeCode`；`inspect`。不进 v1：catalog 增值数据、blocklist、autoUpdate。`lspServers` → `dsh-lsp-stdio.servers` 纯改形直通（三字段逐字同名）。
- **D7 装/启分离 + 即时生效**：installed 与 enabled 两表分离；enabled 落 `settings` 的 `plugins` namespace。enable/disable 即时 mount/dispose（cordis 动态 fiber）。**hooks 例外**：v1 需重启 host 可接受，体检明示。
- **D8 skills**：per-plugin 一个 provider 实例（单插件坏不拖累别家），全部资产插件同一 rank（与 custom 300 同层）。目录：`plugin.json` `skills[]` 显式挂（array|string 都认），无列表递归探测二层。`get()` 时**正文改写三件套**：`${CLAUDE_PLUGIN_ROOT}` 替换、生态名→注册名、不认 frontmatter 塞 `metadata` + 体检。
- **D10 失败语义**：逐层 fail-soft——单 hooks.json 坏只失效该插件、单 SKILL.md 坏跳过该文件、provider `list()` 抛错保 last-good 下次重试；mount 前冲突检测不让 cordis throw。体检只警告不阻止，输出具体清单；数据源下载前 catalog `components`、下载后扫真实文件。
- **`${CLAUDE_PLUGIN_ROOT}` 统一解析单点，五处**（#8 四处 + #19 扩）：hook 命令串、hook env、skill 正文、command 正文、`.mcp.json`。单独做对、单独测。

## 5. hooks 兼容（#14，深度 M，落点 host 包新 provider）

- **深度 = 本机并集 8 事件**：现桥已有 7（SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/SubagentStart/SubagentStop）+ 补 **SessionEnd / PreCompact / PostCompact**。`args`/`async`/`if` 仍不认。
- **落点**：host 包内新写 hook provider，钉版依赖 `@deepseek-ai/dsh-hook-protocol` 复用 runner/merge/config 原语；不改 `hooks-claude-code`、不提上游 PR。
- **合并**：无配置层合并。per-plugin 独立解析 `hooks/hooks.json`（含 `plugin.json` `hooks` 字段指的非标准路径，如 sdlc 的 `claude-hooks.json`），运行时按插件安装顺序串跑，输出用现成 `mergeHookOutputs` 折叠（deny>ask>allow、首 stop 粘滞）。
- **Pre/PostCompact = 注入型**：订阅 `compaction/start`/`compaction/end` 触发；`additionalContext` 缓冲后在下一次 `agent/pre-step`（waterfall 公开接缝）注入。sdlc 的「存盘摘要→压缩后重注入」续接链完整成立。CC 的「影响压缩本身内容」不做，体检注明。
- **SessionEnd 映射 `agent/disposed`**：TUI 正常退出 = 先 dispose、有界 drain（沿用 hook 自带 timeout）、再 kill host。watchdog 自杀路径不保证执行，文档写明。
- **env 固定两个**：`CLAUDE_PLUGIN_ROOT`、`CLAUDE_PROJECT_DIR`；**严禁 `PLUGIN_ROOT`**（sdlc 靠其存在性判平台，多注即误判）。
- **statusMessage / systemMessage 入范围**：记为 `ignorable: true` 的 session 事件，TUI 订阅渲染（前者运行态提示，后者上浮用户可见消息）。
- 未生效 hook 体检显式报告（「插件 X 有 N 个 hook 未生效（事件 Y / 字段 Z）」），fail-soft 不拒装。

## 6. MCP 接入（#19，M1–M8，零本体改动）

- **M1 摄取源仅已装插件版本目录根 `.mcp.json`**；项目级 `.mcp.json` 范围外；用户自有 server 走 `cordis.patch.yml` 手写 `mcp-client` 行。
- **M2 `plugin.json` `mcpServers` 四态全认**：缺省=自动发现根文件；`{}`=opt-out；非空 object=内联**替代**（不合并）；string=替代文件相对路径。不认形态进体检。
- **M3 命名 `<plugin>-<server>` + 折叠 + 越 32 字符截断到 27+`-`+4 位哈希**（哲学照抄 dsh `publicToolName` 的 64 字符截断+12 位哈希兜底——「超限被网关拒」在 dsh 不发生）。双射与 D1 同一张台账；v1 无 rename（台账预留字段位）。二次冲突后启用者该 server 拒载。
- **M4 `${VAR}` 展开**：域四处（`env` 值、`headers` 值、`url`、`args` 元素）；语法只认 `${VAR}` 与 `${VAR:-default}`（裸 `$VAR` 原样保留+体检）；链 `credentials.resolve` → `process.env` → 默认值；三层全空 → 该 server 不 mount + 体检报缺凭据；mount 时展开一次，凭据变更靠禁/启插件或重启生效。
- **M5 `${CLAUDE_PLUGIN_ROOT}`**：`.mcp.json` 内解析域 = `command`/`args`/`env` 值/`cwd`/`url`/`headers` 值；先路径变量后凭据展开。
- **M6 per-plugin `disabledMcpServers: string[]`**（存生态名）落 settings `plugins` namespace，改 settings 生效。
- **M7 stdio 运行时**：`cwd` 默认插件版本目录根（不继承 host cwd）；env 注入与 hooks 同族（`CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA`/`CLAUDE_PROJECT_DIR`，严禁 `PLUGIN_ROOT`），插件显式 `env` 同名键胜。
- **M8**：落地 = per-server 一个 `mcp-client` 动态 fiber，enable→mount / disable→dispose 即时生效；`failOnStartupError` 强制 `false`，`reconnect`/`toolCallTimeoutMs` 用包默认不透出；fail-soft 单 server 粒度（整文件坏 JSON 只失效该插件 MCP 维度）；`type` 推断：有 `command` 无 `type`→stdio，`http`/`sse`→streamable-http，其余不认；approval 面零新增（MCP 工具与其它工具无差别）。

## 7. 六个锁定交互（#9，四段式：输入事件→API→状态→反馈）

1. **`/`**：触发检测复用 `ui-input-trigger` 纯核心；菜单三来源合流——host `ctx.commands`（`remote.commands.list(sessionId)` RPC，`commands/change` 失效缓存）、CC 模板命令（TUI 展开）、TUI 本地命令（`/quit`/`/resume` 等）。执行：host 命令→`remote.commands.execute`（记 `command/run`/`command/done` log-only）；CC 模板→展开走普通提交；本地→进程内 handler。**撞名裁决 TUI 本地 > host > CC**，败者前缀消歧（`/sdlc:plan`）可达。subagent session 不出命令菜单。
2. **`@`**：文件 source dsh 不存在，**新写**（`InputTriggerSource` + `ReferenceCodec`）。候选 TUI 自扫 cwd（尊重 `.gitignore`，零 RPC）；pick 走 plain-text 路（`PickOutcome.text`，`lexicon` 高亮）；serialize 产**纯路径文本**，模型按需用 fs 工具读。serialize 失败阻止发送。
3. **`Esc`**：分层——菜单开→关菜单（仲裁已有）；turn 在跑→client `session.cancel()` → `sessions.cancel` RPC → host `agent.cancel()`（continuable 子 agent 自动路由 `subagents.interrupt`）。接受默认清空 inbox（不为 TUI 新开 `keepInbox` RPC）；被清消息经 `agent/inbox/discarded` **回填输入框**；`turn/end` 显示已中断。
4. **`Ctrl+C` ×2**：ink `exitOnCtrlC: false` 自管裸 `\x03`（Windows raw mode 无 SIGINT）。第一次对齐 CC：输入非空→清输入；turn 在跑→中断（复用 Esc 链）；全空闲→提示「再按一次退出」；时间窗内第二次→退出。退出编排：TUI 断开 stdio → host watchdog 自杀路径 bounded dispose（SessionEnd hooks 得以运行）→ TUI 超时 `TerminateProcess` 兜底。**Windows 上 `kill('SIGTERM')` = 无条件终止不跑 handler**，stdio 断开就是正常退出通知通道。
5. **`Shift+Tab`**：**纯 plan mode 两态开关（normal ⇄ plan），不模拟 CC 三态**（`ApprovalPolicy` 仅 `ask`/`never`，acceptEdits 无对等物）。API `ctx.planMode.set`（或 execute `/plan`）；idle 立即 commit / 运行中 queue 到下个 pre-step。preset 正交：权限走 `/permissionPresets` 手动切，表不新增项。状态条读 `plan` projection `{active, pending}` + `permissions` projection。
6. **`↑↓`**：dsh 零机制，**TUI 全自建**——跨 session、按 cwd 分组、存 `$DSH_HOME/workbench/history/`（按 cwd 派生文件名）、相邻去重、上限 1000 条。分层：菜单开→选菜单项；多行草稿光标非边界行→移光标；边界行→翻历史（当前草稿暂存，回底恢复）。纯 TUI 本地，不进 session log。

## 8. 会话恢复与历史（#17）

- **入口三件套**：`dsw -c`/`--continue` 续本目录最近可见会话（无可续一行提示后开新）；`dsw -r [id]`/`--resume` 选择器或直达（id 不存在报错退出）；TUI 内 `/resume` 开同一选择器。裸 `dsw` 永远新会话。`-c`/`-r` 互斥，均与 `--no-tui` 互斥。
- **列表**：`session.list` RPC 原样（updatedAt 降序，v1 全量）；默认按当前 cwd 过滤 + 选择器内切全局；隐藏 blank 与 `origin:'subagent'`，fork 显示；行 = title + 相对时间 + running 指示 + fork 标记（全局视图另带 cwd）。
- **标题**：维持 base 的 `session-title-first-prompt-llm` + 确定性 fallback；v1 无 `/rename`。
- **打开 = 只读浏览，首条 prompt 才复活**（apiproxy 惰性语义升为领域语义）：选中 → `session.history` 只读加载（host 不复活 agent）→ 首条新 prompt 才 `agents.resume`，半途 turn 此刻 repair 关闭为 `interrupted`（未答工具调用补合成 error result）。浏览不是独立 UI 态。历史打开即全量加载（循环 `loadOlder` 到头一次渲染；`<Static>` 不能向前插）。
- **崩溃恢复零新机制**：checkpoint-policy 三道屏障 + 200ms write-behind + 冷启 repair 已闭合。
- **底座**：持久化维持 JSONL；`session-projection-cache` 收进 host 包（`writeEveryEvents: 200`/`writeIntervalMs: 5000` 照抄 web-app）；`session-stats` 不挂；通道零新增（全走既有 `session.*` RPC）。
- **已知限制明文**：跨实例 running 盲区——`running` 只反映本 host attach，双实例对同一会话并发写是 host/session 层既有问题，不设防。

## 9. Windows 约束与缓解（#5 + 补充评论 · #16）

- **禁用 East Asian Ambiguous 宽度字符**——`●○`、`→`、`…`、**尤其 box 边框**。`string-width` 恒按 1 列算而 Windows Terminal 有应用侧不可探测的 `ambiguousWidth` 选项。唯一无解项，设计层规避：主题字符集只用无歧义字符。
- **中文 IME 输入自己写缓冲**：ink 的修复只解决候选窗定位（`useCursor()`），输入延迟与丢字仍 open（ink#759，四个社区 PR 全被拒）。中文渲染做得比 CC 好是差异化点（CC #82716 等仍 open）。
- **多行输入与大段粘贴**：Windows 粘贴已知坑，输入层必须处理（bracketed paste + 分帧缓冲）。
- **Git Bash**：GfW ≥2.54.0 删除 winpty 别名、ConPTY 默认开，`winpty node` 反而有害；运行时探测 `isTTY`，不按终端身份推断；旧版不救援（§3.2）。
- **自建 Windows 渲染 gate**：ink 无 Windows CI（7.0.0–7.0.5 曾全 Windows 坏两个月），Git Bash 是上游零测试领域。gate 是 patch 集的契约测试载体，升 ink 必跑。
- `Ctrl+C`/信号语义见 §7.4；engines 与 Shift+Tab 键洞见 §3.2。

## 10. 可观测与面板（#6，做薄）

- 上下文用量一行指示 + cost/token 累计（`token-meter`；`session-stats` 不挂则从事件流自算或省略累计）。
- compaction 发生可见 + `/compact` 可用（`command-compact`）。
- 错误与重试可见（`llm-retry`；服务商强制串行、限流重试是日常路径）。
- hook 执行可见性：跑到哪个 hook、是否阻塞（statusMessage 通道，§5）。
- todo 面板（`tool-todo` projection）、plan 面板（与 `Shift+Tab` 绑定）。
- 子 agent 可见性薄版：「在跑 + 结果摘要」（`subagent.started/finished` + lineage）。

## 11. 验收清单（#6 22 项 + #19 补 1 项）

核心闭环：① 输入→流式输出→工具调用可见 ② 工具折叠/展开 ③ diff 渲染 ④ 权限审批流。
六交互：⑤`/` ⑥`@` ⑦`Esc` ⑧`Shift+Tab` ⑨`↑↓`（`Ctrl+C` 在核心闭环隐含）。
会话：⑩ 恢复 ⑪ 列表 ⑫ 中断与恢复。
可观测：⑬ 用量指示 ⑭ compaction 可见 ⑮ 错误重试可见 ⑯ hook 可见。
面板：⑰ todo ⑱ plan ⑲ 子 agent 薄可见。
输入：⑳ 中文 IME ㉑ 多行与粘贴。
生态：㉒ `CLAUDE.md`/`AGENTS.md` 生效（确切语义在迷雾，v1 按 dsh 既有 system-prompt 机制吃 `AGENTS.md`，不新造）㉓ MCP 插件真实调用一次 `mcp__*`。

**留迷雾（不进 v1，未出范围）**：`!` bash 直通、模型/设置切换、子 agent 完整嵌套转写 UI、`/search` 全文搜索、headless resume、TUI 视觉与布局细节、发布 CI 管线。
**范围外**（永不做，理由见地图）：图片附件、完成通知、CC 历史会话读取、散装 `~/.claude/` 目录、settings.json/permissions 兼容、output styles/statusline/keybindings、逐像素复刻 CC、项目级 `.mcp.json`、会话删除/归档 UI、多实例并发写、改 fork monorepo。

## 12. 「扩展点不堵死」——为工作台演进预留的口子与禁做决策

工作台演进（任务看板 / 定时 / 多 agent 编排，dsh 底座 `jobs`/`schedule`/`goal`/`workflow`）本 spec 不设计，只保证不堵死。**实现时禁止做的决策**：

1. **禁把 `IApiClient`/carrier 假设收窄到「子进程 spawn」**——daemon 共享与 in-process 双 root 是保留后路（#15），任何代码不得依赖「host 一定是我 spawn 的」之外再加假设（watchdog/握手除外，它们就是 spawn 形态的组成部分）。
2. **禁绕过 `ui-slots` 直接硬编码渲染树**——工作台演进的 UI 挂载点就是 `SlotRegistry` + `SessionProvideChannel` hooks/projections；新面板必须走 slot 注册。
3. **禁把 TUI 本地命令做成封闭清单**——`/` 菜单三来源合流结构不得退化为 switch；新来源（如 jobs 面板命令）应能作为第四来源加入。
4. **禁在 host 包外新开第三包**（#7）——host 端新能力（jobs RPC 面等）装 host 包内部插件。
5. **禁让 conversation 定义层写死节点全集**——注册表式（`conversationEvents`/`conversationViews`），新事件类型可后续注册，未知类型走 fallback 渲染。
6. **禁把 `$DSH_HOME/workbench/` 布局承诺给用户**（history 等为 TUI 私有实现细节），唯 `profiles/workbench/cordis.patch.yml` 是文档化用户扩展口、永不改写。
7. **禁新增对 fork monorepo 的任何依赖形态**（workspace 链接、git submodule、相对路径 import）——一切经 npm 钉版。

## 13. 维护税台账（长期义务，随 repo 生活）

| 负债 | 性质 | 触发 | 动作 |
|---|---|---|---|
| `__ModuleLoader__` shim + seed 表 | **永久地基** | 主动升 client rc | 重跑 shim 契约测试（C1–C5 起步）+ conversation 节点定义契约测试 |
| ink 两个 patch | **有到期日**（上游可能合并） | 主动升 ink（不跟 `x.y.0`） | 重放 patch → Windows 渲染 gate → 重新 bundle |
| client 包钉版 `0.1.0-rc.7` | 强制（`latest` 坏死） | 主动升 | 同 shim 行 |
| React 19 `overrides` | 消化 runtime 死依赖 `react@^18.2.0` | 升 rc 时复查 | peerDependencies 复查 |
| engines `^22.19 \|\| >=24.3` + 运行时警告 | Node 键洞 | Node 新版 | 复测 Shift+Tab |
| CC 生态语义漂移（plugin.json/hooks.json 字段） | 跟踪型 | 装新插件体检出不认项 | 体检清单驱动，fail-soft 兜底 |
