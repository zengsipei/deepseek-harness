# Wayfinder research: npm 发布状态 + React 版本隔离

调研日期 2026-08-17。仓库 `F:/zsp/Ai/deepseek-harness`（fork，本地 checkout 停在 `0.1.0-rc.5` / commit `6310c7e155`）。
所有结论基于一手证据：`npm view` 实测、下载的已发布 tarball、实际跑通的 TypeScript 编译与 Node 运行时探针。

---

## 两个结论先行

### (A) 钉 npm 版：**可行，且比地图假设的更好** —— 但需要改一个前提

**可行。** 前序 charting 的观察（`ui-slots` 在 registry 上只有 `0.0.1-rc.1`）是**被 dist-tag 误导的假象**。真实情况：

- 四个 TUI 路线包（ui-slots / modules / connection / runtime）**全部已发布，全部到 `0.1.0-rc.7`**，比本仓 HEAD（rc.5）还**新两个 rc**。
- `@deepseek-ai/cordis` 已作为 **`4.0.1` 正式版（非 prerelease）**公开发布，peer 依赖有解。
- 整条传递依赖闭包（20+ 个包全查过）无一缺失。
- **rc.5 → rc.7 的公开 API 漂移为零**：43 + 16 + 5 个已发布 `.d.ts` 与本地构建**逐字节相同**。

**必须改的前提**：`latest` dist-tag 是**坏的**，停在 `0.0.1-rc.1`（2026-08-10 首发版）。
不带版本 `npm install @deepseek-ai/dsh-client-ui-slots` 会装到 8 月 10 日的化石版本。
→ 钉死版本不只是"好习惯"，是**强制要求**；或者显式用 `next` tag。

**但地图真正该担心的不是版本，是产物形态**（见 A.5 / 退路一节）：
`client-runtime` / `client-connection` / `client-modules` 的 `lib/client.js`（承载全部实质代码）是
`window.__ModuleLoader__.load(...)` 的**浏览器 bundle**，不是 Node 可直接 import 的模块。
`lib/index.js`（Node face）里 runtime 是 **6 行空壳**，connection 只有**服务端**那半边。

### (B) React 19 隔离：**成立，而且不需要独立进程就成立**

**成立。** 三层证据：

1. **类型层**：dsh 包的 `@types/react@~18.3.1` 全在 **devDependencies**（不是 peer / 不是 dep），
   对外部消费者**根本不安装**。实测外部工程只有**一份** `@types/react@19.2.18`，无版本共存 → 无冲突可能。
2. **编译层**：已发布 `ui-slots` + `client-runtime` 全部声明面，在 `@types/react@19.2.18` +
   `skipLibCheck: false` + NodeNext 下编译，**零错误**。`renderRoot` 甚至接受 React 19 独有的
   `bigint` / `Promise<AwaitedReactNode>` 返回值。
3. **运行时层**：在 Node 里 shim `window.__ModuleLoader__`、把 **React 19.2.8** 喂进 seed 表，
   已发布的 `client-runtime/client` bundle **加载成功、`SlotRegistry` 构造成功、
   declare→register→install(React 19 renderRoot)→dispose 全流程跑通，零 seed miss**。

"seed 表共享单一 React 实例"是**同进程运行时约束**，作用域是 **web shell 的 bundle 加载机制**
（`packages/client/web/src/seed.ts`），**不是**任何 dsh 包的版本钉死。它是一张普通的
`Map<specifier, module>`：**谁 seed 谁说了算**。TUI 进程 seed React 19，bundle 拿到的就是 React 19。

→ **TUI 可以用 React 19 + ink 7.x，不需要改 dsh 本体。**
→ 独立进程能让约束更干净，但**不是前提**。那张"React 18/19 冲突"票**可以关掉**。

---

## A 部分 —— npm 发布状态与外部依赖可行性

### A.1 / A.2 发布状态表

`npm view <pkg> versions --json` + `dist-tags`，2026-08-17 实测。

| 包名 | `latest` tag | **真实最新（`next`）** | 本仓版本 | 落后程度 | TUI 够用？ |
|---|---|---|---|---|---|
| `@deepseek-ai/dsh-client-ui-slots` | `0.0.1-rc.1` ⚠️坏 | **`0.1.0-rc.7`** | `0.1.0-rc.5` | registry **领先** 2 个 rc | ✅ 完全够用（纯 ESM，Node 可跑） |
| `@deepseek-ai/dsh-client-modules` | `0.0.1-rc.1` ⚠️坏 | **`0.1.0-rc.7`** | `0.1.0-rc.5` | 领先 2 | ⚠️ 已发布但**对 TUI 无用**（服务 web bundle 机制） |
| `@deepseek-ai/dsh-client-connection` | `0.0.1-rc.1` ⚠️坏 | **`0.1.0-rc.7`** | `0.1.0-rc.5` | 领先 2 | ⚠️ Node face 只有**服务端**；客户端在浏览器 bundle 里 |
| `@deepseek-ai/dsh-client-runtime` | `0.0.1-rc.1` ⚠️坏 | **`0.1.0-rc.7`** | `0.1.0-rc.5` | 领先 2 | ⚠️ Node face 是 6 行空壳；实体在浏览器 bundle 里 |
| `@deepseek-ai/dsh-client-web-react` | `0.0.1-rc.1` ⚠️坏 | **`0.1.0-rc.7`** | `0.1.0-rc.5` | 领先 2 | — TUI 不需要（且它 dep 了 React 18 + uSES 1.2.0） |
| `@deepseek-ai/cordis` | **`4.0.1`** ✅正常 | `4.0.1-rc.4` | `4.0.1` | **一致** | ✅ 正式版，peer 有解 |
| `@deepseek-ai/dsh` | `0.1.0-rc.6` | **`0.1.0-rc.7`** | `0.1.0-rc.5` | 领先 2 | ✅ |

