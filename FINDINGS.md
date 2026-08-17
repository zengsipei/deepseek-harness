# Findings — Claude Code 插件/市场完整规格 × dsh 对等物盘点

调研日期：2026-08-17
证据基准：本机 `C:/Users/zsp/.claude/plugins/` 真实数据（6 个已装插件、6 个 marketplace checkout、255 条 catalog）+ dsh 源码 `F:/zsp/Ai/deepseek-harness`。
官方文档交叉验证：**WebFetch/WebSearch 全程 429（服务不可用），未能取得**。文档侧的唯一间接引用来自 dsh 仓库自己对官方 hook 事件表的比对结论（见 §C.1）。**下文所有 A 面字段均出自本机真实文件，不是从文档抄的。**

标注约定：`[事实]` = 直接读到的文件/代码；`[推测]` = 由证据推出但未直接验证。

---

## 0. 结论先行

### 总工作量档次：**L（floor，可用 v1）～ XL（含 hook 对等）**

- **L** 能拿到：marketplace 获取/缓存/版本/启用开关 + 插件 `skills/` 直接可跑 + 插件 `agents/` 降级为 skill + LSP 直通。这条线上 dsh 已有的 provider 接缝（`ctx.skills.registerProvider`）几乎是为此而生。
- **XL** 是加上：commands 的文件发现与模板展开、hooks 的多插件配置合并与事件补齐、MCP 的 `.mcp.json` 摄取、subagent 的 markdown 定义。其中 hooks 单项就是 L。

规模标定：S = 半天～1 天，单文件改动；M = 2～4 天，一个新包或一次聚焦改造；L = 1～2 周，新子系统 + 接缝变更；XL = 多周，跨包架构变更。

### 最大的三个缺口

**#1 — hooks：本机 4/4 插件都带 hooks，而 dsh 是「单进程单配置文件 + 7/30 事件」**
- dsh 的 `hooks-claude-code` 只支持 7 个事件（`packages/hooks/hooks-claude-code/src/config.ts:11-19`），其 README 自述 **23/30 不支持**，其中 `PreCompact`/`PostCompact`/`SessionEnd` 正是本机 sdlc 和 codex 插件在用的。
- `configPath` 是 **进程级单文件**、load 时读一次（`packages/hooks/hooks-claude-code/src/index.ts:52-53, 104`），`TODO(per-session-hook-config)` 明确挂着。N 个插件各带一个 `hooks/hooks.json`，**当前没有任何合并路径**。
- `${CLAUDE_PLUGIN_ROOT}` 只做命令串替换（`config.ts:57-62`），**不导出为环境变量**；而 ECC 这类插件的 hook 引导脚本直接读 `process.env.CLAUDE_PLUGIN_ROOT`。
- 命令项的 `args`/`async`/`asyncRewake`/`if`/`statusMessage` 全部不认（README「Handler and config support is partial」）——本机真实 hooks.json 里这些字段出现 30+ 次。
→ 详见 §D 专章。

**#2 — commands：dsh 侧 0 文件发现，且 CC 的 command 是「提示词模板」而 dsh 的是「JS handler」，是两种东西**
- `ctx.commands.register()` 只接受 `handler: (invocation) => CommandResult`（`packages/interaction/commands/src/index.ts:40-55`），全仓 7 处调用点全是插件代码硬编码。
- 本机 marketplaces 里 **463 个 command `.md`**，其中 187 个用 `$ARGUMENTS`、12 个用 `$1`、4 个用 `` !`cmd` `` 内联执行、55 个引用 `${CLAUDE_PLUGIN_ROOT}`。这些语义 dsh 一个都没有。
- 命名冲突：dsh `COMMAND_NAME = /^[a-z][a-z0-9_-]*$/`（`commands/src/index.ts:25`）不含冒号，`parseCommand` 同样（`:103`）。CC 的插件命令是 `/codex:review` 形态 —— **语法层面就解析不了**。

**#3 — 命名空间与获取层：dsh 全仓 0 处 marketplace 概念，且 skill 名是扁平强校验的**
- 全仓 grep `marketplace` 只命中 3 个无关文件（一个 e2e 测试、一个 note）。没有 git clone、没有 catalog、没有版本锁、没有 blocklist、没有 enable/disable。
- dsh `SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/`（`packages/skill/skill/src/index.ts:20`）**禁止冒号**，而 CC 运行时把插件技能暴露为 `mattpocock-skills:diagnosing-bugs`（本会话系统提示可见，一手证据）。
- 冲突是真实的：本机 956 个 `SKILL.md` 里，`impeccable` 这个名字出现 **15 次**，`tdd-workflow`/`coding-standards`/`security-review` 各 9 次。dsh 的同层去重会打一条 warn 然后丢掉 14 个（`packages/skill/skill/src/index.ts:573-581`）。

---

## A 面 —— Claude Code 侧规格（全部来自本机真实文件）

### A.1 `~/.claude/plugins/` 目录布局 `[事实]`

```
C:/Users/zsp/.claude/plugins/
├── known_marketplaces.json        市场注册表
├── installed_plugins.json         已装插件台账（version: 2）
├── plugin-catalog-cache.json      官方 catalog 快照（406 KB / 255 plugin）
├── blocklist.json                 远端黑名单快照
├── .last_inuse_sweep              GC 时间戳（内容：ISO 时间串）
├── marketplaces/<mkt>/            市场仓库 checkout（含 .git）
├── cache/<mkt>/<plugin>/<ver>/    插件实体（按版本分目录）
│   └── .in_use/<pid>              占用标记 {"pid":28692,"procStartFt":"1343..."}
└── data/<plugin>-<mkt>/           插件私有可写数据目录（对应 $CLAUDE_PLUGIN_DATA）
```

关键点：
- **市场 checkout 与插件实体分离**。`marketplaces/<mkt>` 是完整 git 仓库；`cache/<mkt>/<plugin>/<ver>` 是"这一版插件"的物化副本（对 `source: "./"` 的插件，它是仓库的一份完整拷贝，含 `.git`——见 `cache/claude-plugins-official/mattpocock-skills/1.2.3/.git/shallow`，是 shallow clone）。
- **`.in_use/<pid>`** 是引用计数机制：进程启动写 pid + 进程启动时刻（防 pid 复用），`.last_inuse_sweep` 记录上次清理。`[推测]` 用于安全 GC 旧版本目录。
- **`data/<plugin>-<mkt>`**：命名 = `<pluginName>-<marketplaceName>`（本机 4 个：`codex-openai-codex`、`impeccable-impeccable`、`php-lsp-claude-plugins-official`、`sdlc-yuki`），懒创建。codex 插件通过 `CLAUDE_PLUGIN_DATA` 环境变量读它（`cache/openai-codex/codex/1.0.6/scripts/lib/state.mjs:9`）。

### A.2 `known_marketplaces.json` `[事实]`

顶层是 `{ [marketplaceName]: Entry }`：

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `source.source` | `"github"` \| `"git"` | 是 | 两种形态 |
| `source.repo` | `string` | github 时是 | `owner/repo` |
| `source.url` | `string` | git 时是 | 完整 clone URL |
| `installLocation` | 绝对路径 | 是 | 指向 `plugins/marketplaces/<name>`（Windows 反斜杠） |
| `lastUpdated` | ISO 8601 | 是 | 上次拉取时间 |
| `autoUpdate` | `boolean` | 否 | 本机 4/5 为 true；`claude-plugins-official` 没有此字段 |

### A.3 `installed_plugins.json` `[事实]`

```jsonc
{ "version": 2, "plugins": { "<plugin>@<marketplace>": [ Install, ... ] } }
```
键是 `<pluginName>@<marketplaceName>`；值是**数组**（同一插件可多 scope 并存）。

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `scope` | `"user"` \| `"project"` | 是 | 本机 6/6 为 `user` |
| `installPath` | 绝对路径 | 是 | `cache/<mkt>/<plugin>/<version>` |
| `version` | semver 串 | 是 | 也是 installPath 的最后一段 |
| `installedAt` | ISO | 是 | |
| `lastUpdated` | ISO | 是 | impeccable 的 `installedAt`(07-09) ≠ `lastUpdated`(08-10)，说明就地更新不改 installedAt |
| `gitCommitSha` | 40 hex | 否 | 6 个里 5 个有；`php-lsp@claude-plugins-official` 无（`[推测]` 早期安装或非 git 源） |

**版本布局规则**：`installPath` 末段 = `version`，所以同一插件不同版本可共存（本机 `cache/impeccable/impeccable/` 下同时有 `4.0.2` 和 `4.0.4`）。

### A.4 `plugin-catalog-cache.json` `[事实]`

```jsonc
{ "version": 1, "fetchedAt": ISO, "catalog": {
   "generated_at": ISO, "installs_generated_at": ISO,
   "marketplace_sha": "06b2918...",
   "models": ["claude-opus-4-7","claude-sonnet-4-6"],
   "plugins": { "<plugin>@<mkt>": Entry × 255 } } }
```

Entry 字段（255 条全量并集）：

