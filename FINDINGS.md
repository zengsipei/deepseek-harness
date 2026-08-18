# #18 shim 全链路探针 — FINDINGS

探针日期 2026-08-19。全部结论来自实跑：真 dsh host（npm 全局 `@deepseek-ai/dsh@0.1.0-rc.7`，`dsh web --port 3210`，隔离 `DSH_HOME`）+ Node 24.19 客户端进程（shim 加载钉死 `0.1.0-rc.7` 的 client bundles）+ 本地 mock OpenAI 上游（无真实凭据依赖，可复跑）。

## 结论先行

**三条产品级往返全部打通，纯 shim 路线压实。**（`stage2.mjs` 一次运行全过）

1. ✅ **prompt → token 流**：`session.prompt()` 接受 → mux WebSocket 推 `assistant/chunk`×N → `assistant/message` → `turn/end`，全部落入 client `Session` store 的 raw event window。
2. ✅ **approval 往返**：escalation 触发 `approval/requested` → snapshot `pending` 出现 `PendingWait` → `respond({ok:true,value:{sessionId,approvalId,outcome:'allowed-once'}})` 收 `{accepted:true}` → host 执行工具 → 后续 turn 最终文本到达。
3. ✅ **sessions.list**：list baseline 即时到达（`phase:'ready'`），新建 session 实时进列表。

契约测试雏形 `shim-contract.test.mjs`（6/6 绿）钉住 wrapper 形状，升级 rc 必须先跑它。

## 逐项回答票面问题

### 1. seed 词表（实测最小集）

六个 bundle 的 externals **封闭集惊人地小**：

| bundle | factory 实际 require 的词 |
|---|---|
| `dsh-client-modules` | （无） |
| `dsh-typert-registry` | `@deepseek-ai/cordis` |
| `dsh-client-connection` | （无） |
| `dsh-api-gateway` | `@deepseek-ai/cordis` |
| `dsh-api-remotes` | （无） |
| `dsh-client-runtime` | `@deepseek-ai/cordis` + `@deepseek-ai/dsh-client-ui-slots` |

**react 不在其中** —— 六个非 UI bundle 一个都不 require react（seed 表只在装 UI bundle 时才需要 react 词）。跨 bundle 引用以 **`<pkg>/client`** 说明符出现（如 ui-conversation require `@deepseek-ai/dsh-client-runtime/client`），shim 的 require 需做 `/client` → 裸包名别名。

### 2. 全局垫片清单（完整）

```js
globalThis.window = globalThis                      // __ModuleLoader__ 挂载点
window.__ModuleLoader__ = { load({id, factory}) }   // 唯一的加载 seam
globalThis.location = { origin: 'http://127.0.0.1:<port>', hostname: '127.0.0.1', search: '' }
```

`location` 一个垫片同时解决三处：`resolveBase()`（否则回落 `http://dsh.internal`）、`?fixture` 检测（`search:''` 保证不误触 fixture 分支）、`isLoopbackHostname`（loopback 信任）。**这就是选用的办法，绕过 apply 手工构造不必要。** 其余零垫片：Node 22+ 原生 `fetch`/`WebSocket` 直接被 `WebApiClient` 使用，无需 polyfill。

### 3. bundle 加载/挂载顺序约束

物化顺序按依赖图（typert → connection → gateway → remotes → runtime）；cordis 挂载用服务注入自然排序，实测按上述顺序 `ctx.plugin()` 后 `ctx.sessions` 在 ~百 ms 内到达。**modules 行可跳过**（#15 绕行成立的实证）：TUI 自建加载表时，其余 bundle 对 `ClientModuleSystem` 零依赖。

cordis 注入面（rc.7 实测，进契约测试）：gateway inject `['typert','connection']`，remotes inject `['remote']`（gateway 提供），runtime inject `['connection','typert','remote','remote.commands']`。

### 4. 失败点与绕法（按发现顺序）

| 失败点 | 绕法 | spec 意义 |
|---|---|---|
| `JSON.stringify(snapshot)` 抛 `cannot get property "toJSON" without inject` | snapshot 里含 cordis 代理对象（`binding.ctx`），遍历必须防御（跳 `ctx` 键 + try/catch） | TUI 渲染层不要盲遍历 snapshot |
| **`ConversationSnapshot.nodes` 恒空** | conversation 节点定义（含 fallback）**全部在 `ui-conversation`**（react 包）注册；六包链路只到 raw event window | **spec 必答**：TUI 要么自带 conversation 定义层（向 `conversationEvents`/`conversationViews` 注册终端版定义），要么直接消费 raw window。`partial`/`nodes`/`turnEnds` 都是定义驱动的 |
| `ui-conversation` 可在 shim 下物化（补 react-dom/web-react/ui-primitives seed + CSS loader hook），但 cordis 面 inject `layout/locale/settingsScope…` 拖全 web UI 栈 | 探针止步于物化验证，不挂载 | TUI 重写 ui 层的决策（地图既定）与之相容 |
| `npm i` 撞 `web-react` 的 `use-sync-external-store@1.2.0` peer 排斥 React 19 | `--legacy-peer-deps`（仅装 UI 包时需要；六包核心链不带 web-react，干净安装） | TUI 包不依赖 web-react 即无此税 |
| katex CSS import 在 Node 下炸（ui-primitives seed 时） | `module.registerHooks` 把 `.css` 载为空模块 | 仅 UI seed 需要 |
| shell 工具参数缺 `description` → `INVALID_ARGS` | mock 补齐 | 无（mock 侧问题） |
| `echo` 在 workspace-write 沙箱内直接放行，不触发 approval | 用 `sandbox_permissions: 'danger-full-access'` + `justification` 触发 escalation | approval UI 的触发语义 = 沙箱升级，不是逐命令确认 |

### 5. 其他压实的事实

- **mux 是全会话推送流**：连接即对每个 attached session 发 `session/subscribed`，新建 session 自动推 `subscribed` + 事件；**没有按 session 的显式订阅 RPC**。重连恢复 = 重开流 + 重拉 history（`since` 参数 v1 未实现）。
- pending 恢复语义：mux 重开时 host **逐字重放**未决 approval/question 的 requested 帧（rpcId 复用），刷新后可继续作答 —— TUI 崩溃重启的 approval 恢复免费。
- host 侧 `session/projection` 帧高频出现（title、stats 等），TUI 可选消费。
- 隔离 `DSH_HOME` + settings.yaml 指 mock provider 即可让真 host 全链跑通，`dsh web` 自动初始化 profile；探针无需真实 API key。

## 产物

- `shim.mjs` — 可复用 shim（load sink + `/client` 别名 + CSS hook + miss 记录）
- `stage2.mjs` — 三往返全链探针（可复跑；前置 `mock-llm.mjs` + `dsh web --port 3210`）
- `shim-contract.test.mjs` — **契约测试雏形**，C1–C5 断言，6/6 绿；每次升 rc 先跑
- `mock-llm.mjs` — OpenAI 兼容 SSE mock（文本流 / tool_call escalation 两种脚本）
- `stage1.mjs` / debug-*.mjs — 加载面与逐层调试探针

## 复跑方法

```sh
npm i                                # package.json 已钉死全部 rc.7
node mock-llm.mjs &                  # 127.0.0.1:9410
DSH_HOME=$PWD/dsh-home PROBE_LLM_KEY=x dsh web --port 3210 &   # dsh@0.1.0-rc.7
node stage2.mjs                      # 期待尾行 ALL THREE ROUND TRIPS OK
node --test shim-contract.test.mjs   # 契约测试
```