**全部 8 个版本**（每个 client 包相同）：`0.0.1-rc.1/2/3/5`、`0.1.0-rc.2/3/6/7`。

**传递依赖闭包全部已发布**（逐个 `npm view` 验证过，均为 `next: 0.1.0-rc.7`）：
`dsh-invariants`、`dsh-host-webserver`、`dsh-api-remotes`、`dsh-typert-protocol`、`dsh-typert-registry`、
`dsh-attachment`、`dsh-host-apiproxy`、`dsh-commands`、`dsh-session`、`dsh-tools`、`dsh-llm`、`dsh-agent`、
`dsh-llm-retry`、`dsh-session-title`、`dsh-session-projection`、`dsh-base`。
vendor 家族：`cordis-plugin-loader@1.0.2`、`cordis-plugin-include@1.0.6`、`cosmokit@1.8.2`、`schemastery@3.18.1`。
**没有一个缺失。**

**Node 原生 SDK 层也已发布**（对 TUI 更重要，见退路）：
`@deepseek-ai/dsh-sdk-client`、`-sdk-protocol`、`-sdk-jsonrpc-server`，均 `0.1.0-rc.7`，
`package.json` 无 `dsh.client` 块 → **纯 Node 包，零 React**。

### A.3 发布节奏与机制

**证据位置**：`.github/workflows/release.yml`、`release-vendor.yml`、`scripts/release/publish.ts`、
`scripts/check-workspace-constraints.ts:244-312`、`git log --grep="release("`。

- **谁在发**：npm maintainer 是 `imccyu <imccyu@gmail.com>` 与 `tianyicui-deepseek <tianyi@deepseek.com>`。
  tarball 的 `_resolved` 显示构建路径 `/home/runner/work/deepseek-harness/deepseek-harness/dist/npm/...`
  → **从上游 `deepseek-ai/deepseek-harness` 的 GitHub Actions 发布，不是从本 fork**。
- **发什么**：`Release (dsh)` 一次发 `packages/**` 全部 + `apps/*`，**统一一个版本号**
  （`check-workspace-constraints` 强制 `manifest.version === repositoryVersion`）。
  vendor 家族（9 个 rescoped cordis 包）是**独立序列**，各自版本线，独立 workflow。
- **怎么发**：`workflow_dispatch` 手动触发，必须从 `dsh-v*` tag 跑，
  经 `environment: npm-publish`（required reviewers）。pack 在每个 PR / master push 上都跑（无凭证），
  所以"能不能打包"一直有信号；只有发布这一步需要人。
- **幂等**：`publish.ts` 逐包对 registry 比对 `dist.integrity` —— 缺失则发、相同则跳过、
  **不同则整个 run 失败**（内容变了却没升版本）。

- **⚠️ 为什么 client 包"落后"—— 它根本没落后，是 dist-tag 坏了**：
  `scripts/release/publish.ts` 里一行：
  ```js
  const tagArgs = version.includes('-') ? ['--tag', 'next'] : []
  ```
  **每个 prerelease 都发到 `next`，永远不碰 `latest`**。
  npm 在一个包**首次发布**时会无条件把 `latest` 指向那一版 —— 于是 `latest` 被永久钉死在
  2026-08-10 首发的 `0.0.1-rc.1`，此后再没被更新过。
  （`@deepseek-ai/dsh`、`dsh-agent`、`dsh-typert-protocol` 的 `latest` 是 `0.1.0-rc.6`，
  说明**有人手工 `npm dist-tag add` 修过这三个**，其余几十个没修。这是运维疏漏，不是发布策略。）
  **本仓 rc.5 vs registry rc.7 的差距方向是：registry 更新，本地 checkout 更旧**
  （本地 `.git/FETCH_HEAD` 停在 2026-08-15，upstream 已发过 rc.6/rc.7）。

### A.4 已发布 API vs 本仓 HEAD 的差距：**零**

对比方式：`npm pack` 下载 rc.7 tarball 到 `C:/Users/zsp/AppData/Local/Temp/dshpack/`，
逐文件 diff 已发布 `.d.ts` 与本地 `packages/client/*/lib/types/*.d.ts`（本地是 rc.5 构建产物）。