| 字段 | 语义 |
|---|---|
| `plugin` | 插件名（不含 `@mkt`） |
| `tokens` | `{ [modelId]: { always_on, on_invoke } }` —— **按模型分别计的 token 预算**。`always_on` = 常驻提示词开销，`on_invoke` = 调用时开销 |
| `components` | `{ commands[], agents[], skills[], hooks[], mcpServers[], lspServers[] }` |
| `components.skills[]` / `agents[]` / `commands[]` | `{ name, chars: { always_on, on_invoke } }` |
| `components.hooks[]` | **字符串数组，是事件名**（例：`["PreToolUse","PostToolUse"]`） |
| `components.mcpServers[]` | 字符串数组，server 显示名 |
| `unique_installs` | 装机量（做排序/推荐用） |
| `last_updated` | 上游最后更新时间 |
| `marketplace_entry` | **marketplace.json 里那条 plugin entry 的原样拷贝** |
| `version`, `source`, `sha`, `source_sha` | 版本与内容指纹 |

→ **这是"离线目录页"的数据源**。做 TUI 的插件浏览器时，token 预算和装机量是现成的排序依据。

### A.5 `blocklist.json` `[事实]`

```jsonc
{ "fetchedAt": ISO, "plugins": [ { "plugin": "<name>@<mkt>", "added_at": ISO,
                                   "reason": "security"|"just-a-test", "text": "..." } ] }
```
本机两条都是测试数据。`[推测]` 由 Anthropic 远端下发，安装/启用时拦截。

### A.6 `.claude-plugin/marketplace.json` `[事实，8 个真实文件的并集]`

顶层：

| 字段 | 出现 | 必填 | 语义 |
|---|---|---|---|
| `name` | 8/8 | **是** | 市场标识符，就是 `<plugin>@<name>` 里的 name |
| `owner` | 8/8 | **是** | `{ name (8/8), email (5/8), url (1/8) }` |
| `plugins` | 8/8 | **是** | plugin entry 数组 |
| `description` | 5/8 | 否 | |
| `metadata` | 3/8 | 否 | `{ description, version }` —— 与顶层 `description` 是**两种并存的写法** |
| `$schema` | 2/8 | 否 | `https://anthropic.com/claude-code/marketplace.schema.json` |
| `renames` | 1/8 | 否 | 官方独有：`{ "旧名": "新名" }` × 9，插件改名的迁移表 |

plugin entry（官方市场 285 条的并集）：

| 字段 | 必填 | 语义 |
|---|---|---|
| `name` | 是 | 插件名 |
| `description` | 是 | |
| `source` | 是 | **字符串**（仓库内相对路径，如 `"./plugins/codex"`、`"./"`）或**对象**，见下 |
| `author` | 常有 | `{ name, email?, url? }` |
| `version` | 否 | semver。注意 ecc 的 `PLUGIN_SCHEMA_NOTES.md` 声称 plugin.json 的 `version` 是**验证器强制的** |
| `category` | 否 | 官方 14 类：development(119)/productivity(49)/database(38)/monitoring(20)/security(18)/deployment(8)/design(7)/…；14 条无 category |
| `homepage` | 否 | |
| `tags` / `keywords` | 否 | 两种并存写法 |
| `displayName` | 否 | |
| `strict` | 否 | boolean；观察到的都是 `false`。`[推测]` 关闭清单严格校验（配合 `skills` 显式列表使用） |
| `skills` | 否 | 相对路径数组，显式声明技能子目录（如 AMD 的 4 条） |
| `lspServers` | 否 | 见 A.9 |

`source` 对象四种形态（官方 285 条统计：`git-subdir` 84、字符串路径 53、`url` 146、`github` 2）：

```jsonc
{ "source":"git-subdir", "url":"https://github.com/x/y.git", "path":"plugins/z", "ref":"v1.5.5", "sha":"2ed49..." }
{ "source":"url",        "url":"https://github.com/x/y.git", "sha":"d16d1..." }
{ "source":"github",     "repo":"fullstorydev/fullstory-skills", "commit":"1ec58...", "sha":"b2061..." }
"./plugins/codex"        // 字符串 = 市场仓库内相对路径
```
键并集：`source|url|path|ref|sha|repo|commit`。

### A.7 `.claude-plugin/plugin.json` `[事实，46 个真实文件的并集]`

| 字段 | 出现 | 类型 | 语义 |
|---|---|---|---|
| `name` | 46/46 | string | **必填** |
| `description` | 46/46 | string | **必填** |
| `author` | 42/46 | object | `{name, email?, url?}` |
| `version` | 19/46 | string | ecc 的 schema notes 说验证器强制，但真实样本里 27 个没有（codex 有、mattpocock 有、mkt 侧也常有） |
| `keywords` | 8/46 | array | |
| `homepage` | 7/46 | string | |
| `repository` | 5/46 | string | |
| `skills` | 4/46 | **array \| string** | 显式技能路径。impeccable 用 **string** `"./.claude/skills/"`，mattpocock 用 **25 条 array**，sdlc 用 string `"./skills/"`。ecc 的 notes 警告"必须是数组"，但真实数据两种都存在且都能跑 |
| `license` | 3/46 | string | |
| `mcpServers` | 1/46 | object | ecc 用 `{}` 作为**显式 opt-out**，阻止插件根 `.mcp.json` 被自动发现 |
| `commands` | 1/46 | array | `["./commands/"]` |
| `hooks` | 1/46 | string | sdlc 用 `"./hooks/claude-hooks.json"`（因为它的文件名不是标准 `hooks/hooks.json`） |

**约定优于配置（ecc `PLUGIN_SCHEMA_NOTES.md` 一手记录，来自真实安装失败）：**
- `agents` **不是合法字段**，任何形态都会报 `agents: Invalid input`。`agents/*.md` 按约定自动发现。
- `hooks/hooks.json` **v2.1+ 自动加载**；再在 manifest 里声明会报 `Duplicate hooks file detected`。只有非标准文件名（如 sdlc 的 `claude-hooks.json`）才需要声明。
- 插件根 `.mcp.json` **自动发现**。ecc 之所以要 `"mcpServers": {}` opt-out，是因为生成的 MCP 工具名 `mcp__plugin_everything-claude-code_github__create_pull_request_review` 超过 64 字符被网关拒绝。**这条对 dsh 的命名策略是直接约束。**

### A.8 插件内资产目录（46 个插件根的真实统计）

```
.claude-plugin:46  skills:21  commands:16  .mcp.json:16  hooks:11  agents:11
scripts:6  prompts:2  schemas:2  assets:3  docs:3
（另有 .codex-plugin/.cursor-plugin/.kimi-plugin/.qoder-plugin/.grok-plugin —— 多 harness 分发已是既成事实）
```

#### `skills/` —— `SKILL.md` frontmatter（**951 个真实文件**的字段频次）

| 字段 | 频次 | 语义 |
|---|---|---|
| `name` | 951 | **必填**。**100% 是 kebab-case**（我逐个校验过，0 例外） |
| `description` | 951 | **必填**。路由描述，进常驻目录，是 `always_on` token 的来源 |
| `origin` | 496 | 来源标注（非 CC 语义，社区约定） |
| `metadata` | 291 | 开放对象 |
| `version` | 100 | |
| `tools` | 27 | |
| `license` | 26 | |
| `allowed-tools` | 22 | 工具白名单，支持带参模式：impeccable 用 `- Bash(npx impeccable *)` / `- Bash(node .claude/skills/impeccable/scripts/*)` |
| `homepage` | 21 | |
| `user-invocable` | 20 | `false` = 只给模型，不出现在 `/` 命令里（codex 的 3 个内部技能都是 false） |
| `argument-hint` | 15 | 参数占位提示（user-invocable 技能才有意义） |
| `author` / `disable-model-invocation` / `repo` / `tags` / `category` | ≤7 | `disable-model-invocation: true` = 只给人调，不进模型目录 |

技能可以带整棵资源树：impeccable 的 `skills/impeccable/` 下有 `reference/`、`scripts/detector/{browser,cli,engines,node,profile,registry,rules,shared}/`、`scripts/lib/`；codex 的 `skills/gpt-5-4-prompting/references/*.md`。**18/956 个 SKILL.md 正文里引用 `${CLAUDE_PLUGIN_ROOT}`**。

#### `commands/` —— `*.md` frontmatter（**373 个带 frontmatter 的真实文件**）

| 字段 | 频次 | 语义 |
|---|---|---|
| `description` | 373 | **必填**，`/help` 里显示的那行 |
| `argument-hint` | 55 | 例：`'[--wait\|--background] [--base <ref>] [focus ...]'` |
| `name` | 44 | |
| `agent` / `command` | 32 / 32 | |
| `allowed-tools` | 22 | 例：`Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion`（逗号串）或 `[Bash, Read, Write]`（YAML 数组） |
| `subtask` | 20 | |
| `disable-model-invocation` | 19 | true = 只能人手打 `/x`，模型不能自己触发 |
| `allowed_tools` | 9 | 下划线变体（拼写漂移） |
| `hide-from-slash-command-tool` | 2 | |

正文占位语法（463 个 command 文件扫描）：

| 语法 | 用量 | 语义 |
|---|---|---|
| `$ARGUMENTS` | 187 | 命令名之后的**原样全文** |
| `$1`…`$9` | 12 | 位置参数（asana-setup：`` 用户的 Client ID：`$1` ``，并明确"如果 `$1` 非空则替换"） |
| `` !`cmd` `` | 4 | **执行 shell 并把 stdout 内联进提示词**。codex 的 `cancel.md` 整个正文就是一行 `` !`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" cancel "$ARGUMENTS"` `` |
| `@path` | 1 | 文件引用 |
| `${CLAUDE_PLUGIN_ROOT}` | 55 | |
| `${CLAUDE_PROJECT_DIR}` | 0 | 命令正文里没人用（hooks 里才用） |