```
runtime:    0 of 43 published .d.ts differ from local rc.5
connection: 0 of 16 published .d.ts differ from local rc.5
modules:    0 of  5 published .d.ts differ from local rc.5
ui-slots:   index/renderer/store/invariant 全部 0 changed lines
```

**跨 rc.5 → rc.6 → rc.7 三个版本，client 层公开 API 逐字节未变。**
这是"钉版本、升级时才付适配税"策略最有力的支撑：适配税近期实测为 0。
（本地多出的 `.js` / `.d.ts.map` 只是 `files` 字段没选进 tarball，非 API 差异。）

### A.5 exports / 类型 / peerDeps —— 外部能否消费

**能消费，但要知道 `./client` 是什么。**

统一 `exports` 形状（四个包一致）：
```json
{ ".":          { "types": "./lib/types/index.d.ts",        "default": "./lib/index.js" },
  "./client":   { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
  "./invariant":{ "types": "./lib/types/invariant.d.ts",    "default": "./lib/invariant.js" },
  "./src/*": "./src/*", "./package.json": "./package.json" }
```
- ✅ `types` + `default` 条件齐全，`"type": "module"`，NodeNext 友好。
- ⚠️ **`./src/*` 在 dsh 包里是死导出**：`files` 只选 `lib/*.js` + `lib/types/**/*.d.ts`，
  tarball 里**没有 `src/`**。（`@deepseek-ai/cordis` 例外，它确实发了 `src/` 和 `.d.ts.map`。）
- ⚠️ **`./client` 不是 Node 模块**。实测：
  ```
  node -e "await import('@deepseek-ai/dsh-client-runtime/client')"
  → ReferenceError: window is not defined   (lib/client.js:1)
  ```
  `lib/client.js` 首行就是 `window.__ModuleLoader__.load({ id, factory: (require) => {...} })`。
  它把自己注册进 shell 的冻结模块表，externals 全走 loader 给的 `require`。
  - `client-runtime`：`lib/client.js` **10538 行**（SlotRegistry / SessionRuntime / sessions / workspaces 全在这），
    而 `lib/index.js` 是 **6 行空 `apply`**。
  - `client-connection`：`lib/client.js` 10206 行 = **wire 的客户端**；
    `lib/index.js` 588 行 = **wire 的服务端**（`HostConnectionService`、`ws`、`WebSocketServer`、`node:crypto`）。
    TUI 想要的那半边在 bundle 里。
  - `client-modules`：`lib/index.js` 是构建 web bundle 表的 Node 侧工具，对 TUI 无用。
  - `ui-slots`：**唯一例外，没有 `client.js`**。`lib/index.js` 是纯 ESM、零 import，
    实测 `node -e "import('@deepseek-ai/dsh-client-ui-slots')"` 正常，导出
    `SlotCore, SlotOwnershipError, StaleAuthorizationError, resolveSlotLabel`。

**"NodeNext consumer check" 具体查什么**（`scripts/verify-node-next-types.ts`，`hygiene` 的一环）：
1. 扫所有已构建 `.d.ts`，**禁止无扩展名的相对 specifier**（NodeNext 硬性要求 `./x.js` 而非 `./x`）。
2. 造一个临时工程，把每个 workspace 包 symlink 进 `node_modules`，写
   `module/moduleResolution: NodeNext`、`strict: true`、`skipLibCheck: true` 的 tsconfig，
   生成一个 `import * as modN from "<每个 exports 入口>"` 的 `index.ts`，跑 `tsc --noEmit`。
   → 证明**每个公开 specifier 在标准外部 ESM 工程里能解析并编译**。
   注意它 `skipLibCheck: true`；我自己的探针用 `skipLibCheck: false` 跑，一样零错误。

配套的 `scripts/release/verify-packed-install.ts`：把打包好的 tarball 用**纯 `npm install`**
（不是 pnpm、不是 workspace link）装进 `os.tmpdir()` 下的一次性工程并驱动可执行入口 ——
即"外部消费者能装能跑"这件事在每个 PR 上都被验证。

### A.6 `@deepseek-ai/cordis` peer 怎么提供

**registry 上有，`4.0.1` 正式版，外部插件直接 `npm i @deepseek-ai/cordis@^4.0.1` 即可。**

- 约束来源：`scripts/check-workspace-constraints.ts:301-307` —— 每个 `packages/**` 下的
  `@deepseek-ai/dsh-*` 包**必须**同时把 `@deepseek-ai/cordis` 列为 peerDependency **和** devDependency，
  且两个 range 必须一致。发布时 `workspace:^` 被改写为 `^4.0.1`。
- cordis 自己的 peer：`cordis-plugin-loader@^1.0.2` + `cordis-plugin-include@^1.0.6`，
  但都标了 `peerDependenciesMeta.optional: true`，两者也都已发布。

**⚠️ AGENTS.md 那句话已经过时**。AGENTS.md 写：
> vendored packages are rescoped and `private: true`

**实测 `vendor/` 下 9 个包无一 `private: true`，全部 `publishConfig.access: "public"`**：
```
cordis 4.0.1 / cosmokit 1.8.2 / cordis-plugin-group 1.0.1 / hmr 1.0.16 / include 1.0.6
loader 1.0.2 / logger-console 1.0.1 / schemastery 3.18.1 / timer 1.1.3   ← private=false, access=public
```
`check-workspace-constraints.ts:255-259` 现在**强制** release member 不得 `private: true` 且必须
`access: "public"`。cordis 不是"例外"，是**规则本身变了**
（commit `8c1e8d9890 build(release): publish the dsh family publicly`）。
constraints 脚本里那段"the dsh family stays restricted until its own sequence goes public"的注释
也已经和它下面的代码矛盾了。

### A.7 A 部分结论

**钉 npm 版可行，不需要推动任何发布，也不需要本地链接** —— 前提是接受产物形态的现实：

- 只用 `ui-slots`（+ Node 原生 `sdk-client` / `sdk-protocol`）→ **完全干净的 npm 消费**，零 hack。
- 要用 `client-runtime` / `client-connection` 的实体 → 必须在 Node 里 shim `window.__ModuleLoader__`。
  **实测可行**（见 B.4），但依赖的是一个**内部、未文档化的 seam**，上游改它不会当作 breaking change。

---

## B 部分 —— React 版本隔离

### B.1 四个包里有没有 React 版本钉死？逐项

| 包 | `peerDependencies` react | `dependencies` react | 打进包的 `react/jsx-runtime` | `@types/react` | 判定 |
|---|---|---|---|---|---|
| `ui-slots` | ❌ 无 | ❌ 无 | ❌ 无（`lib/index.js` **零 import**） | `~18.3.1` 仅 **devDep** | ✅ **完全不钉** |
| `modules` | ❌ 无 | ❌ 无 | ❌ 无（全包 react 提及数 = **0**） | ❌ 无 | ✅ **完全不钉** |
| `connection` | ❌ 无 | ❌ 无 | ❌ 无（全包 react 提及数 = **0**） | ❌ 无 | ✅ **完全不钉** |
| `runtime` | ❌ 无 | ⚠️ **`react: ^18.2.0`** | ❌ 无（bundle 只 `require` cordis + ui-slots） | `~18.3.1` 仅 **devDep** | ⚠️ **声明了但没用** |
| `web-react`（不需要） | ❌ 无 | ⚠️ `react: ^18.2.0` + `use-sync-external-store@1.2.0` | — | `~18.3.1` devDep | ⚠️ 真钉，但 TUI 用不到 |

**证据位置**：已发布 tarball
`C:/Users/zsp/AppData/Local/Temp/dshpack/x-deepseek-ai-dsh-client-*/package/`，
以及本仓 `packages/client/*/package.json`（本地与已发布 manifest 除 `workspace:^` → `^0.1.0-rc.7` 改写外一致）。

**关键细节**：
1. **没有任何包把 react 放进 `peerDependencies`。** 这是最重要的一条 —— peer 才是会把版本约束
   传染给消费者的位置，而它是空的。
2. **`@types/react@~18.3.1` 全部在 `devDependencies`。** devDep 不安装给消费者，
   published tarball 里也没有 `node_modules`。**它对外部工程完全不可见。**
3. **`runtime` 的 `react: ^18.2.0` 是 dependencies 里的死依赖**：
   已发布 `lib/client.js` 的 bare specifier 全集实测只有两个 ——
   ```
   require("@deepseek-ai/cordis")
   require("@deepseek-ai/dsh-client-ui-slots")
   ```
   所有 react 提及（23 处）**全是注释**，包括几处明确写着 "React-free runtime"、
   "React bindings remain outside this data layer"。zustand 的 `vanilla`/`middleware`/`shallow`
   被 tsdown **内联**进 bundle，运行时连 zustand 都不 require。
   → 副作用：`npm install` 会在 `node_modules/@deepseek-ai/dsh-client-runtime/node_modules/react`
   下装一份 **18.3.1** 的死代码（实测确认）。**浪费磁盘，不构成运行时危害**，但值得让上游清掉。
4. **`.d.ts` 里的 react 类型引用只有两处**，都在 `ui-slots`，都是 **type-only**：
   ```
   ui-slots/lib/types/index.d.ts:11    import type { ReactNode } from 'react';
   ui-slots/lib/types/renderer.d.ts:2  import type { ReactNode } from 'react';
   ```
   `runtime` / `connection` / `modules` 的 `.d.ts` **没有任何 `from 'react'`**
   （`runtime` 只是 `import type { SlotRenderer } from '@deepseek-ai/dsh-client-ui-slots'` 间接触达）。

### B.2 TypeScript 层会不会打架？**不会 —— 因为根本不会共存**

**先看类型本身的实际差异**（下载 `@types/react@18.3.31` 与 `@19.2.18` 对比）：