**语义定性：CC 的 command 是提示词模板 + 可选的 shell 预执行，不是可执行代码。** 展开后作为用户消息进入对话。

#### `agents/` —— `*.md` frontmatter（**362 个真实文件**）

| 字段 | 频次 | 语义 |
|---|---|---|
| `name` | 362 | **必填**，`subagent_type` 的取值 |
| `description` | 362 | **必填**，主 agent 据此决定何时委派（codex-rescue 写 "Proactively use when…"） |
| `model` | 317 | `sonnet` / `inherit` / … |
| `tools` | 309 | 逗号串：`Read, Write, Edit, Bash, Glob, Grep` |
| `color` | 38 | UI 着色 |
| `allowedTools` | 33 | 驼峰变体 |
| `effort` | 23 | `medium` / `high` |
| `maxTurns` | 12 | 硬回合上限（impeccable 用 12/24/30） |
| `is_background` / `codex-name` / `max-turns` / `nickname-candidates` / `initialPrompt` / `run_mode` / `readonly` | ≤4 | 长尾 |
| `skills` | 1 | codex-rescue：`skills: [codex-cli-runtime, gpt-5-4-prompting]` —— **子 agent 预挂技能** |

正文 = 该子 agent 的 system prompt。

#### `hooks/` —— `hooks.json`（**16 个真实文件**）

结构：`{ "description"?, "$schema"?, "hooks": { <Event>: MatcherGroup[] } }`（也接受裸事件映射）。

| 层级 | 字段 | 频次 | 语义 |
|---|---|---|---|
| group | `hooks` | 63 | **必填**，命令项数组 |
| group | `matcher` | 48 | 工具名字面量/正则。`""` 与 `"*"` = 匹配全部 |
| group | `description` / `id` | 45 / 35 | 人读标签（ecc 用 `id: "pre:bash:dispatcher"`） |
| hook | `type` | 67 | **全部是 `"command"`**（16 个文件、67 个 hook，无一例外） |
| hook | `command` | 67 | shell 命令串 |
| hook | `timeout` | 30 | **秒**（codex Stop 用 900，impeccable PostToolUse 用 5、Stop 用 30） |
| hook | `statusMessage` | 14 | UI 状态文案（"Checking SDLC edit boundary"） |
| hook | `async` | 9 | 异步执行 |
| hook | `asyncRewake` / `rewakeMessage` / `rewakeSummary` | 6 / 6 / 6 | 异步唤醒回执 |
| hook | `if` | 5 | 条件执行 |

真实事件用量（本机 16 个文件）：`Stop` 9、`SessionStart` 7、`PostToolUse` 7、`PreToolUse` 4、`UserPromptSubmit` 4、`PreCompact` 3、`SessionEnd` 2、`PostCompact` 2、`UserPromptExpansion` 1、`PostToolUseFailure` 1。
本机 `settings.json` 用户层还用到：`PermissionRequest`、`PostToolUseFailure`、`StopFailure`、`SubagentStart`、`SubagentStop`，且**命令项带 `args` 数组**（`command: conhost.exe` + `args: ["--headless", …]`）。

#### `.mcp.json`（16 个真实文件）—— **两种顶层形态并存**

```jsonc
// 形态 A：裸 server 映射（playwright, github, example-plugin）
{ "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] } }
{ "github": { "type":"http", "url":"https://api.githubcopilot.com/mcp/",
              "headers": { "Authorization": "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}" } } }
// 形态 B：包一层 mcpServers（context7）
{ "mcpServers": { "context7": { "type":"http", "url":"...",
    "headers": { "Authorization": "${CONTEXT7_API_KEY:-}" } } } }
```
注意 headers 里用 **shell 风格变量展开**，含 `${VAR:-default}` 默认值语法。

#### `scripts/` / `prompts/` / `schemas/`（codex 插件独有，无 CC 语义）

**这三个目录不是 CC 规范的一部分**，CC 不发现它们。它们是插件的私有实现，唯一的接入方式是被 `hooks.json` 的 `command` 或 command/skill 正文用 `${CLAUDE_PLUGIN_ROOT}/...` 引用。

- `scripts/`：`codex-companion.mjs`(31 KB)、`app-server-broker.mjs`、`session-lifecycle-hook.mjs`、`stop-review-gate-hook.mjs` + `lib/` 17 个模块。就是插件的真实实现体。
- `prompts/`：`stop-review-gate.md`、`adversarial-review.md`，含 `{{CLAUDE_RESPONSE_BLOCK}}` 这样的**私有模板占位符**（由脚本自己替换，不是 CC 语义）。
- `schemas/`：`review-output.schema.json`，JSON Schema draft 2020-12，脚本用来校验 Codex 的结构化输出。

→ **结论：只要 dsh 能把 `${CLAUDE_PLUGIN_ROOT}` 解析对、能跑 shell、这三个目录零成本自动可用。**

### A.9 `lspServers`（marketplace entry 内联）

```jsonc
"lspServers": { "clangd": { "command":"clangd", "args":["--background-index"],
  "extensionToLanguage": { ".c":"c", ".cpp":"cpp", ".hpp":"cpp", … } } }
```

### A.10 路径变量与环境变量

`${CLAUDE_PLUGIN_ROOT}` = 该插件的 `installPath`（即 `cache/<mkt>/<plugin>/<ver>`）。本机全量扫描的 `CLAUDE_*` 变量用量：

| 变量 | 出现 | 语义 |
|---|---|---|
| `CLAUDE_PLUGIN_ROOT` | 591 | 插件根。**既做命令串替换、也导出为进程环境变量**（ecc 的 hook 引导脚本读 `process.env.CLAUDE_PLUGIN_ROOT`；impeccable 的 hook 用 `${...}` 串替换） |
| `CLAUDE_PROJECT_DIR` | 218 | 项目根 |
| `CLAUDE_SESSION_ID` | 159 | 会话 id |
| `CLAUDE_HOOK_EVENT_NAME` | 55 | hook 进程能从环境读事件名（而非只从 stdin JSON） |
| `CLAUDE_HOOK_DEPTH` | 38 | **hook 递归深度**（impeccable 用它防自触发） |
| `CLAUDE_CONFIG_DIR` | 35 | |
| `CLAUDE_ENV_FILE` | 28 | hook 可 append `export X=Y` 回写会话环境（codex 的 `session-lifecycle-hook.mjs:36-39` 在用） |
| `CLAUDE_PLUGIN_DATA` | 17 | 插件私有可写目录 = `plugins/data/<plugin>-<mkt>` |
| `CLAUDE_TRANSCRIPT_PATH` / `CLAUDE_SKILL_DIR` / `CLAUDE_PLUGIN_MANIFEST` | ≤15 | |

本机 4 个样本插件实际依赖：sdlc 只要 `CLAUDE_PLUGIN_ROOT`；impeccable 要 `CLAUDE_PLUGIN_ROOT` + `CLAUDE_PROJECT_DIR` + `CLAUDE_HOOK_DEPTH`；codex 要 `CLAUDE_PLUGIN_ROOT` + `CLAUDE_PLUGIN_DATA` + `CLAUDE_ENV_FILE` + `CLAUDE_PROJECT_DIR`；mattpocock 只要 `CLAUDE_PROJECT_DIR`。

### A.11 启用 / 禁用 `[事实]`

`C:/Users/zsp/.claude/settings.json:4-10`：

```jsonc
"enabledPlugins": {
  "better-harness@better-harness": true,
  "codex@openai-codex": true,
  "impeccable@impeccable": true,
  "mattpocock-skills@claude-plugins-official": true,
  "php-lsp@claude-plugins-official": true,
  "sdlc@yuki": true
}
```

**装了 ≠ 生效**：`installed_plugins.json`（物化）与 `settings.json:enabledPlugins`（开关）是两张表，键都是 `<plugin>@<mkt>`。本机两表恰好 6:6 一致。

同一 `settings.json:29-56` 还有 `extraKnownMarketplaces`，是 `known_marketplaces.json` 的**声明式副本**（4 条，含 `autoUpdate` + `source`）。`[推测]` settings 是声明源，`known_marketplaces.json` 是运行态缓存（多出 `installLocation` + `lastUpdated`）。

---

## B 面 —— dsh 侧对等物盘点（读代码为准）

### B.1 skills —— **唯一一个"基本对得上"的资产**

`customSkillDirs` **可以直接吃插件的 `skills/` 目录**：
- `packages/skill/skill-filesystem/src/index.ts:250` — `roots.push(...this.customSkillDirs.map(path => ({ path, source: 'custom', rank: CUSTOM_RANK })))`
- 发现规则 `:719-747` `discoverRoot()`：目录 bundle `<name>/SKILL.md` 或平铺 `<name>.md`。**只扫一层**（README："Nested `**/SKILL.md` discovery is deliberately excluded"）。
  → ⚠️ mattpocock 的 `skills/engineering/tdd/SKILL.md` 是**两层**，用 `customSkillDirs: ["<root>/skills"]` 会一个都发现不了。必须按 plugin.json 的 `skills[]` 显式列表逐个挂，或挂到 `skills/engineering`、`skills/productivity` 两个子根。

frontmatter 逐字段对照（`parseSkillFile` `:793-835` + `parseInvocationPolicy` `:992-1002` + `optionalMetadata` `:1031-1037`）：