```ts
// 18.3.31 index.d.ts:486
type ReactNode = ReactElement | string | number | Iterable<ReactNode>
               | ReactPortal | boolean | null | undefined | DO_NOT_USE_...;

// 19.2.18 index.d.ts:436
type ReactNode = ReactElement | string | number | bigint | Iterable<ReactNode>
               | ReactPortal | boolean | null | undefined | DO_NOT_USE_...
               | Promise<AwaitedReactNode>;          // ← 19 新增
```
- 19 **新增** `bigint` 和 `Promise<AwaitedReactNode>` 两个成员。
- `ReactFragment` 在 18 里是 `type ReactFragment = Iterable<ReactNode>`（18.3.31:448），
  **19 里彻底删除**（grep 全文件零命中）。但它本身不是 `ReactNode` 的联合成员，
  `Iterable<ReactNode>` 已覆盖其语义 → **删除不影响 `ReactNode` 的结构**。
- `ReactElement<P>` 默认参数从 `P = any`（18:329）改成 `P = unknown`（19:326）。
  `any` 双向可赋值，所以这条在两个方向上都不卡。

**方向性**：18 的 `ReactNode` 是 19 的**子集** → `18 → 19` 可赋值，`19 → 18` 不可
（`bigint` / `Promise` 多出来）。所以**如果**两份类型共存，风险方向是"19 的值喂给 18 的槽"。

**但它们不会共存。** 实测证据：

```
外部工程 node_modules 里的 @types/react 拷贝数 = 1
node_modules/@types/react/package.json  →  19.2.18
（dsh 包的 ~18.3.1 是 devDep，未安装）
```

具体到 `SlotRenderer.renderRoot`：
```ts
// ui-slots/lib/types/renderer.d.ts:187-194（已发布原文）
export interface SlotRenderer {
    renderRoot(host: SlotRendererHost, ownerProps: object): ReactNode;
}
```
这里的 `ReactNode` 由**消费者工程唯一那份 `@types/react`** 解析。外部包装 19，它就是 19 的 `ReactNode`。
消费者同时是 `renderRoot` 的**实现方**和结果的**读取方** —— 全程同一个类型，**不存在跨版本比较**。

**实跑验证**（`C:/Users/zsp/AppData/Local/Temp/tui-probe/`）：
外部 NodeNext ESM 工程，装已发布 tarball + `@types/react@19.2.18`，`skipLibCheck: false`：
```ts
const r19: SlotRenderer = {
  renderRoot(): ReactNode {
    if (pick === 0) return 123n                        // bigint —— React 19 独有
    if (pick === 1) return Promise.resolve('async node') // Promise<AwaitedReactNode> —— React 19 独有
    return createElement('span', null)
  },
}
import * as runtime from '@deepseek-ai/dsh-client-runtime'
import * as runtimeClient from '@deepseek-ai/dsh-client-runtime/client'
import * as cordis from '@deepseek-ai/cordis'
```
→ **`tsc` 零错误。** 连 React 19 独有的返回值都被已发布契约接受。
（`skipLibCheck: false` 意味着已发布的 `.d.ts` 本身也被完整检查过，同样零错误。）

### B.3 「seed 表共享单一 React 实例」的确切作用域：**同进程运行时约束，作用域=web shell 的 bundle 加载**

**来源定位到了**：`F:/zsp/Ai/deepseek-harness/packages/client/web/src/seed.ts`
（+ 常量表 `packages/client/web/src/platform.ts`）。

```ts
/**
 * Platform-singleton module-table. These are the ONLY entities the shell
 * shares into the frozen module table — fetch bundles resolve their externals
 * against exactly this set through the loader's require. ...
 * values stay shell-static imports so every bundle sees the same instance.
 */
import * as React from 'react'
import * as ReactJsxRuntime from 'react/jsx-runtime'
...
export function getStaticModules(): Record<string, unknown> {
  return { 'react': React, 'react/jsx-runtime': ReactJsxRuntime, 'react-dom': ReactDom,
           'react-dom/client': ReactDomClient, '@deepseek-ai/cordis': Cordis,
           '@deepseek-ai/dsh-client-ui-slots': UiSlots, ... } satisfies Record<PlatformModule, unknown>
}
```

**判定：是运行时约束，不是构建/类型约束。**
- **机制**：web 插件 bundle 编译时把 `react` 等标成 **external**；运行时 cordis loader 给 factory
  注入一个 `require`，从这张冻结表里取。目的是**让同一个浏览器页面里所有动态 fetch 的插件 bundle
  共用 shell 那一个 React 实例**（否则每个 bundle 自带一份 React，hooks 直接炸）。
  这是经典的 single-React-instance 要求。
- **它不约束版本**：表里的值就是 shell 静态 import 进来的东西。shell 现在 import React 18，
  于是表里是 React 18。**换成谁 seed 就是谁**。表本身对版本一无所知。
- **作用域边界**：`packages/client/web`（浏览器 shell）+ `apps/web` 的 vite 构建 + tsdown client externals。
  **`packages/client/*` 的库包本身完全不参与** —— 它们只是被 seed 的对象，不是 seed 的执行者。