| CC frontmatter | dsh 认？ | 说明 |
|---|---|---|
| `name` | ✅ 认，且**必填** | 但必须过 `SKILL_NAME=/^[a-z0-9]+(?:-[a-z0-9]+)*$/`。真实数据 951/951 通过 |
| `description` | ✅ 认，必填 | 空串会被拒（`:812-815`） |
| `disable-model-invocation` | ✅ **语义完全一致** | `:996` → `modelInvocable: 值 !== true` |
| `user-invocable` | ✅ **语义完全一致** | `:997` → `userInvocable: 值 !== false` |
| `metadata` | ✅ 认（对象才留） | `:1031-1037` |
| `allowed-tools` | ❌ **静默丢弃** | dsh 无技能级工具白名单概念 |
| `argument-hint` | ❌ 静默丢弃 | |
| `version` / `license` / `homepage` / `author` / `tags` / `category` / `origin` / `tools` | ❌ 静默丢弃 | |
| — | ➕ dsh 独有 `whenToUse` | `:830`，CC 侧无对应 |

**语义冲突（会炸的）**：`rejectLegacyInvocationKey` `:1004-1008` —— 出现驼峰的 `disableModelInvocation`/`modelInvocable`/`userInvocable` **整个技能被丢弃并 warn**。CC 侧真实数据没这么写，暂时安全，但是个雷。

**rank 机制**（`packages/skill/skill-filesystem/src/index.ts:36-40`）：
```
project-dsh 100 < project-agents 200 < custom 300 < user-dsh 400 < user-agents 500 < bundled 600
```
数值**越小越赢**。同层内排序 `packages/skill/skill/src/index.ts:807-811`：`rank → providerOrder → localOrder`。
→ **所有 `customSkillDirs` 都是固定 300，无法按插件区分优先级**。多个 provider 实例（`includeDefaultRoots:false` + 不同 `providerName`）可以借注册顺序分先后，但那是隐式的。
→ 同名冲突处理 `:573-581`：打一条 `skill "X" from custom ignored because a higher-priority skill already exists` 然后**丢弃**。本机 `impeccable` 这个技能名重复 15 次，`tdd-workflow` 9 次。

**用户调用路径已存在**：`packages/skill/tool-skill/src/index.ts:409` `SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g` —— 用户在提示词里打 `/skill-name` 会注入该技能正文（`:177-204`）。这就是 CC 的"user-invocable 技能即斜杠命令"。**但同样不含冒号，`/codex:codex-cli-runtime` 解析不了。**

技能资源基址已就绪：`:217` `resourceBase: { kind: 'directory', path: locator.directory }`，渲染进 `<skill_resources>`（`packages/skill/skill/src/index.ts:196-200`）。**但没有任何 `${CLAUDE_PLUGIN_ROOT}` 替换** —— 18 个 SKILL.md 会把字面量 `${CLAUDE_PLUGIN_ROOT}` 原样喂给模型。

### B.2 commands —— **无文件发现，且模型不同**

- `packages/interaction/commands/src/index.ts:40-55` `CommandDefinition = { name, description, input?, recordInput?, handler }`。**`handler` 是 JS 函数，返回 `CommandResult`，且明确"不发给模型"**（`:53` "Execute against the receiving agent without sending the command to the model"）。
- 全仓 `ctx.commands.register()` 调用点 7 处，全是插件硬编码：`command-compact`、`command-feedback`、`command-goal`、`permission-presets`、`plan-mode`、`session-log-export`。
- `parseCommand` `:102-109`：`/^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u` → `{ name, rawInput }`。**只做"名字 + 剩余原文"二分，没有任何占位符替换、没有位置参数、没有 shell 预执行、没有文件引用。**
- 名字文法 `:25` `COMMAND_NAME = /^[a-z][a-z0-9_-]*$/` —— 不含 `:`。

**差距量化**：CC 的 `$ARGUMENTS` ≈ dsh 的 `invocation.rawInput`（**这一项是现成的**）；`$1..$9`、`` !`cmd` ``、`@file`、`allowed-tools`、`model`、`disable-model-invocation` 全部为零。而且 CC command 的产物是「一段进入对话的提示词」，dsh command 的产物是「一个 `CommandResult` 直接渲染给 UI，不进模型」—— **这是模型层面的不匹配，不是字段层面的**。

### B.3 agents —— **从 markdown 定义子 agent：完全没有**

- `packages/subagent/subagent/src/types.ts` 的 `SubagentStartRequest` 只有 `{ label?, prompt, parent, signal, agentOptions?, outputSchema?, maxDepth?, toolFilter?, persona? }`。**没有 `agentType`，没有"从 N 个已定义 agent 里挑一个"的概念。**
- `packages/subagent/tool-subagent/src/index.ts:30-98` 的 Config：一个 `tool-subagent` 实例 = 一个固定 `persona` + 一个固定 `toolFilter` + 一个固定 `agentOptions`。要 N 种 agent，就得**挂 N 个 `tool-subagent` 实例、各配一个 `toolName`**。
- Provider 接口（`SubagentProvider`）：`start()` / `prepareContinuable()` + `SubagentCapabilities = { outputSchema, depthLimit, toolFilter, persona }`。粒度是"起一个子 agent 的后端"，不是"一个 agent 定义"。
- dsh 最接近的东西是 **agent preset**：`packages/preset/agent-presets/src/discovery.ts:26` `COMPOSITION_FILE = 'agent.cordis.yml'` + `metadata.ts:26` `METADATA_FILE = 'preset.yml'`（`{name, description, order}`）。**preset 是一份 cordis 插件组合，不是一段 system prompt**。

映射可行性：CC agent frontmatter → dsh：`description` → preset/persona 描述 ✅；正文 → `persona` ✅；`tools` → `toolFilter.allow` ✅（需 provider 的 `toolFilter` capability）；`model` → `agentOptions.model` ✅；`maxTurns`/`effort`/`color`/`is_background` → ❌ 无对应；`skills:` → ❌ 无"给子 agent 预挂技能"的机制。
`subagent/start` 时 dsh 的 hook bridge 硬报 `agent_type = 'general-purpose'`（`packages/hooks/hooks-claude-code/src/index.ts:304`），所以带 `agent_type` matcher 的 hook 一律不触发。

### B.4 hooks —— 见 §D 专章

### B.5 MCP —— **不吃 `.mcp.json`**

- `packages/mcp/mcp-client/src/index.ts:50-96`：一个插件实例 = 一台 server。字段 `transport: 'stdio' | 'streamable-http'`、`serverName`、`command`/`args`/`env`/`cwd` 或 `url`/`headers`、`toolCallTimeoutMs`、`failOnStartupError`、`reconnect`。
- **无 `.mcp.json` 读取器**，全仓无。dsh 自己的 note 已经点名这件事：`.agents/notes/implemented/feature/2026-07-31-even-out-shipped-tool-rosters.md:37` —— "The layer that would make MCP a default is the one this repository does not have yet: a bridge that reads a user's server list and mounts one client per entry, **the same shape `dsh-hooks-claude-code` already has for a Claude Code `hooks.json`**"。
- 字段映射：CC `command`+`args` → dsh `transport:'stdio'` + `command`+`args` ✅；CC `type:"http"` + `url` + `headers` → dsh `transport:'streamable-http'` + `url` + `headers` ✅（`type:"sse"` 未见样本 `[推测]` 也归 streamable-http）；CC headers 的 `${VAR}` / `${VAR:-default}` shell 展开 → dsh **无展开**（`z.dict(String)` 原样） ❌。
- 工具命名：dsh `mcp__<serverName>__<rawName>`（`:55-58`），**与 CC 同款**。`serverName` 受 `[A-Za-z0-9_-]{1,32}` 约束且全进程唯一（`:107-128` + `:143-152` 重名 fail loud）。
  → ⚠️ **ecc 记录的 64 字符工具名超限问题（`PLUGIN_SCHEMA_NOTES.md:150`）在 dsh 会同样发生**，而且 dsh 的 32 字符 `serverName` 上限比 CC 更紧：`<plugin>_<mktserver>` 拼起来很容易越界。

### B.6 LSP —— **意外地对得上**

`packages/lsp/lsp-stdio/src/index.ts:55-105`：`servers: Record<id, { command, args?, extensionToLanguage }>`。CC marketplace 的 `lspServers` 字段名 **逐字相同**（`command`/`args`/`extensionToLanguage`）。转换是纯改形。

### B.7 插件分发 —— 两套机制的差异