- **相关但不同的一条**：`.agents/notes/implemented/architecture/2026-08-06-web-shell-dist-chunk-layout.md:38`
  的 "react belongs to index" —— 那是 **rollup manualChunks 的分包不变量**
  （vendor chunk 成员必须 react-free，否则 rollup 的 shared-module folding 会把
  "单份 react 拷贝"拖进 vendor chunk）。纯 **web dist 打包**关切，与外部插件无关。
- **补充事实**：全仓 39 个包声明 `dsh.client.platform`，取值**全部是 `"web"`**，没有第二种平台。
  client 层整个是浏览器层。
- **没有任何版本级钉死机制**：`pnpm-workspace.yaml` 的 `peerDependencyRules.allowedVersions`
  只有 `typescript: '>=5 <7'`，**没有 react 条目**；根目录**没有 `.npmrc`**；
  `overrides` 只有 cosmokit / schemastery 两条 `link:vendor/*`；tsconfig 的 `paths` 只做
  workspace 源码解析，与 react 无关。

### B.4 独立进程之后哪些约束还在？

| 约束 | 独立进程后 | 说明 |
|---|---|---|
| seed 表单一 React 实例 | **仍在，但由 TUI 自己掌控** | TUI 进程建自己的 seed 表，塞 React 19。表是普通 Map，无版本校验。 |
| host 进程的 React 18 | **完全消失** | 跨进程，两个 V8 堆，不可能共享模块图。 |
| `web-react` 的 `use-sync-external-store@1.2.0`（peer 不接受 React 19） | **消失** | TUI 不引 `web-react`；ink 有自己的 reconciler。 |
| rollup "react belongs to index" 分包不变量 | **消失** | 那是 `apps/web` 的 vite 构建，TUI 不走。 |
| `client-runtime` dep 里的死 `react@^18.2.0` | **仍会被安装** | 但 bundle 从不 require 它，纯占空间。可用 npm `overrides` 消掉。 |
| `.d.ts` 的 `ReactNode` 类型解析 | **仍在，但解析到 19** | 消费者工程唯一那份 `@types/react` 说了算。 |

**实跑验证 —— Node 里 shim seed 表，喂 React 19**
（`C:/Users/zsp/AppData/Local/Temp/tui-probe/shim2.mjs`）：
```js
globalThis.window = { __ModuleLoader__: { load: ({ id, factory }) => table.set(id, factory) } }
registry.set('react', await import('react'))                    // ← React 19.2.8
registry.set('@deepseek-ai/cordis', await import('@deepseek-ai/cordis'))
registry.set('@deepseek-ai/dsh-client-ui-slots', await import('@deepseek-ai/dsh-client-ui-slots'))
await import('@deepseek-ai/dsh-client-runtime/client')
```
输出：
```
loaded bundle: @deepseek-ai/dsh-client-runtime/client
seed misses while evaluating runtime factory: (none)
registered root; root entries: 1 | panel declared: { kind: 'list', scope: 'root' }
panel entries after register: 1
install() accepted a React 19 renderRoot: OK
after dispose, root entries: 0 | panel entries: 0
```
`SlotRegistry` 在真实 `cordis.Context()` 上构造成功，declare → register → install(React 19 `renderRoot`)
→ dispose 全流程跑通，**零 seed miss，零浏览器 API 依赖（除 `window.__ModuleLoader__` 这个壳）**。
bundle 暴露 34 个导出，含 `SlotRegistry` / `SessionRuntime` / `SessionProvideChannel` / `WorkspaceRuntime`。

*诚实标注*：这是 **load + construct + 槽位增删** 级别的验证，**不是**完整会话驱动
（没连真实 host、没跑 RPC、没验证 `connection` 的 client bundle —— 后者需要更多 seed 词与可能的
`WebSocket`/`fetch` 浏览器全局，未取证）。

### B.5 B 部分结论

**TUI 能在不改 dsh 本体的前提下用 React 19 + ink 7.x。**

- 依赖层**没有任何 React 版本钉死**能传染到外部消费者：react 不在任何 peer，`@types/react` 只在 devDep。
- 类型层已实测零错误（含 React 19 独有的 `ReactNode` 成员）。
- 运行时层的"单一 React 实例"是**每进程一张、由宿主自己填**的 seed 表 —— TUI 填 19 就是 19。
- 唯一真钉 React 18 的是 `web-react`（含 `use-sync-external-store@1.2.0`，peer 明确排斥 React 19），
  **TUI 路线不需要它**。
- **独立进程能让这件事更干净（彻底消灭 host 的 React 18），但不是成立的前提。**
- → 那张"React 18/19 冲突"票**可以关闭**。

---

## 若不可行的退路

钉 npm 版这条路**在版本可用性上没有走不通的风险**（包齐、版本新、API 零漂移）。
真正需要退路的是**产物形态**：`client-runtime` / `client-connection` 的实体只存在于浏览器 bundle 里。
按代价从低到高：

### 退路 0（推荐，其实是正路）：绕开 client 层，走 Node 原生 SDK
- 用 `@deepseek-ai/dsh-client-ui-slots`（纯 ESM、零依赖、Node 直跑）拿槽位模型，
  用 `@deepseek-ai/dsh-sdk-client` + `-sdk-protocol`（**已发布 `0.1.0-rc.7`，纯 Node，零 React**）连 host。
- **代价**：`SessionRuntime` 的会话投影/对话装配逻辑要自己写一遍（这是 runtime bundle 里最厚的部分）。
- **收益**：全程标准 npm 消费、零 hack、不依赖任何未文档化 seam、上游改 bundle 机制也不影响你。

### 退路 1：shim `window.__ModuleLoader__`，复用浏览器 bundle
- 已实测可行（B.4）。TUI 进程建 seed 表，塞自己的 React 19。
- **代价**：依赖一个**内部、未文档化**的加载 seam。上游改 bundle wrapper 形状（改 `window` 挂载点、
  改 factory 签名、增加新的 external 词）**不会被当作 breaking change**，你会在升级时静默炸。
  需要为此写一个 shim 的契约测试，钉死在某个 rc 上。
- `connection` 的 client bundle 可能还需要 `WebSocket` / `fetch` 全局垫片（Node 22+ 原生有，但**未取证**）。

### 退路 2：本地链接开发 + 发布时切换
**形态**：插件仓库用 `pnpm-workspace.yaml` 的 `link:` / `file:` 或 pnpm `overrides` 指向
`F:/zsp/Ai/deepseek-harness/packages/client/*`，`package.json` 里依然写 `^0.1.0-rc.7`，
发布前 `pnpm install --frozen-lockfile` 走 registry 验一遍。

**代价（明确列出来）**：
1. **每 6 小时的 fork 自动同步变成你的问题**。现在 `sync-fork.yml` 的 `cron: '17 */6 * * *'`
   拉上游到 fork；一旦本地链接，上游任何 client 层改动都会**立刻**打到你的插件构建上，
   而不是在你主动升版本时。**这正是地图策略要避免的东西**。
2. **必须先构建 dsh**：链接到的是 `lib/`，不是 `src/`。要跑 `pnpm run build:lib:client`
   （前置 `tsc -b tsconfig.client.json`），全仓构建、耗时长、还得处理 vendor rescope。
3. **peer 依赖要手工铺齐**：`runtime` 的 peer 有 5 个（`cordis` / `invariants` / `api-remotes` /
   `typert-protocol` / `typert-registry`），workspace link 下 pnpm 帮你解，脱离 workspace 就得自己声明。
4. **两套解析路径的漂移风险**：本地链接跑通 ≠ npm 装出来跑通
   （`files` 漏文件、`exports` 缺条件在链接模式下看不见 —— 这正是上游写
   `verify-packed-install.ts` 的原因）。你需要自己复刻一个"打包安装验证"。
5. **`@types/react` 会被拖进来**：workspace link 会让 dsh 的 devDep（含 `@types/react@~18.3.1`）
   进入解析图 —— **B 部分那个"只有一份 @types/react"的前提就没了**，React 18/19 类型冲突
   **会真的出现**。这是退路 2 最坏的副作用：它把已经解决的 B 问题重新引入。

**结论：退路 2 不该作为默认选择。** 它同时放弃了 A 的解耦收益和 B 的类型隔离。
只有在需要**同时改 dsh 本体和插件**时才短期启用，且用完就切回。

### 无论走哪条，都要做的两件事
1. **钉死精确版本**（`0.1.0-rc.7`，不带 `^`），因为 `latest` tag 是坏的。
   或在 CI 里显式 `npm i <pkg>@next` 并锁 lockfile。
2. **给上游提两个 issue**（都是小修，能显著降低外部消费摩擦）：
   - `latest` dist-tag 停在 `0.0.1-rc.1`，几十个包受影响（`publish.ts` 的 prerelease 分支 + 首发副作用）。
   - `client-runtime` 的 `dependencies.react@^18.2.0` 是死依赖（bundle 从不 require），建议删除。

---

## 对地图 Notes 的修正建议

### 1. 「client 包没发布 / 只有 `0.0.1-rc.1`」—— **删掉，是错的**
> ~~registry 上 `@deepseek-ai/dsh-client-ui-slots` 只有 `0.0.1-rc.1`，client 包落后本体很多~~

**改成**：
> 四个 client 包全部已发布到 `0.1.0-rc.7`（2026-08-17），**比本仓 checkout 的 rc.5 还新**。
> `latest` dist-tag 是坏的（`publish.ts` 让所有 prerelease 只发 `next`，`latest` 被首发版永久占位），
> 所以必须钉精确版本或用 `next` tag。传递依赖闭包完整，`@deepseek-ai/cordis` 已发 `4.0.1` 正式版。

### 2. 「依赖 npm 发布版并钉死版本」这条策略 —— **保留，并补上依据**
**补充**：
> 依据：rc.5 → rc.7 三个版本间，client 层已发布 `.d.ts` 与本地构建**逐字节零差异**
> （runtime 43/43、connection 16/16、modules 5/5、ui-slots 4/4）。适配税近期实测为 0。