| 维度 | Claude Code | dsh |
|---|---|---|
| 获取 | `git clone` 市场仓库 → `marketplaces/<mkt>/` | `pnpm add`（`apps/cli/src/args.ts:171-180`，`dsh plugin --profile X add <pkg>` 直接转发 pnpm） |
| 单元 | marketplace（多插件）→ plugin | npm package（`dsh.bundle.patch` 声明一个 cordis patch 层） |
| 物化 | 复制到 `cache/<mkt>/<plugin>/<ver>/` | `$DSH_HOME/profiles/<name>/node_modules/` |
| 版本 | 目录即版本，多版本共存，`gitCommitSha` 钉住 | pnpm/semver + lockfile，单版本 |
| 组合 | 无组合概念，插件平行叠加 | **有序 patch 层**：base bundle → 各 bundle（`dsh.profile.bundles` 顺序）→ profile 的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` overlay。后层按 `id` 整行覆盖 `config`（`apps/cli/reference/README.md:9-11`，`docs/user/develop/basic/publish.md`） |
| 启用 | `settings.json:enabledPlugins[<plugin>@<mkt>] = bool`，与安装解耦 | **无开关**：在 `bundles` 列表里就是启用，`dsh plugin remove` 才移除 |
| 自动更新 | `autoUpdate: true` 定时拉取 | 无 |
| 黑名单 | `blocklist.json` 远端下发 | 无 |
| 内容形态 | **数据**（md/json/脚本），无需构建 | **代码**（`apply(ctx, config)` 的 JS 模块） |
| 信任 | 无沙箱，hook 直接跑 shell | 同左；额外有 `trust: 'system'\|'user'`（仅 preset 根，`packages/preset/agent-presets/src/preset.ts`） |

**根本差异一句话：CC 插件是「一包声明式资产 + 若干 shell 脚本」，dsh 插件是「一段 cordis 组合补丁 + 若干 JS 模块」。要经 marketplace 入口消费 CC 生态，dsh 必须新增一个"资产型插件"的一等概念——它不是 bundle，不进 `cordis.patch.yml`。**

---

## C. 逐项映射矩阵

> 状态：✅已支持 / 🟡部分 / ❌缺失 / ⚠️语义冲突
> 工作量：S(≤1d) / M(2-4d) / L(1-2w) / XL(多周)

### C.0 获取层 / 元数据

| CC 侧 | dsh 对等物 | 状态 | 缺口 | 补法 | 量 |
|---|---|---|---|---|---|
| marketplace 概念 | 无 | ❌ | 全仓 0 命中 | 新包 `dsh-plugin-marketplace`：市场注册表 + git clone/pull | M |
| `known_marketplaces.json` | 无 | ❌ | — | 同上，落在 `$DSH_HOME/plugins/known_marketplaces.json` | S |
| `source: github{repo}` / `git{url}` | 无 | ❌ | — | 用 `ctx.shell` 跑 git，或 isomorphic-git | S |
| `source: git-subdir{url,path,ref,sha}` | 无 | ❌ | 官方 285 条里 84 条是这形态 | sparse-checkout 或 clone 后取子目录 | M |
| `source: url{url,sha}` | 无 | ❌ | 146/285，最主流 | 同 git clone | S |
| `source: "./rel"` | 无 | ❌ | 53/285 | 市场仓库内相对路径解析 | S |
| `installed_plugins.json` | 无 | ❌ | scope/version/gitCommitSha/installPath | 新台账文件；`scope:project` 可映到 dsh 的 project root | S |
| `installPath = cache/<mkt>/<p>/<ver>` | 无 | ❌ | 多版本并存 | 照抄布局：`$DSH_HOME/plugins/cache/<mkt>/<p>/<ver>` | S |
| `.in_use/<pid>` GC | 无 | ❌ | — | 可选；v1 可不 GC | S |
| `data/<p>-<mkt>` + `$CLAUDE_PLUGIN_DATA` | 无 | ❌ | codex 插件依赖 | 建目录 + 注入环境变量 | S |
| `plugin-catalog-cache.json` | 无 | ❌ | token 预算 / 装机量 / 组件清单 | 纯读取，TUI 目录页直接用 | S |
| `blocklist.json` | 无 | ❌ | — | 可选，v1 可跳过 | S |
| `settings.json:enabledPlugins` | 无（bundles 列表即启用） | ❌ | 装/启分离 | dsh `settings` 服务已有 namespace 机制（`packages/settings/`），注册一个 `plugins` namespace 存开关 | M |
| `extraKnownMarketplaces` | 无 | ❌ | — | 同上 namespace | S |
| `marketplace.json` 顶层 | 无 | ❌ | `name`/`owner`/`plugins` 必填 + `description`/`metadata`/`renames`/`$schema` | 纯解析器 + schemastery schema | S |
| `plugin.json` | `package.json:dsh.bundle` | ⚠️ | 完全不同的两套清单；CC 的是"资产声明"，dsh 的是"patch 指针" | 新解析器，不复用 bundle 路径 | S |
| plugin.json `skills[]`（array\|string 两形态） | `customSkillDirs[]` | 🟡 | 类型不一致；string 形态要兼容 | 归一化后喂 `customSkillDirs` | S |
| plugin.json `mcpServers:{}` opt-out | 无 | ❌ | — | 解析后跳过 `.mcp.json` 自动发现 | S |
| `renames` 迁移表 | 无 | ❌ | — | 可选 | S |
| `${CLAUDE_PLUGIN_ROOT}` 解析 | 仅 hook 命令串替换 | 🟡 | skill/command 正文、hook 环境变量三处缺 | 见 C.5 | M |

### C.1 skills

| CC 侧 | dsh 对等物 | 状态 | 缺口 | 补法 | 量 |
|---|---|---|---|---|---|
| `skills/<n>/SKILL.md` 发现 | `customSkillDirs` + `discoverRoot()` | 🟡 | **只扫一层**，mattpocock 的 `skills/engineering/tdd/` 发现不了 | 按 plugin.json 的 `skills[]` 逐条挂根；无 `skills[]` 时递归探测二层子目录 | S |
| `name`（kebab） | `SKILL_NAME` | ✅ | 真实 951/951 通过 | — | — |
| **`plugin:skill` 命名空间** | `SKILL_NAME` 禁止 `:` | ⚠️**冲突** | 956 技能里 `impeccable`×15、`tdd-workflow`×9 等大量撞名；dsh 同层去重会静默丢弃 | (a) 放宽 `SKILL_NAME` 允许 `<ns>:<name>`（改 `skill/src/index.ts:20`、`tool-skill/src/index.ts:409` 的 gesture、`skill-filesystem` 的校验）；或 (b) 前缀化为 `<plugin>-<skill>`（不改文法，但与 CC 生态的名字不一致，插件互引会断） | M |
| `description` | ✅ | ✅ | — | — | — |
| `disable-model-invocation` | ✅ 语义一致 | ✅ | — | — | — |
| `user-invocable` | ✅ 语义一致 | ✅ | — | — | — |
| `metadata` | ✅ | ✅ | — | — | — |
| `allowed-tools`（含 `Bash(npx x *)` 模式） | 无 | ❌ | 技能级工具白名单 | 需要 tools registry 的 per-skill scoping；dsh 有 `ToolRestriction` 但没有绑到 skill 的通路 | L |
| `argument-hint` | `CommandInputDescriptor.hint` | 🟡 | 技能侧无字段，命令侧有 | 若做"user-invocable skill → 命令"桥，可映射 | S |
| `version`/`license`/`homepage`/`author`/`tags` | 无 | ❌ | 静默丢 | 塞进 `metadata`（provider 侧自己 pack） | S |
| 技能资源树（`references/`、`scripts/`） | `resourceBase{kind:'directory'}` | ✅ | — | 已渲染进 `<skill_resources>` | — |
| SKILL.md 正文里的 `${CLAUDE_PLUGIN_ROOT}` | 无替换 | ❌ | 18/956 受影响 | provider 的 `get()` 里替换（skill-filesystem 现在不做任何替换，需在新 provider 做） | S |
| rank 分层（project>custom>user） | `CUSTOM_RANK=300` 固定 | 🟡 | 插件之间无法分优先级 | 新 provider 自己发 rank（`SkillCandidate.rank` 是 provider 给的，不受 300 限制）——**这条其实好办** | S |
| 撞名策略 | 同层丢弃 + warn | ⚠️ | 用户看不见"哪个赢了" | 解决命名空间后自然消解 | — |

### C.2 commands

| CC 侧 | dsh 对等物 | 状态 | 缺口 | 补法 | 量 |
|---|---|---|---|---|---|
| `commands/*.md` 文件发现 | 无 | ❌ | 全无 | **需要一条 `ctx.commands` 的 provider 接缝**（现在只有 `register(definition)`，没有 provider 注册） | M |
| 命令 = 提示词模板（注入对话） | 命令 = JS handler（不进模型） | ⚠️**模型冲突** | dsh 的 `CommandResult` 直接渲染给 UI | 新增一类"prompt command"：handler 内部做模板展开后走 `agent.inject()` / 返回 `enter` messages。可仿 `tool-skill` 的 `SKILL_GESTURE` 注入路径 | M |
| `/plugin:cmd` 命名空间 | `COMMAND_NAME` / `parseCommand` 无 `:` | ⚠️冲突 | 463 个命令跨插件必撞名 | 同时放宽 `COMMAND_NAME`(`:25`) 与 `parseCommand`(`:103`) 的正则 | S |
| `$ARGUMENTS` | `invocation.rawInput` | ✅ | **现成** | 字符串替换 | S |
| `$1`…`$9` | 无 | ❌ | 12 个命令在用 | 在 rawInput 上做 shell 风格分词 | S |
| `` !`cmd` `` 内联执行 | 无 | ❌ | 4 个命令在用（codex 的 `/codex:status`、`/codex:result`、`/codex:cancel`、`/codex:transfer` 全靠它） | 用 `ctx.shell` 执行、stdout 内联；**要过 permission/approval**（安全面） | M |
| `@path` 文件引用 | 无 | ❌ | 1 个 | 读文件内联 | S |
| `description` | ✅ | ✅ | — | — | — |
| `argument-hint` | `input.hint` | ✅ | — | 直接映 | S |
| `allowed-tools` | 无 | ❌ | 22 个命令在用 | 同 skills 的 `allowed-tools`，需 per-invocation tool scoping | L |
| `disable-model-invocation` | 无（dsh 命令本就只人调） | ✅ 等价 | — | — | — |
| `model` / `agent` / `subtask` | 无 | ❌ | 长尾 | 可先忽略 | S |

### C.3 agents

| CC 侧 | dsh 对等物 | 状态 | 缺口 | 补法 | 量 |
|---|---|---|---|---|---|
| `agents/*.md` 文件发现 | 无 | ❌ | 全无 | — | M |
| "从 N 个已定义 agent 挑一个"（`subagent_type`） | 无该概念 | ❌ | `SubagentStartRequest` 无 agentType；一个 `tool-subagent` 实例 = 一个固定 persona | (a) 每个 CC agent 挂一个 `tool-subagent` 实例（工具数爆炸）；(b) 新增 `agentType` 到 request + 一个 agent-definition registry（接缝变更） | L |
| agent 正文 → system prompt | `persona` | ✅ | 需要 provider 的 `persona` capability | 直接映 | S |
| `name` | `toolName` / 未来的 agentType | 🟡 | 同上 | | |
| `description` | 无（只有 preset 的 `preset.yml:description`） | 🟡 | 主 agent 靠它选人 | 需要把描述放进工具 schema | S |
| `tools`（逗号串） | `toolFilter.allow[]` | ✅ | 需 provider capability；未知名 fail loud | 解析逗号串 | S |
| `model` | `agentOptions.model` | ✅ | `inherit` 需特判 | | S |
| `maxTurns` | 无 | ❌ | impeccable 4 个 agent 全用（12/24/30） | 无对应 | M |
| `effort` | 无 | ❌ | | | S |
| `skills:`（子 agent 预挂技能） | 无 | ❌ | codex-rescue 在用 | 需要 scoped skill 注册（dsh 有 scope 机制，可做） | M |
| `color` / `is_background` / `readonly` | 无 | ❌ | 展示/长尾 | 忽略 | S |
| hook 的 `agent_type` matcher | 硬编码 `'general-purpose'` | ⚠️ | `hooks-claude-code/src/index.ts:304`；指定 kind 的 matcher 永不触发 | 需 subagent seam 携带 kind 标签 | M |
| dsh preset（`agent.cordis.yml`） | — | — | 是**另一个东西**（插件组合），不是 CC agent 的对等物 | — | — |

### C.4 hooks（摘要，详见 §D）

| CC 侧 | dsh 对等物 | 状态 | 缺口 | 补法 | 量 |
|---|---|---|---|---|---|
| 多插件各带 `hooks/hooks.json` | `configPath` 单文件 | ❌ | **最大结构性缺口** | 见 §D.3 | L |
| 30 个 hook 事件 | 7 个 | 🟡 23% 覆盖 | 见 §D.2 | 按需补事件 | L~XL |
| `type: "command"` | ✅ | ✅ | 真实数据 67/67 都是 command | — | — |
| `command` | ✅ | ✅ | | | |
| `timeout`（秒） | ✅ `timeoutSec` | ✅ | 默认 600s 一致 | | |
| `matcher` 字面量/正则 | ✅ 语义一致 | ✅ | `CLAUDE_LITERAL=/^[A-Za-z0-9_\|]+$/`（`hook-protocol/src/matcher.ts:18`）判定一致 | | |
| `statusMessage` | 无 | ❌ | 14 处在用（TUI 展示价值高） | 加字段 + UI 事件 | S |
| `async` / `asyncRewake` / `rewakeMessage` | 无 | ❌ | 9/6/6 处 | 需要"异步 hook 唤醒"机制 | L |
| `if` 条件 | 无 | ❌ | 5 处 | | M |
| `args[]` 数组 | 无 | ❌ | **本机 settings.json 用户层全在用**（Orca 集成） | 加字段 | S |
| `${CLAUDE_PLUGIN_ROOT}` 串替换 | ✅ | ✅ | `config.ts:57-62` | | |
| `CLAUDE_PLUGIN_ROOT` 环境变量 | ❌ | ❌ | ecc 引导脚本必需 | `runPoint()` 的 `hookEnv` 里加一条 | S |
| `CLAUDE_PROJECT_DIR` 环境变量 | ✅ | ✅ | `index.ts:150-151`，缺省=session cwd | | |
| `CLAUDE_PLUGIN_DATA` / `CLAUDE_SESSION_ID` / `CLAUDE_HOOK_EVENT_NAME` / `CLAUDE_HOOK_DEPTH` / `CLAUDE_ENV_FILE` | ❌ 全无 | ❌ | codex+impeccable 在用 | 同上 | M |
| 并行执行 + 去重 | 串行、不去重 | 🟡 | 明示的设计取舍（note "Alternatives considered"） | 多插件后 hook 数会涨，串行延迟叠加 | M |
| `continue:false` 硬停 | 解析但不生效 | ❌ | `TODO(hook-continue-false)` | 需要 run 级 halt 原语 | L |
| `updatedInput` 重写 | 解析 + warn，不生效 | ❌ | 已有 proposed note | | L |
| `stop_hook_active` 循环保护 | 恒 `false` | ❌ | `TODO(stop-loop-guard)`；无条件 block 的 Stop hook 会**每步强制续跑** | 计数器 | S |
| `systemMessage` | warn，不展示 | ❌ | impeccable 靠它报"Node 版本不够" | 走 UI 事件 | S |

### C.5 MCP / LSP / 其它

| CC 侧 | dsh 对等物 | 状态 | 缺口 | 补法 | 量 |
|---|---|---|---|---|---|
| `.mcp.json` 自动发现 | 无 | ❌ | 46 个插件根里 16 个有 | 新桥接插件（形态照抄 `hooks-claude-code`），每条 server mount 一个 `mcp-client` | M |
| 两种顶层形态（裸映射 / `mcpServers` 包一层） | — | ❌ | 都要认 | 解析器兼容 | S |
| `command`+`args` stdio | `transport:'stdio'` | ✅ | 字段同名 | | S |
| `type:"http"` + `url` + `headers` | `transport:'streamable-http'` | ✅ | | | S |
| headers 的 `${VAR}` / `${VAR:-def}` 展开 | 无 | ❌ | context7/github 在用 | 加一个小展开器（**注意凭据面**：dsh 有 `credentials` 服务，应走它而非 `process.env`） | M |
| `mcp__<server>__<tool>` 命名 | ✅ 同款 | ✅ | | | |
| `serverName` 长度 | dsh `{1,32}` 上限 | ⚠️ | 比 CC 更紧；`<plugin>_<server>` 易越界，且 ecc 已实证 64 字符工具名会被网关拒 | 需要一个**短命名策略**（哈希后缀 / 用户可改名） | M |
| `lspServers` | `dsh-lsp-stdio.servers` | ✅ | `command`/`args`/`extensionToLanguage` **逐字同名** | 纯改形 | S |
| `scripts/` `prompts/` `schemas/` | — | ✅ | 非 CC 规范，只被 `${CLAUDE_PLUGIN_ROOT}` 引用 | **解决路径变量后零成本可用** | — |

---

## D. 专章 —— hooks（覆盖最不全的一环）

### D.1 为什么它是重点

本机 6 个已装插件里，**4 个带 hooks**；6 个市场 checkout 里 16 个 `hooks.json`。用户自写的 `sdlc` 插件自我描述就是 **"Hooks-first SDLC workflow runtime"**（`marketplaces/yuki/.claude-plugin/marketplace.json:11`），它的 7 个事件里有 `PreCompact`/`PostCompact` —— dsh 一个都不支持。**这个插件经 marketplace 装进 dsh 会静默失去一半功能。**

### D.2 事件覆盖：7 / 30

dsh 支持（`packages/hooks/hooks-claude-code/src/config.ts:11-19`，逐字）：
```
SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStart, SubagentStop
```

不支持的 23 个（`packages/hooks/hooks-claude-code/README.md`「Known Limitations」逐字，其比对基准是官方 hook-event reference）：
```
Setup, InstructionsLoaded, UserPromptExpansion, MessageDisplay, PermissionRequest,
PostToolUseFailure, PostToolBatch, PermissionDenied, Notification, TaskCreated,
TaskCompleted, StopFailure, TeammateIdle, ConfigChange, CwdChanged, FileChanged,
WorktreeCreate, WorktreeRemove, PreCompact, PostCompact, SessionEnd, Elicitation,
ElicitationResult
```

**与本机真实用量对照 —— 这不是理论缺口：**

| 事件 | 本机真实用量 | dsh |
|---|---|---|
| `Stop` | 9 处（codex 的 review-gate 900s、ralph-loop、impeccable 深度检查） | ✅ 但 `stop_hook_active` 恒 false → 无条件 block 会死循环 |
| `SessionStart` | 7 处 | ✅ 但 detached，可能错过首次请求 |
| `PostToolUse` | 7 处 | ✅ |
| `PreToolUse` | 4 处 | ✅（`allow` 不预批、`defer` 不支持、`updatedInput` 不生效） |
| `UserPromptSubmit` | 4 处 | ✅（超时用 600s 而非 CC 的 30s） |
| **`PreCompact`** | **3 处（含 sdlc）** | ❌ |
| **`SessionEnd`** | **2 处（含 codex）** | ❌ |
| **`PostCompact`** | **2 处（含 sdlc）** | ❌ |
| **`UserPromptExpansion`** | 1 处（claude-security 横幅） | ❌ |
| **`PostToolUseFailure`** | 1 处 + 用户 settings.json | ❌ |
| **`PermissionRequest`** | 用户 settings.json（Orca 集成） | ❌ |
| **`StopFailure`** | 用户 settings.json | ❌ |

按插件算实际损失：
- **sdlc（用户自写，7 事件）**：`PreCompact` + `PostCompact` 丢失 → **5/7 可用（71%）**
- **codex（3 事件）**：`SessionEnd` 丢失 → **2/3（67%）**，且 `SessionEnd` 负责会话生命周期收尾 + 写 `CLAUDE_ENV_FILE`
- **impeccable（2 事件）**：`PostToolUse` + `Stop` 都在 → **2/2（100%）**，但依赖 `CLAUDE_HOOK_DEPTH`（dsh 不注入 → 防自触发逻辑失效 `[推测]`）
- **ecc（大量事件 + `async` + `id`）**：多数事件在支持列表内，但 `async: true` 不生效、`CLAUDE_PLUGIN_ROOT` 环境变量缺失导致引导脚本走 fallback 路径去猜 `~/.claude/plugins/...`（**在 dsh 下这个 fallback 一定猜错**）

### D.3 `configPath` 是 process-level 单配置 —— 多插件合并怎么办

现状（`packages/hooks/hooks-claude-code/src/index.ts:44-70, 96-116`）：
- `configPath: string`（**required，单值**）
- `pluginRoot?: string`（**单值** —— 一个 bridge 实例只能服务一个插件根）
- load 时 `readFileSync` 一次（`:104`），**永不重读**
- 相对路径按进程启动 cwd 解析
- 读失败 → warn + `return`（不注册任何 hook），不炸 boot
- 注释 `:52-53` 明确挂着 `TODO(per-session-hook-config)`

**三条可行路线：**

**路线 A：每插件一个 bridge 实例（改动最小）**
```yaml
- id: hooks-sdlc
  name: '@deepseek-ai/dsh-hooks-claude-code'
  config: { configPath: '<cache>/yuki/sdlc/0.1.2/hooks/claude-hooks.json',
            pluginRoot: '<cache>/yuki/sdlc/0.1.2' }
- id: hooks-impeccable
  name: '@deepseek-ai/dsh-hooks-claude-code'
  config: { configPath: '...', pluginRoot: '...' }
```
- ✅ 零代码改动，`pluginRoot` 天然 per-plugin 正确
- ✅ 每个实例独立 fail（一个插件配置坏了不影响别的）
- ❌ 插件装/卸要**动 cordis 组合**（marketplace 服务得能动态 mount/unmount 插件行）
- ❌ N 个实例各自注册 `agent/pre-step` / `tools/pre-execute` 等 waterfall 监听器 —— **执行顺序 = 注册顺序**，跨插件的 hook 优先级不可控
- ❌ 每个实例独立跑 `mergeHookOutputs`，**没有跨插件的统一 most-restrictive 合并**（不过因为 waterfall 里 deny 会短路，实际效果接近；`[推测]` 需验证）
- 量：**S**（如果 marketplace 服务本来就要能动态挂插件）

**路线 B：给 bridge 加多配置能力**
把 `configPath: string` → `configs: { path, pluginRoot }[]`，parse 时逐条替换各自的 `pluginRoot`，合并成一张 `Record<event, MatcherGroup[]>`（追加，保留来源标签）。
- ✅ 一个实例、一组监听器、一次统一合并
- ✅ 顺序可控（配置列表顺序）
- ✅ `hook/invoked` 事件可带 plugin 归属（现在 `handlerId` 是 `claude-code:<point>:<n>`，可扩成 `claude-code:<plugin>:<point>:<n>`）
- ❌ 需要改 `Config` schema + `parseClaudeCodeConfig` 的调用点 + `runPoint` 的 group 迭代
- 量：**M**

**路线 C：hook provider 接缝（对齐 skills 的做法）**
新增 `ctx.hooks.registerProvider()`，marketplace 服务作为 provider 动态贡献 hook 配置；bridge 从 registry 拉。
- ✅ 与 `ctx.skills` / `ctx.tools` 的分层 registry 形态一致，是 dsh 的"正确形状"
- ✅ 天然支持热插拔、per-scope（agent preset 级别的 hook）
- ❌ 新接缝 = 新服务定义 + 分层合并 + 失效通知
- 量：**L**

**建议**：v1 走 **B**（一个实例吃一个列表），把 **C** 留作 hook 的最终形态。**A 只在 marketplace 服务已经能动态 mount cordis 行时才划算**，而且它的顺序不可控是硬伤。

### D.4 其它 hook 缺口（按真实影响排序）

1. **`CLAUDE_PLUGIN_ROOT` 不进环境变量**（只做串替换）。`runPoint()` 的 `hookEnv` 只有 `CLAUDE_PROJECT_DIR`（`index.ts:148-151`）。ecc 的引导脚本 `if(e&&e.trim())return e.trim()` 读不到就走一长串 `~/.claude/plugins/...` 猜测 fallback —— 在 dsh 下必然猜错。**修法 1 行，收益极高。** S
2. **`args[]` 不认**（`config.ts:102-106` 只取 `command` + `timeout`）。本机 settings.json 的 Orca 集成全靠 `args`。S
3. **`statusMessage` 不认**。14 处在用，对 TUI 是白送的进度提示。S
4. **`async` 不认**（9 处）。同步跑一个本该异步的 hook = 每次工具调用都阻塞。L
5. **`stop_hook_active` 恒 false**（`index.ts:346`）+ 无连续 block 上限（`TODO(stop-loop-guard)`）。**装了 codex 的 review-gate（Stop, timeout 900s）后，一个总是 BLOCK 的 gate 会让 dsh 无限续跑**。S 修（加计数器）
6. **`continue:false` 不生效**（`TODO(hook-continue-false)`）。L
7. **`agent_type` 恒 `'general-purpose'`**（`index.ts:304`）。带具体 kind matcher 的 SubagentStart/Stop hook 永不触发。M
8. **串行 + 不去重**。dsh 的 note 明说是取舍；单插件没问题，**装 5 个插件后 PostToolUse 上挂 5 个 hook，串行延迟叠加**。M
9. **配置不热重载**。插件启用/禁用后要重挂 fiber 才生效。（路线 B/C 顺带解决）

---

## E. 对 marketplace 服务契约的约束

以下每条都是上面的发现直接推出的设计约束，供下一张票使用。

### E.1 缓存位置与布局

- **必须照抄 CC 的三层布局**：`marketplaces/<mkt>/`（git checkout）、`cache/<mkt>/<plugin>/<ver>/`（版本化物化）、`data/<plugin>-<mkt>/`（插件私有可写）。理由：`${CLAUDE_PLUGIN_ROOT}` 语义是「插件根」，而 `$CLAUDE_PLUGIN_DATA` 语义是「插件私有可写目录」；插件脚本会**同时**依赖两者，且部分插件（ecc）在 root 猜不到时会去猜 `~/.claude/plugins/...` 的**具体路径形状**。布局越像，fallback 越可能对。
- 根位置建议 `$DSH_HOME/plugins/`（与 `$DSH_HOME/skills`、`$DSH_HOME/profiles` 平级）。**不要复用 `$DSH_HOME/profiles/<n>/node_modules`** —— CC 插件不是 npm 包，混进去会污染 pnpm 的账本。
- **版本目录必须是 `installPath` 的最后一段**（CC 的不变式），否则多版本共存和 GC 都无从谈起。
- `.in_use/<pid>` 式引用计数可以 v1 不做，但**目录布局要为它留位**。

### E.2 provider 粒度

- **skills：per-plugin 一个 provider 实例**。理由：(a) `SkillCandidate.rank` 由 provider 自己发，per-plugin provider 才能给出 per-plugin 优先级（`customSkillDirs` 全是固定 300）；(b) provider 名字唯一约束（`NamedEntries.insert` 重名 throw，`packages/core/scope/src/store.ts:45`）天然给每个插件一个身份；(c) 一个插件的 SKILL.md 坏了只让那个 provider 的 `list()` 抛错、被 registry 兜住（`skill/src/index.ts:603-609` warn + `cacheable=false`），不影响别的插件。
- **hooks：per-plugin 一份配置，但合并到一个 bridge 实例**（路线 B）。理由：waterfall 监听器的顺序 = 注册顺序，多实例的顺序不可控；而且跨插件的 most-restrictive 合并必须在一处做。
- **MCP：per-server 一个 `mcp-client` 实例**（这是 dsh 现有形状，`serverName` 全进程唯一）。所以 marketplace 服务必须能**动态 mount/unmount cordis 插件行**，或者提供一个 fan-out 桥接插件。
- **commands：需要一条新的 provider 接缝**（现在 `ctx.commands` 只有 `register(definition)`，没有 provider 概念）。

### E.3 命名空间 —— 必须先定，它是最深的约束

- **CC 的运行时名字是 `<plugin>:<asset>`**（本会话系统提示里的 `mattpocock-skills:diagnosing-bugs`、`codex:codex-cli-runtime` 是一手证据）。
- **dsh 三处文法都禁止冒号**：`SKILL_NAME`（`skill/src/index.ts:20`）、`COMMAND_NAME` + `parseCommand`（`commands/src/index.ts:25,103`）、`SKILL_GESTURE`（`tool-skill/src/index.ts:409`）。
- 撞名是**已实测的**：956 个技能里 `impeccable`×15、`tdd-workflow`/`coding-standards`/`security-review`/`frontend-patterns`/`backend-patterns`×9。**不解决就会静默丢技能。**
- 两条路：
  - **放宽文法**允许 `<ns>:<name>`：与 CC 生态一致，插件之间的互相引用（如 `/codex:setup` 在 skill 正文里被提到）能直接工作。代价：改 4 处正则 + 相关校验/测试，而且这些是**已验证的公共文法**（`skill/src/index.ts` 的注释称之为 "the public skill-name grammar"），改动风险实。
  - **前缀化 `<plugin>-<name>`**：不动文法。代价：名字与生态不一致，`impeccable` → `impeccable-impeccable`，插件正文里写的 `/impeccable polish` 会指不到。
  - **建议放宽文法**，因为「插件内容必须能跑」是本票的硬约束，而插件内容里到处写着 CC 形态的名字。
- MCP 侧另有一个**长度约束**：dsh `serverName` 上限 32 字符，且工具名 `mcp__<server>__<tool>` 会被严格网关按 64 字符截断（ecc 的一手记录）。命名策略必须同时满足这两个上限。

### E.4 生命周期

- **安装 ≠ 启用**（CC 的 `installed_plugins.json` vs `settings.json:enabledPlugins` 是两张表）。dsh 必须复刻这个分离：TUI 要能"装了先不开"。dsh 的 `settings` 服务已有 namespace + 观察 + 持久化机制（`packages/settings/`），注册一个 `plugins` namespace 是自然落点。
- **启用/禁用必须能在进程内生效**，不能要求重启：
  - skills ✅ 现成（`ctx.skills.registerProvider` 返回 disposer，`control.invalidate()` 失效缓存，`skills/change` 事件通知）
  - commands ✅ 现成（`register()` 返回 disposer + `commands/change`）
  - hooks ❌ 现在 load 时读一次、永不重读 —— **必须改**
  - MCP 🟡 每个实例是一个 cordis fiber，dispose 会断连接；但需要能动态 mount 新行
- **更新语义**：CC 用 `gitCommitSha` 钉住内容、`autoUpdate` 定时拉。dsh 的 `installedAt` ≠ `lastUpdated` 语义要照抄（就地更新不改 installedAt）。
- **多版本共存**是 CC 的既成事实（本机 impeccable 4.0.2 + 4.0.4 并存）。契约要说清"启用哪个版本"。

### E.5 失败语义 —— 必须逐层 fail-soft

dsh 现有代码已经把基调定了，marketplace 服务要保持一致：

| 层 | dsh 现有行为 | marketplace 服务应遵循 |
|---|---|---|
| hook 配置读/解析失败 | warn + 不注册任何 hook，**不炸 boot**（`hooks-claude-code/src/index.ts:113-116`） | 一个插件的 hooks.json 坏了，只让那个插件的 hooks 失效 |
| 单个 SKILL.md 坏 | warn + 跳过该文件（`skill-filesystem/src/index.ts:803-819`） | 保持 |
| provider `list()` 抛错 | warn + `cacheable=false`（不缓存、保留 last-good、下次重试）（`skill/src/index.ts:603-609`） | **这是关键性质**：网络拉市场失败时，要返回"不完整观测"而非"空目录"，否则模型会看到技能全消失 |
| provider 返回不完整观测 | 不发布为权威目录（`tool-skill/src/index.ts:224`：`if (!snapshot.complete) return decision`） | 保持——**目录不完整时宁可不更新，也不能发布一个缺技能的目录** |
| hook 进程跑不起来 | 无 exitCode 的非阻塞错误，turn 继续（`hook-protocol/src/runner.ts:95-104`） | 保持 |
| MCP 初连失败 | `failOnStartupError: false` 时只 log + 进重连循环 | 插件带的 MCP server 应默认 `failOnStartupError: false` |
| 重名 provider / 重名 serverName / 重名 command | **fail loud，throw** | marketplace 服务必须在 mount **之前**做冲突检测，把冲突呈现给用户，而不是让 cordis 抛异常炸掉整个启用动作 |

补充两条本票新发现的约束：
- **不支持的 hook 事件是"解析前就丢弃"**（`config.ts:86-88` 只遍历 `CLAUDE_EVENTS`）。这意味着一个只配 `PreCompact` 的插件会**完全静默地什么都不做**。marketplace 服务**必须在安装/启用时做能力体检并告知用户**（"此插件的 3 个 hook 中 1 个在 dsh 上不受支持"）—— `plugin-catalog-cache.json` 的 `components.hooks[]` 是现成的事件名清单，可以在**下载前**就算出覆盖率。
- **不支持的 frontmatter 字段是静默丢弃**（`allowed-tools`、`argument-hint`、`maxTurns`…）。同理需要体检 + 告知，否则用户会以为 `allowed-tools` 在生效。

### E.6 一个易被忽略的约束：`scripts/` 类目录是"免费的"

`scripts/`、`prompts/`、`schemas/` 不是 CC 规范的一部分，CC 不发现它们；它们**只通过 `${CLAUDE_PLUGIN_ROOT}/...` 被引用**。这意味着：**只要 (a) 插件目录完整落盘、(b) `${CLAUDE_PLUGIN_ROOT}` 在 hook 命令串、hook 环境变量、skill 正文、command 正文四个位置都正确解析、(c) 能跑 shell —— 这类"插件私有实现"就零成本可用。** codex 插件 31 KB 的 `codex-companion.mjs` 全靠这条。反过来说，**路径变量解析是整个消费链路的单点**，值得单独做对、单独测。

---

## 附：本次调研的证据锚点

**A 面（本机真实文件）**
- `C:/Users/zsp/.claude/plugins/known_marketplaces.json`（5 市场）
- `C:/Users/zsp/.claude/plugins/installed_plugins.json`（6 插件，version:2）
- `C:/Users/zsp/.claude/plugins/blocklist.json`
- `C:/Users/zsp/.claude/plugins/plugin-catalog-cache.json`（255 plugin）
- `C:/Users/zsp/.claude/settings.json:4-10`（enabledPlugins）、`:29-56`（extraKnownMarketplaces）、`:57-220`（用户层 hooks，用 `args[]`）
- `C:/Users/zsp/.claude/plugins/marketplaces/ecc/.claude-plugin/PLUGIN_SCHEMA_NOTES.md`（**验证器怪癖的一手记录**：`agents` 禁字段、`hooks` 重复加载、`mcpServers:{}` opt-out 与 64 字符工具名）
- 8 个 `.claude-plugin/marketplace.json`、46 个 `.claude-plugin/plugin.json`
- 16 个 `hooks.json`、16 个 `.mcp.json`
- 951 个 `SKILL.md`、463 个 `commands/*.md`、365 个 `agents/*.md`
- `C:/Users/zsp/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/lib/state.mjs:9`（`CLAUDE_PLUGIN_DATA`）、`scripts/session-lifecycle-hook.mjs:36-39`（`CLAUDE_ENV_FILE`）

**B 面（dsh 源码）**
- `packages/skill/skill/src/index.ts:20`(SKILL_NAME) `:27`(BUNDLED_SKILL_RANK) `:74-83`(SkillCandidate) `:248-268`(SkillProvider) `:556-565`(层合并) `:573-581`(撞名丢弃) `:807-811`(排序)
- `packages/skill/skill-filesystem/src/index.ts:36-40`(ranks) `:49-89`(Config) `:241-261`(roots) `:719-747`(discoverRoot) `:793-835`(parseSkillFile) `:992-1008`(invocation + 驼峰拒绝) `:1031-1037`(metadata)
- `packages/skill/skill-filesystem/README.md`（"Nested `**/SKILL.md` discovery is deliberately excluded"）
- `packages/skill/tool-skill/src/index.ts:177-204`(用户调用) `:409`(SKILL_GESTURE)
- `packages/interaction/commands/src/index.ts:25`(COMMAND_NAME) `:40-55`(CommandDefinition) `:102-109`(parseCommand) `:245-252`(register)
- `packages/hooks/hooks-claude-code/src/config.ts:11-19`(7 事件) `:57-62`(substituteCommand) `:96-123`(parse)
- `packages/hooks/hooks-claude-code/src/index.ts:44-70`(Config) `:104`(读一次) `:137-187`(runPoint) `:148-151`(env) `:206-295`(事件接线) `:304`(SUBAGENT_TYPE) `:346`(stop_hook_active)
- `packages/hooks/hooks-claude-code/README.md`（**23/30 不支持事件清单 + 逐事件 partial 说明**）
- `packages/hooks/hook-protocol/src/matcher.ts:13-18,57-65`、`src/runner.ts:19,95-104`、`src/types.ts:56-71,89-137`
- `packages/mcp/mcp-client/src/index.ts:50-96,107-128,143-152`
- `packages/subagent/subagent/src/types.ts`（SubagentStartRequest / SubagentCapabilities）、`packages/subagent/tool-subagent/src/index.ts:30-98`
- `packages/preset/agent-presets/src/discovery.ts:26`、`src/metadata.ts:26`
- `packages/lsp/lsp-stdio/src/index.ts:55-105`
- `packages/core/scope/src/store.ts:43-54`（重名 throw）
- `apps/cli/src/args.ts:171-180`、`apps/cli/reference/README.md:9-11`、`docs/user/develop/basic/publish.md`
- `.agents/notes/implemented/feature/2026-06-30-hook-bridges.md`（设计取舍 + 5 条 deferred gap）
- `.agents/notes/implemented/feature/2026-07-31-even-out-shipped-tool-rosters.md:37`（"MCP 桥接尚不存在，形态应与 hooks-claude-code 相同"）