### 3. 「React 18/19 冲突需要解决」—— **降级为已解决，关票**
**改成**：
> React 18/19 冲突**在依赖层不存在**：react 不在任何 dsh 包的 `peerDependencies`；
> `@types/react@~18.3.1` 只在 `devDependencies`（对消费者不可见）。
> 外部工程只会有一份 `@types/react`，实测 `@types/react@19.2.18` + `skipLibCheck: false`
> 编译已发布 `ui-slots` + `client-runtime` 全声明面**零错误**。
> 唯一真钉 React 18 的是 `client-web-react`（含 `use-sync-external-store@1.2.0`，peer 排斥 19），
> **TUI 路线不需要它**。→ React 冲突票可关闭。

### 4. 「seed 表共享单一 React 实例」—— **补作用域，否则会被误读为阻塞项**
**改成**：
> 来源 `packages/client/web/src/seed.ts` + `platform.ts`。它是 **web shell 的同进程运行时约束**：
> 浏览器里所有动态 fetch 的插件 bundle 通过 loader 的 `require` 从一张冻结模块表取 externals，
> 保证共用 shell 那一个 React 实例（避免多份 React 炸 hooks）。
> **它不约束版本** —— 表里的值就是宿主静态 import 进来的东西，谁 seed 谁说了算。
> TUI 进程建自己的 seed 表塞 React 19 即可；**已在 Node 里实跑验证通过**。

### 5. **新增一条 Note：真正的风险不是版本，是产物形态**（这条地图目前缺失）
> `client-runtime` / `client-connection` / `client-modules` 的 `lib/client.js` 是
> `window.__ModuleLoader__.load(...)` 浏览器 bundle，**Node 直接 import 会 `ReferenceError: window is not defined`**。
> 实质代码全在这里：runtime 的 `lib/index.js` 只有 6 行空 `apply`，
> connection 的 `lib/index.js` 只有服务端那半边（`HostConnectionService` + `ws`）。
> **`ui-slots` 是唯一例外**（无 `client.js`，纯 ESM 零依赖，Node 直跑）。
> 两条路：(a) 只用 `ui-slots` + 已发布的 Node 原生 `@deepseek-ai/dsh-sdk-client`/`-sdk-protocol`；
> (b) 在 Node 里 shim `window.__ModuleLoader__` 复用 bundle（已验证可行，但依赖未文档化 seam）。

### 6. 「AGENTS.md 说 vendored 包是 `private: true`」—— **过时，别再引用**
> `vendor/` 下 9 个包全部 `private: false` + `access: "public"`，
> `check-workspace-constraints.ts:255-259` 现在强制如此。AGENTS.md 与该脚本内的注释均已过时。

### 7. 「上游同步跟插件无关」—— **成立，可加强**
> 成立，且更强：发布是**从上游仓库**的 GitHub Actions 手动 dispatch（`environment: npm-publish`，
> 需 reviewer），fork 的 6 小时自动同步只动 git，不动 registry。
> 唯一例外是**退路 2（本地链接）会把这条保证作废**，且会把 `@types/react@18` 拖回解析图、
> 重新引入已解决的 React 类型冲突 —— 所以本地链接不应作为默认开发模式。

---

## 未能取证的项

- `client-connection` 的**浏览器 bundle 在 Node shim 下能否完整工作**（可能还需 `WebSocket`/`fetch`
  全局垫片与更多 seed 词）。只验证了 `client-runtime`。
- 上游 rc.6 / rc.7 的**提交内容**：本地 fork checkout 停在 rc.5，`git tag` 为空（tag 未同步到 fork），
  未联网取 upstream git。API 零漂移是通过 tarball vs 本地构建产物比对间接确立的。
- ink 7.x 与 React 19 的**实际协作**（本票只验证 dsh 侧不阻塞，没验 ink 侧）。

## 证据文件位置

- 已发布 tarball 解包：`C:/Users/zsp/AppData/Local/Temp/dshpack/x-*/package/`
- 外部消费者探针（含 tsconfig、probe.ts、shim.mjs、shim2.mjs）：`C:/Users/zsp/AppData/Local/Temp/tui-probe/`
- 仓库侧关键文件：
  - `F:/zsp/Ai/deepseek-harness/packages/client/web/src/seed.ts`（seed 表本体）
  - `F:/zsp/Ai/deepseek-harness/packages/client/web/src/platform.ts`（seed 词常量）
  - `F:/zsp/Ai/deepseek-harness/scripts/release/publish.ts`（dist-tag 缺陷所在）
  - `F:/zsp/Ai/deepseek-harness/scripts/verify-node-next-types.ts`（NodeNext consumer check）
  - `F:/zsp/Ai/deepseek-harness/scripts/release/verify-packed-install.ts`（外部安装验证）
  - `F:/zsp/Ai/deepseek-harness/scripts/check-workspace-constraints.ts:244-312`（cordis peer / access 规则）
  - `F:/zsp/Ai/deepseek-harness/.agents/notes/implemented/architecture/2026-08-06-web-shell-dist-chunk-layout.md`
