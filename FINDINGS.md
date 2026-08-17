# Wayfinder research — TUI 作为第二个 `SlotRenderer`（ink 后端）可行性

调研日期：2026-08-17 · 仓库：`F:/zsp/Ai/deepseek-harness` · 以读源码为准

---

## 结论先行

**(b) 可行，但需要 X。**

一句话理由：`SlotRenderer`/`SlotRendererHost` 契约本身**已经是 reconciler 无关**的（只有 `ReactNode` 一个类型面），`packages/client/runtime` 在**运行时零 React 引用**（构建产物只 require cordis + ui-slots），`web-react` **零 react-dom 依赖** —— 整个 web-react 里真正 DOM 专有的只有 **7 处 `<div>` 锚点与 `display:contents/none` 内联样式**；ink 是标准 react-reconciler，契约要求的每一项（class error boundary、context、`useSyncExternalStore`、render-phase setState、key 重挂载、`React.memo`）都原样支持。真正的成本不在契约层，而在 (1) React 版本线（ink ≥6 要 React 19，仓库钉 React 18 → 只能用 ink 5.2.x）、(2) `display:contents` 在 Yoga 下无等价物 → outlet 锚点契约必须重新设计、(3) `ui-primitives` + **30 个** 依赖它的 feature 包必须整体重写（这是「终端不是浏览器」的成本，不是 ink 的成本）。

---

## 1. `SlotRenderer` / `SlotRendererHost` 契约逐项

来源：`F:/zsp/Ai/deepseek-harness/packages/client/ui-slots/src/renderer.ts`（208 行，全文已读）

包本身**零运行时依赖**：`packages/client/ui-slots/package.json` 没有 `dependencies` 段，`@types/react` 只在 `devDependencies`/`peerDependencies`。`renderer.ts:2` 是 `import type { ReactNode } from 'react'` —— 纯类型。

### 1.1 安装契约 `SlotRenderer`（`renderer.ts:189-197`）

```ts
export interface SlotRenderer {
  renderRoot(host: SlotRendererHost, ownerProps: object): ReactNode
}
```

**只有一个成员**。整个渲染器的注入面就是这一个函数。返回类型 `ReactNode` 是 React core 类型（`react` 包，不是 `react-dom`），ink 的 `render(node: ReactNode)` 接受同一类型。

安装/调用侧在 runtime：`packages/client/runtime/src/client/slots.ts:213-221`（`install()`，boot-once，走调用方 `ctx.effect`，二次安装抛错）与 `:248-262`（`renderSlot(key, owner)`，三道 fail-loud 守卫：非 `'root'` 键、未安装渲染器、`'root'` 无注册；返回 `ReturnType<SlotRenderer['renderRoot']>`）。

### 1.2 宿主 API `SlotRendererHost`（`renderer.ts:101-186`）

| 成员 | 签名 | 语义 | React/DOM 相关性 |
|---|---|---|---|
| `subscribe(key, fn)` | `(string, () => void) => () => void` | 订阅某 key 的注册变更，**微任务合批** | uSES 的 subscribe 侧，reconciler 无关 |
| `getVersion(key)` | `(string) => number` | 单调版本号，配 uSES 的 getSnapshot | 同上 |
| `entriesOf(key)` | `(string) => readonly StoredEntry[]` | 全部注册（登记序），mutation 之间引用稳定 | 纯数据 |
| `entriesOfSlot(key)` | `(string) => readonly StoredEntry[]` | 每个 cell 的**遮蔽赢家**（第一个未 abdicate 的），chain 键原样透传。**每次调用新数组** —— 明确说明「不是 uSES getSnapshot 源」，只能在 render body 里读 | 纯数据；但隐含要求：渲染器不得把它当订阅源 |
| `reportEntryError(key, entry, error, {abdicate})` | 上报 entry 边界崩溃；`abdicate=true` 时该 entry 一次性从 cell 退休 | 要求渲染器**有 error boundary 机制** | React core（见 §5） |
| `specOf(key)` | `(string) => SlotSpec \| undefined` | 声明账本里的运行时 spec；**undefined 时 outlet 渲染空**（不是错误） | 纯数据 |
| `isLive(entry)` | `(StoredEntry) => boolean` | 陈旧授权检查：注册被 dispose 后返回 false | 纯数据 |
| `storeOf(entry, scopeKey)` | 解析/缓存 entry 声明 handle 在某 scope 下的 store 实例；无声明返回 undefined | 纯数据 |
| `sessions.list` | `HostObservable<unknown>` | `useSessions` 标准 hook 的裸源 | 裸 observable |
| `sessions.provideInfo` | `HostObservable<SessionMaybeProvideInfo>` | **原子的**当前会话 provide 投影（选择变更与 roster 变更走同一个源，避免 mounted entry 停在过期 schema） | 裸 observable |
| `workspaces.list` | `HostObservable<unknown>` | `useWorkspaces` 的裸源 | 裸 observable |
| `locale?` | `LocaleFace \| undefined` | `t` 标准席位的来源；entry 声明了 `locale:` 却无 face = 装配失败 | 见下 |

runtime 侧实现：`packages/client/runtime/src/client/slots.ts:386-420`（`hostFace()`，构建一次；`locale` 用 **live getter**，因为 locale plugin 有独立 fiber 生命周期）。

### 1.3 支撑类型

- **`HostObservable<T>`**（`renderer.ts:31-34`）：`{ getSnapshot(): T; subscribe(fn: () => void): () => void }`。**整个契约里唯一的响应式货币**，没有任何 React hook 穿过边界。
- **`LocaleFace`**（`renderer.ts:18-28`）：`HostObservable<{revision:number}>` + `bind(ns): Translate`。文档明确要求：渲染器**从 `(namespace, revision)` 重新派生每个 entry 的 `t`**，所以切语言时发出**新的函数引用**，`React.memo` 靠浅比较自然重渲染 —— 「freshness 骑在 identity 上」。
- **`StoreInstanceLike`**（`renderer.ts:43-52`）：`getSnapshot` + `subscribe` + `actions: Record<string, (...p: never[]) => void>`。注释原文：*"No React hook crosses this boundary — the render machinery binds `useStore` from the source at its own side (cached per instance)"*。
- **`SessionMaybeProvideInfo`**（`renderer.ts:62-82`）：`{ sessionId: string|undefined; hooks: Record<string, HostObservable|undefined>; props: Record<string, unknown>; projections?: { faceOf(key): HostObservable<unknown> } }`。`hooks` 是**静态 roster**（键恒定，值随会话消失）；`projections` 键空间**开放**（值来自 host push 帧），所以渲染器要**按解析到的 key 逐个绑**。
- **`SessionProvideInfo`**（`renderer.ts:85-89`）：严格版，`sessionId: string`，`hooks` 值必定存在。
- **`RenderOpts`**（`renderer.ts:92-98`）：`{ entryKey?, only?, fallback?: ReactNode, hookContext?: unknown }`。
- **`SnapshotSelectorHook<T>`**（`packages/client/ui-slots/src/store.ts:8`）：`<S>(sel: (s:T)=>S, eq?: (a:S,b:S)=>boolean) => S`。**props 契约里唯一的 hook 类型**，住在 ui-slots；框架是唯一能构造它的一方。

### 1.4 两个错误类

- `StaleAuthorizationError`（`renderer.ts:200`）—— 被 dispose 的注册留下的 `renderSlot` 闭包被调用时抛。
- `SlotOwnershipError`（`renderer.ts:207`）—— 渲染了不在自己 `children` 声明里的 key（plain-JS backstop）。

> ⚠️ **不对称**：第三个错误类 `SlotAssemblyError`（缺 provider = 壳装配错了）住在 **web-react**（`packages/client/web-react/src/session-provider.tsx:15`），不在 ui-slots。`SessionProviderComponent` 也一样：类型在 ui-slots（`src/index.ts:325`），值在 web-react（`session-provider.tsx:150`）。加第二个渲染器时这两个应当上移到 ui-slots，否则 tui 渲染器要么依赖 web-react（一个只有 7 行 DOM 的包），要么定义一个不兼容的孪生类。

---

## 2. `web-react` 如何满足契约 / React 通用 vs react-dom 专有

`packages/client/web-react/package.json` 的 `dependencies` 只有三项：`@deepseek-ai/dsh-client-ui-slots`、`react ^18.2.0`、`use-sync-external-store 1.2.0`。**没有 `react-dom`** —— `grep -rn "react-dom" src/ tests/ package.json` 零命中。

### 2.1 React 通用部分（reconciler 无关，ink 下原样可跑）

| 机制 | 位置 | 说明 |
|---|---|---|
| uSES 桥 `bindSnapshotSelector` | `src/bind.ts:18-24` | `useSyncExternalStoreWithSelector(subscribe, getSnapshot, undefined, sel, eq)`。subscribe/getSnapshot 在绑定时捕获成稳定闭包 |
| 每源缓存 `observableHook` | `src/session-provider.tsx:58-66` + `:66` WeakMap | uSES 在 subscribe 引用变化时会重订阅，所以 hook 必须按源身份缓存 |
| 缺席源 `maybeObservableHook` | `:74-84` | 无源时仍跑一次 uSES 订阅（hook 顺序稳定），返回 undefined |
| `projectionHook` | `:96-117` | 按 key 解析 face，缺席 key 走共享 absent 源 |
| 两个 React context | `:18` `HostContext`、`:31` `BindingContext` | `createContext`/`useContext`，React core |
| `SessionMaybeProvider` / `SessionProvider` | `:125-133` / `:150-160` | context provider + `key={sessionId}` 重挂载 |
| `useInvoke` | `src/use-invoke.ts:55-62` | `useRef` + 每 hook 私有外部 store 走 uSES（render body 无副作用） |
| per-entry `renderSlot` 绑定 + WeakMap 缓存 | `src/scoped-slots.tsx:37-59`、`:67-88` | 身份稳定（memo 前提）、随 entry 死亡 |
| inject 结果三层缓存 | `:96-98`（root / session / session-maybe WeakMap） | 纯 JS |
| locale 席位缓存（按 face×ns×revision） | `:225-241`、`:252-267`、`:277-283` | 一次 uSES 订阅 revision |
| entry 身份 React key | `:295-305` `entryKeyOf` WeakMap 计数器 | 保证赢家切换时 boundary 重挂载 |
| class error boundary | `:317-333` `SlotErrorBoundary` | `getDerivedStateFromError` + `componentDidCatch`；`SlotAssemblyError` 重抛 |
| 标准 kit 合成 | `:344-381` `standardProps`、`:395-441` `standardKit` | 纯对象拼装 |
| 四种 kind 派发 | `:683-851` `renderOutletContent` | single/keyed/chain/list + fallback + crash face |
| chain 选举 | `:774-821` | 纯函数 select，抛错降级为 decline |
| session-maybe **adoption** | `:547-591` | **render-phase setState**（React 官方 derived-state 模式，收敛、StrictMode 安全）+ `key={epoch}` |
| 根出口 | `:854-889` `RootOutlet` | `:867` 无注册即抛装配错误 |
| `createSlotRenderer` | `:897-909` | `HostContext.Provider > SessionMaybeProvider > RootOutlet` |

**`use-sync-external-store` 的可移植性已实测确认**：`node_modules/.pnpm/use-sync-external-store@1.2.0_react@18.3.1/.../cjs/use-sync-external-store-shim/with-selector.development.js:26-27` 只 `require('react')` 和 `require('use-sync-external-store/shim')`，**不 require `react-dom`**；shim 本体 `:226` 是 `React.useSyncExternalStore !== undefined ? React.useSyncExternalStore : shim` —— React 18 下直接走内建实现，与 `canUseDOM`（`:221`）的分支无关。`peerDependencies` 只写 `react`。

### 2.2 react-dom 专有部分（**只有 7 处**）

`grep -nE "<div|<span|style=|className|data-" src/*.tsx` 的全部命中：

| 行 | 内容 | 作用 |
|---|---|---|
| `scoped-slots.tsx:330` | `<div data-slot-error={slotKey} />` | boundary 崩溃面 |
| `scoped-slots.tsx:652` | `const ANCHOR_STYLE = { display: 'contents' }` | 布局中性锚点样式 |
| `scoped-slots.tsx:676` | `<div data-slot={slotKey} style={ANCHOR_STYLE}>` | **outlet 锚点契约** |
| `scoped-slots.tsx:759` | `deadCell = () => <div data-slot-error={slotKey} />` | 干涸 cell 崩溃面 |
| `scoped-slots.tsx:810-812` | `<div data-chain-overlay-fallback style={{display: elected===null ? 'contents' : 'none'}}>` | **overlay chain**：fallback 常驻挂载，靠 display 切换显隐，保住其内部 state |
| `scoped-slots.tsx:848` | `<div data-slot-error key={...} />` | list 干涸行 |
| `scoped-slots.tsx:866`, `:872` | `<div data-slot-error="root" />`、`<div data-slot="root" style={ANCHOR_STYLE}>` | 根锚点 |

即：**约 910 行的渲染器里，react-dom 专有的是 7 个 JSX 站点**，其余全部是 React core。

### 2.3 web-react 的消费者边界（决定「换渲染器」的爆炸半径）

`grep -rn "dsh-client-web-react" packages/**/src`（排除 lib/tests）全部命中只有 **8 处**，其中 feature 包只有两处，且都是 `bindSnapshotSelector`（reconciler 无关）：

- `packages/client/ui-settings-general/src/client/index.ts:13`
- `packages/client/ui-settings-models/src/client/index.ts:11`

其余是壳自身：`packages/client/web/src/app-shell.ts:7`、`app.tsx:10`、`platform.ts:11`、`seed.ts:15,36`，以及测试运行时 `packages/test-support/client-runtime/src/index.ts:28`。

**结论：web-react 名副其实是「shell-only glue」，替换它不会波及 feature 包的导入图。**

---

## 3. ink 能否满足同一套契约 —— 逐项判定与缺口

### 3.1 ink 的硬事实（从 npm registry + jsdelivr 实测，非记忆）

| 版本 | react peer | node engines | react-reconciler | 布局 |
|---|---|---|---|---|
| ink **5.2.1**（2025-04-29，**React-18 线的最后一版**） | `>=18.0.0` | `>=18` | `^0.29.0` | `yoga-layout ~3.2.1` |
| ink 6.0.0（2025-05-29） | `>=19.0.0` | `>=20` | `^0.32.0` | 同上 |
| ink 7.1.1（latest，2026-07-16） | `>=19.2.0` | `>=22` | `^0.33.0` | 同上 |

- `type: "module"`，单一 `exports`（ESM only）。
- `peerDependenciesMeta`：`@types/react` 与 `react-devtools-core` 均 `optional: true`。
- 宿主组件（`build/index.d.ts` 全文 27 行）：`Box` `Text` `Static` `Transform` `Newline` `Spacer`；hooks：`useInput` `useApp` `useStdin` `useStdout` `useStderr` `useFocus` `useFocusManager`；工具：`render` `measureElement`。
- 内部元素名只有四个（`build/dom.d.ts`）：`ElementNames = 'ink-root' | 'ink-box' | 'ink-text' | 'ink-virtual-text'`。
- `render-node-to-output.js` 只 switch 这三种（`:43` `ink-text`、`:58` `ink-box`、`:83` `ink-root|ink-box`）—— **`<div>` 不会立刻抛错，但永远不会被输出**。
- `createTextInstance` 在非 `<Text>` 上下文抛 `Text string "..." must be rendered inside <Text> component`（`build/reconciler.js:126-128`）；`<Box>` 嵌在 `<Text>` 里抛（`:95-97`）。
- README `:24`：*"Since Ink is a React renderer, it means that **all features of React are supported**"*；`:210`：*"It's important to remember that **each element is a Flexbox container**"*；`:242`：`<Text>` 只允许文本节点和嵌套 `<Text>`；`:2150` 官方 Suspense 示例。
- `Ink` 容器是 **LegacyRoot**（`build/ink.js:59-61`：`reconciler.createContainer(this.rootNode, /* Legacy mode */ 0, ...)`）。

### 3.2 逐项判定

| 契约要求 | ink 支持？ | 证据/说明 |
|---|---|---|
| `renderRoot(): ReactNode` | ✅ | `render(node: ReactNode)`；`ReactNode` 是 react core 类型 |
| `useSyncExternalStore` | ✅ | 在 `react-reconciler` 的 hooks dispatcher 里实现，宿主无关；`use-sync-external-store` shim 只 require `react`（§2.1 实测） |
| React context | ✅ | core |
| class error boundary（`getDerivedStateFromError`/`componentDidCatch`） | ✅ | fiber throw 路径是 reconciler core，与 host config 无关；ink 把 `onRecoverableError` 传成 `() => {}` |
| `React.memo` + 浅比较 | ✅ | core（locale `t` 的 identity-freshness 策略照常生效） |
| `key` 驱动重挂载（`entryKeyOf`、`key={sessionId}`、`key={epoch}`） | ✅ | core |
| render-phase `setState`（`SessionMaybeEntry:562-578`） | ✅ | core，legacy root 同样支持 |
| Suspense | ✅ | 官方示例；当前 dsh 未用（boot 是 one-flip） |
| `createPortal` | ❌ | ink 未导出。**但 web-react 不用 portal**；用 portal 的是 `ui-primitives`/`ui-attachment`（已定重写） |
| `<div>` 锚点 | ❌ | 只有 `ink-box`/`ink-text` 会被输出 |
| `display: 'contents'` | ❌ **核心缺口** | ink `Styles.display` = `'flex' \| 'none'`（`build/styles.d.ts:137`）。README `:210` 明说每个元素都是 flex 容器 —— **Yoga 里不存在「布局中性的包装节点」** |
| `display: 'none'`（overlay chain 隐藏态） | ✅ | ink 有 `'none'`；缺的是「显示态用 contents」那一半 |
| `data-*` 属性（可寻址接缝） | ⚠️ | ink 的 `setAttribute` 会存下任意属性，但没有查询/寻址机制（无 `querySelector`）。这条契约在 TUI 下等于**没有等价物**，测试与「动态样式定位」两个用途都要另想办法 |
| `console.error`（`scoped-slots.tsx:326,792`） | ⚠️ | ink 默认 `patchConsole: true`，会把 console 输出渲染在帧上方而不污染帧 —— 可用，但需要显式确认不要关掉 |

### 3.3 具体缺口清单（渲染器层，7 处 + 3 个设计决定）

**必须做的机械替换（7 处）**：把 `<div data-slot-error>` / `<div data-slot>` 换成 `<Box>`（崩溃面还要包一层 `<Text>`，因为字符串不能裸放）。

**必须做的设计决定（3 个）**：

1. **锚点契约怎么办**（`scoped-slots.tsx:652,676,872`）。现状注释写得很清楚：锚点「骑在 outlet 上，不骑在派发结果上」，所以 fallback / crash-face / 未声明空态都渲染在它里面，锚点的存在**永不随注册抖动闪烁**。ink 里无法既保留这个包装节点又不影响布局。三条路：
   - (a) **去掉包装节点**，`renderOutletContent` 直接返回 —— 丢掉 anchor 契约（也就丢掉 `data-slot` 可寻址接缝）；
   - (b) 保留 `<Box>` 包装并让它 `flexGrow: 0, flexShrink: 1` 透传 —— 但父级 flex 方向/gap 会被多算一层，等于把「所有者布局」和「slot 结构」耦合起来，与 web 侧语义不等价；
   - (c) 引入一个 ink 侧的 **fragment-like 宿主节点**（改 ink 或自建 reconciler）—— 成本最高。
   推荐 (a)，并把「可寻址」需求改由**渲染器自持的一张 `key → 节点` 表**满足（渲染器本来就在 outlet 里，加一个注册表是纯 JS）。

2. **overlay chain 的 fallback 常驻**（`:802-818`）。web 侧靠 `display:'contents' ↔ 'none'` 保住 fallback 的组件 state 不被卸载。ink 侧可以用 `display:'none' ↔ 'flex'`，语义上**可行**，但显示态从「零布局影响」变成「多一个 flex 容器」，需要在设计上确认可接受。

3. **`RenderOpts.fallback?: ReactNode` 的字符串问题**。ui-slots 的类型允许 `fallback` 是裸 string，web 侧调用方会自然这么写。ink 下裸字符串不在 `<Text>` 里会**抛错**（`reconciler.js:126-128`）。这是**props 契约层**的差异，不是渲染器内部能兜住的 —— 要么在渲染器里对 string fallback 自动包 `<Text>`（可行，`:763,770,820,841` 五处），要么在 SlotMap 文档层收紧约定。

### 3.4 版本线缺口（非渲染器层，但是硬约束）

仓库钉 `react ^18.2.0`（`packages/client/web/package.json`、`web-react`、`runtime`、`apps/web` 全线），实际解析到 18.3.1。

- **ink 5.2.x 是唯一可选线**。ink ≥6 要 React 19 —— 而 `packages/client/web/src/platform.ts` 的 `PLATFORM_MODULES` 把 **一个** React 实例塞进冻结模块表（`seed.ts:29-41`），所有 fetch 来的插件 bundle 共享它，所以升 React 是**全仓一次性动作**（web 的 react-dom 也要同步升 19）。
- ink 5.2.1 的 `Box` 仍在 forwardRef 上用 `defaultProps`（`build/components/Box.js:13-18`）—— React 18 只是 dev 警告；React 19 会失效，这正是 ink 6 存在的原因。
- ink 5 是 **LegacyRoot**（`build/ink.js:59-61`）：没有 concurrent 特性、没有 `startTransition`。dsh 目前不用这些，但 uSES 通知在 legacy root 下走 SyncLane + 微任务 flush，多个 outlet 的通知**仍会在同一微任务里合批**（React 18 的 `scheduleMicrotask(flushSyncCallbacks)`），不会退化成每次通知一次同步渲染。**性能上是 note 不是 blocker**。
- ink 是 **ESM-only**，而 dsh 的插件 bundle 走 lazy-CJS 同步 `require` 表。这**不是问题**：壳静态 `import * as Ink from 'ink'` 后塞进 seed 表（与 `seed.ts:11-12` 塞 react-dom 完全同构），插件 bundle 的 `require('ink')` 拿到的是已经 import 好的命名空间。

---

## 4. `packages/client/runtime` 的 react / zustand / immer 引用 —— 逐个判断

### 4.1 关键实测结论：**runtime 源码里一个 `import ... from 'react'` 都没有**

```
grep -rniE "^import.*react|from '(react|@deepseek-ai/dsh-client-web-react)'" src/   → 0 命中
grep -rnE "ReactNode|ReactElement|\bFC\b|JSX\.|createElement|useMemo|useContext|createContext" src/
  → 只有 2 条，且都是注释：
     src/client/sessions/notifier.ts:4   "...useSyncExternalStore requires a stable..."
     src/client/sessions/session.ts:440  "---- Subscription API (useSyncExternalStore direct wiring) ----"
```

题面列出的 10 个文件（`grep -ril react` 命中）**全部是注释/文档字符串**，加上 `contract/settings-scope.ts` 的一次假阳性（`:52` 的 "**React**ive owner handle"）：

| 文件 | 命中性质 | ink 下能跑？ |
|---|---|---|
| `src/client/contract/settings-scope.ts:52` | 假阳性（"Reactive"） | ✅ |
| `src/client/contract/store.ts:6,7,9,29` | 注释（"Lives in the React-free runtime"…） | ✅ |
| `src/client/index.ts:69` | 注释（"web-react only binds it to React"） | ✅ |
| `src/client/sessions/conversation.ts:3,280` | 注释（memo 前提、seq 作为 React key） | ✅ |
| `src/client/sessions/manager.ts:3` | 注释（"List data never enters zustand"） | ✅ |
| `src/client/sessions/notifier.ts:4,54` | 注释（uSES 稳定快照、受控输入回滚） | ✅ |
| `src/client/sessions/pending.ts:37` | 注释（渲染身份可用作 React key） | ✅ |
| `src/client/sessions/projection-store.ts:9,16,45,73` | 注释 | ✅ |
| `src/client/sessions/service.ts:646` | 注释（"React binds selector hooks at its own boundary"） | ✅ |
| `src/client/sessions/session.ts:61,440` | 注释 | ✅ |
| （另外两个 grep 命中）`src/client/slots.ts:208`、`workspaces/workspace.ts:1` | 注释 | ✅ |

**构建产物佐证**：`packages/client/runtime/lib/client.js` 里 `require(...)` 只有两个 —— `@deepseek-ai/cordis` 和 `@deepseek-ai/dsh-client-ui-slots`。零 react、零 zustand、零 immer（后两者被内联进 bundle）。

⇒ `packages/client/runtime/package.json:` 里的 `"react": "^18.2.0"` **是 dependencies 里的死引用**（`@types/react` 在 devDependencies 里管类型解析就够了）。可以顺手清掉。

### 4.2 zustand / immer —— **根本没用 React 绑定**

`src/client/contract/store.ts:12-15`：

```ts
import { createStore, type StoreApi } from 'zustand/vanilla'
import { subscribeWithSelector } from 'zustand/middleware'
import { shallow } from 'zustand/shallow'
import { produce } from 'immer'
```

三个 zustand 子路径**全是 vanilla 侧**，`zustand` 主入口（`useStore`/`create` 的 React 绑定）一次都没导入。所以「zustand 的 React 绑定在非 DOM reconciler 下可用吗」这个问题**不成立** —— dsh 压根不用它，hook 合成 100% 是 web-react 的 `bindSnapshotSelector`（`bind.ts:18-24`）。immer 的 `produce` 是纯函数。

> 顺带：如果**未来**要用 zustand 的 React 绑定，答案也是「可用」——`zustand/react` 内部就是 `useSyncExternalStoreWithSelector`，同样只依赖 `react`。但没必要引入。

### 4.3 浏览器全局审计（runtime 全量 grep）

只有三处，**全部已经带 Node 回退**：

| 位置 | 全局 | 回退 |
|---|---|---|
| `contract/store.ts:58-61` | `requestAnimationFrame` | `typeof requestAnimationFrame === 'function'` 否则 `queueMicrotask`（注释明说 "node unit tests"） |
| `contract/store.ts:131`、`:229` | `localStorage` | `typeof localStorage === 'undefined'` → 静默禁用持久化（注释明说 "node e2e booting the client tree"） |
| `sessions/notifier.ts:49,82` | `globalThis.requestAnimationFrame` | 同样 `typeof` 检测 + microtask 通道 |
| `time-zone.ts:9` | `Intl.DateTimeFormat` | Node 有 |

**零 `window.` / 零 `document.` / 零 `navigator.` / 零 `WebSocket` / 零 `EventSource`。**

⇒ **`packages/client/runtime` 在 ink 下 0 行改动可跑。** 唯一的观察：rAF 回退到 microtask 后，token 流的合帧粒度从「每帧一次」变成「每微任务一次」，TUI 侧应该显式接一个自己的节流（终端重绘比 60fps 更贵）。

---

## 5. 陈旧授权 / 所有权 / 声明 epoch / `ctx.slots.inject` 对渲染器的隐含要求

### 5.1 `StaleAuthorizationError` + `SlotOwnershipError` → 三条渲染器硬约束

`scoped-slots.tsx:39-59`（`boundRenderSlot`）与 `:69-88`（`boundRenderSlotChain`）是唯一实现，其形状本身就是契约：

1. **绑定必须按 entry 身份缓存**（`:37`、`:67` 两张 `WeakMap<StoredEntry, …>`）。注释原文：*"identity-stable per entry (memoized components must not resubscribe on unrelated re-renders)"*。→ **任何渲染器都必须做这个缓存**，否则 `React.memo` 全线失效。纯 JS，ink 无碍。
2. **每次调用先查 `host.isLive(entry)`**（`:43`、`:73`），false 就抛 `StaleAuthorizationError`。→ 渲染器不能把「授权」缓存成布尔值，必须每次问宿主。
3. **每次调用查 `entry.children?.[key]`**（`:47-53`、`:76-82`），未声明抛 `SlotOwnershipError`，kind 不匹配（chain vs 非 chain）也抛。→ 渲染器必须自己重放这套 plain-JS backstop（类型层已窄化，但动态调用者要兜住）。

这三条**全是纯 JavaScript**，与 reconciler 无关，ink 版渲染器可以逐字照抄。

### 5.2 崩溃上报 → 强制要求 error boundary + entry 身份 key

`host.reportEntryError(key, entry, error, { abdicate })` 的语义（`renderer.ts:136-141`）要求渲染器：

- 有一个能捕获**渲染期**异常的机制 → React class error boundary（`scoped-slots.tsx:317-333`）。ink ✅。
- 遮蔽类（single/keyed/list）传 `abdicate: true`，chain 传 `false`（`:714-716`）。
- **boundary 必须包在 Entry 元素外面，不能住在里面**（`:704-706` 注释）—— 因为 inject 工厂和 kit 合成在 Entry body 里跑，必须落进 per-entry fallback。
- **boundary 必须按 entry 身份加 key**（`:295-305` `entryKeyOf` + `:764,772,798,847,875`）。注释原文：没有 key 的话，「在 entry A 上失败过的 boundary 会在赢家切换（重新选举 / abdication 后的遮蔽回退 / HMR 重注册）后存活下来，把健康的 entry B 一直黑屏」。
- `SlotAssemblyError` 必须**重抛**（`:322`）—— 装配错误 fail-loud，注册方错误才被容纳。

### 5.3 声明 epoch → 对渲染器**没有**直接要求，但有一条间接约束

`declarationEpoch` 只在 SlotCore（`packages/client/ui-slots/src/index.ts:621,703,878,1025-1028,1143,1158`）和 `SlotRegistry.inject`（`packages/client/runtime/src/client/slots.ts:163-179`）之间流转，**从不出现在 `SlotRendererHost` 上**。渲染器只能看到 `specOf(key)`。

间接约束是：**key 的 spec 可以在挂载期间消失又重新出现**，渲染器必须容忍而不是抛错 —— `renderOutletContent:690-694`：

```ts
const spec = host.specOf(slotKey)
if (!spec) return null   // 「未声明键渲染空：声明方卸载把 slot 退回未声明态，
                         //   而被保留的元素可能仍然挂着 —— 自然空态，不是所有权失败」
```

⇒ ink 版必须保留这个 `return null`（ink 里 `null` 是合法子节点）。

### 5.4 `ctx.slots.inject` → 一条 **TUI 专属的真实风险**

`packages/client/runtime/src/client/slots.ts:143-205`。机制本身在渲染器之外（走 `ctx.effect` + `subscribeDeclaration`），但 `:181-193` 的失败路径是：

```ts
const failure = error instanceof Error ? error : new Error(String(error))
queueMicrotask(() => { throw failure })   // slots.ts:191
```

在浏览器里这是一个 `error` 事件（页面继续跑）；**在 Node 里 `queueMicrotask` 抛出 = `uncaughtException` = 进程退出**（除非装了 handler）。TUI 壳必须装 `process.on('uncaughtException')` 或把这个上报通道改成显式的诊断 sink，否则一个 inject 回调的 setup 失败会直接杀掉整个终端应用。同类风险还在 `packages/client/connection` 的重连循环里（`connection.ts:195-201` 的 sink 异常只 log，安全）。

另外 `slots.ts:176` 把声明生命期做成**嵌套 cordis effect** —— 与渲染器无关，ink 下原样。

---

## 6. In-process carrier —— 怎么用，TUI 要装配什么

### 6.1 先纠正一个前提

`packages/client/connection/src/index.ts` **不是**客户端插件，是**宿主（Node）半边**（`:1` 的头注释 `/** Host HTTP bridge for browser-client RPC. */`，`apply` 在 `:130`）。浏览器半边是 `src/client/index.ts`（`apply` 在 `:84`）。README 里那句 "toFetchHandler's SSE codec serves only the isomorphic in-process carrier" 指的是：宿主的 `/api` 路由复用了同一个 isomorphic fetch handler（`src/index.ts:158` 的 fallback 腿），**而不是**客户端 apply 里有个 in-process 分支。

**客户端 apply 里没有 in-process 分支。** `src/client/index.ts:85-89` 的分支是 fixture vs HTTP：

```ts
const fixture = pageLocation !== undefined && new URLSearchParams(pageLocation.search).has('fixture')
const fixtureClient = fixture ? new FixtureApiClient() : undefined
const api: IApiClient = fixtureClient ?? new WebApiClient()   // :88 —— 硬编码
```

`fixture.ts:3037` 的 TODO 明说这条路还没铺通：*"TODO: delete when the fixture moves to the isomorphic pipeline (InProcessApiClient over toFetchHandler(fixtureImpl))"*。

### 6.2 carrier 抽象的实际要求

`packages/host/apiproxy/src/fetch/client.ts:244` `AbstractApiClient`：

- **唯一 abstract 成员**：`protected abstract doFetch(input: URL, init?: RequestInit): Promise<Response>`（`:254`）。
- 可选覆盖：`onEnvelope`（`:271`）、`resolveBase`（`:293-296`）、`mintRpcId`（`:300`）、`callUnary`（`:333`）、`openMux`（`:353`）、`openHost`（`:358`）、`readSse`（`:369`）、`respond`（`:508`）。
- 协议不变量全在基类：rpcId 铸造（`crypto.randomUUID`，Node ≥19 有）、信封包装、两级 zod 解析、rpcId 回声校验、`AbortSignal.any` 超时合并、`DEFAULT_TIMEOUT_MS = 30_000`（`:228`）。
- `resolveBase()`（`:293-296`）：有 `location.origin` 用它，否则 `INTERNAL_BASE = 'http://dsh.internal'`（`:234`）。

**「两条流」** = `IApiClient['events']` 的 `mux(payload, signal, onOpen?)` 与 `host(payload, signal, onOpen?)`，都返回 `AsyncIterable<RpcRequest<Frame>>`。`signal` **必填**，`onOpen` 在物理传输可读时触发一次 —— 就绪握手（`connection.ts:139-142`）就钉在这上面。

`InProcessApiClient`（`fetch/client.ts:520-541`）：`new InProcessApiClient(handler: { fetch: typeof fetch }, timeoutMs?)`，`doFetch` 把注入的 handler 与 signal 赛跑（`:529-540`），保证即使 handler 忽略 `init.signal` 也会在 abort 时 reject。

`toFetchHandler(api: ApiProxy): { fetch: typeof fetch }`（`fetch/handler.ts:243`）—— 一个**无状态纯对象**，没有 server。它 `import { randomUUID } from 'node:crypto'`（`:9`），所以是 host-only —— **对 TUI 恰好无害，TUI 本来就是 Node**。

### 6.3 连接循环

`ConnectionController`（`src/client/connection.ts:61-202`）：

- 构造 `(api: IApiClient, sinks: ConnectionSinks = {}, config: ConnectionConfig = {})` —— **严格说只需要一个 `IApiClient`**。
- `ConnectionSinks`（`:44-52`）四个成员全可选：`onMuxEnvelope?` `onHostEnvelope?` `onConnected?(desc)` `onStateChange?(state)`；`ConnectionState = 'connected' | 'reconnecting'`（`:40`）。
- `ConnectionConfig`（`:5-17`）：`backoffBaseMs/backoffFactor/backoffMaxMs/streamOpenTimeoutMs`，默认 `500 / 2 / 10_000 / 3_000`（`:19-24`）。
- 每代循环（`:107-169`）：同时开 mux + host 两条流，就绪握手 = `Promise.all([api.host.describe({}), race(两条流 onOpen, sleep(streamOpenTimeoutMs))])`，失败进抖动退避。
- 实际消费者：`packages/client/runtime/src/client/index.ts:204-231` 传全四个 sink，`:232` 用 `ctx.effect` 挂 `loop.stop()`。

⚠️ **`ConnectionController` 不从包根导出**：`src/client/index.ts:39-41` 只 re-export 了 `ConnectionConfig`/`ConnectionSinks`/`ConnectionState` 三个**类型**，注释写 "the controller remains package-internal"。要用得走 `"./src/*"` 源码子路径，或者经 `apply` + `ctx.connection.start(...)` —— 而 `apply` 硬编码 `WebApiClient`，**没有替换 carrier 的接缝**。

### 6.4 浏览器全局审计（`packages/client/connection/src/**`）

| 文件 | 判定 | 证据 |
|---|---|---|
| `client/web-api-client.ts` | 浏览器风格，**但 Node 22+ 可能原样跑** | `:15` `globalThis.fetch`、`:42` `new WebSocket(url)`、`:51` `MessageEvent`、`:67` `WebSocket.CONNECTING/OPEN` —— 这些在 Node 22+ 全是全局（仓库 `engines: ^22.19.0 \|\| >=24`，本机 v24.19.0）。缺的只有 `resolveBase()` 要覆盖成 `http://127.0.0.1:<port>` |
| `client/rpc.ts` | 只要 `fetch` 全局 | `:30` `globalThis.fetch`、`:52-53` 可选 `location` + `INTERNAL_BASE` 回退 |
| `client/connection.ts` | **完全同构** | 零全局，只用 `setTimeout`/`AbortController`/`Math.random` |
| `client/api.ts`、`api-path.ts`、`rpc.ts`、`loopback-hostname.ts` | 完全同构 | 纯类型/常量/字符串判定 |
| `client/random-uuid.ts` | 同构 | `:8` `globalThis.crypto.getRandomValues`（Node ≥19） |
| `client/index.ts`、`client/fixture.ts` | 同构容忍 | `:85`/`:106`、`fixture.ts:3179` 都是 `typeof location === 'undefined'` 守卫 |
| `index.ts`、`rpc-host.ts`、`http-bridge.ts`、`websocket-downlink.ts`、`api-request-trust.ts` | Node-only | `node:http`/`node:stream`/`ws` |

**全包零 `window.`、零 DOM `document.`、零 `localStorage`、零 `EventSource`。**

### 6.5 TUI 的两条装配路线

**路线 A —— HTTP 回环（低风险，推荐先做）**

TUI 进程连一个已经跑着的 `dsh web` 宿主：

```
class NodeApiClient extends AbstractApiClient {     // ~90 行，抄 web-api-client.ts
  protected doFetch(u, i) { return globalThis.fetch(u, i) }
  protected override resolveBase() { return `http://127.0.0.1:${port}` }
  protected override openMux/openHost(...)          // Node 22+ 全局 WebSocket，逻辑同 web
}
new ConnectionController(new NodeApiClient(), sinks).start()
```

复用面：整条 `/api` 信任栅栏、WebSocket downlink、重连循环、object layer —— **一行不改**。

**路线 B —— 真·进程内（无 HTTP server）**

```ts
const apiProxy = createApiProxy(hostCtx, defaults)          // packages/host/apiproxy/src/api-proxy.ts:1106
const api = new InProcessApiClient(toFetchHandler(apiProxy)) // fetch/client.ts:521
new ConnectionController(api, sinks).start()                 // connection.ts:69,78
```

已验证的可跑范本（测试）：`packages/host/apiproxy/tests/client-handler.spec.ts:137-139`、`tests/fetch-carrier.spec.ts:300-302`。全仓**没有任何非测试消费者**用过 `InProcessApiClient`。

路线 B 的**真正难点不是 carrier，是 cordis Context 键冲突**：
- host 侧 `packages/core/session/src/index.ts:39` 声明 `Context.sessions: SessionStore`
- client 侧 `packages/client/runtime/src/client/index.ts:176` 声明 `Context.sessions: ISessions`
- `tsconfig.client.json` 的头注释原文承认这一点：*"both sides merge cordis Context under the same keys (**sessions, loader**) with different services"*

⇒ 单进程 TUI 必须开**两个 cordis root**（host root + client root），中间只用 `{ fetch }` 这个不透明句柄桥接。这在运行时完全可行（`new Context()` 只是个对象），但装配点要拆成两个包（一个编在 host program，一个编在 client program），否则类型程序对撞。

架构笔记里已经明确**拒绝**过在产品路径上用 in-process client：`.agents/notes/implemented/architecture/2026-08-09-headless-direct-core-entry-point.md:35` —— *"Product execution would depend on an unrelated protocol solely to exercise that protocol."* 另见 `packages/boot/app-boot/src/profile.ts:116`：`headless` profile = `['dsh-base', 'dsh-headless']`，**不挂** `dsh-web-app`，所以既没有 apiproxy carrier 也没有 client-connection。TUI 走路线 B 等于翻这个决定，需要在 ticket 里显式讨论。

---

## 7. `packages/client/modules` 加载链 & TUI 要提供什么

### 7.1 链路（节点顺序取自 `packages/client/web/src/boot.tsx` 的 `AppWebEntry.run()`，`:97`）

```
宿主（Node 半边，packages/client/modules/src/index.ts）
  扫 loader entries 里声明 dsh.client 的包 → 组 WebBootGraph
  → GET /plugins/<id>/client.js 路由 + index tap 注入 window.__DSH_BOOT__

浏览器（壳内核，boot.tsx，cordis 还不存在时就跑）
  :98   parseBootManifest(window.__DSH_BOOT__)      → {modules 行, plugins 行}
  :100  new ClientModuleSystem({ modules, staticModules: getStaticModules(), ...seams })
        └ 构造函数装 window.__ModuleLoader__（system.ts:87-88，二次 boot 抛错）
  :105  registerStatic(APP_SHELL_ID, AppShell)      ← 壳自有伪模块
  :111  registerStatic(MODULES_ID, ModulesClient)
  :112  window.__DSH_MODULES__ = this.modules       ← 内核交接槽
  :114  createRoot(el).render(<AppRoot/>)           ← loading 页
  :133  prefetchImmediateTier()（不 await）
  :134  this.ctx = new Context()                    ← cordis 从这里才存在
  :163  await ctx.plugin(Loader)                    ← vendored @cordisjs/plugin-loader
  :168  loader.internal = this.modules              ← 填 Loader 的 internal 契约
  :183  await prefetching                           ← 栅栏
  :189  rows = [MODULES_ID, ...manifest.plugins, APP_SHELL_ID]
  :196  Promise.all(rows.map(name => loader.create({ name })))
  :206  await loader.await(); :207 assertEntriesActive()
  :137  settled.set(true)                           ← 一次成型翻页
```

bundle 侧协议：每个 bundle 执行 `window.__ModuleLoader__.load({ id, factory })`，`factory(require)` 是同步 CJS 闭包，`require` 从**惰性 CJS 模块表**答（seed 词 + 已注册 factory，首次 require 时 materialize 并 memo）。CSS 内联在 bundle 里，materialize 时注入 `<style data-plugin="<id>">`。

### 7.2 TUI 要提供的东西（逐项）

| 现状 | 位置 | TUI 要提供 |
|---|---|---|
| `platform` 过滤写死 `'web'` | `packages/client/modules/src/index.ts:350` `if (decl === undefined \|\| decl.platform !== 'web')` | 把过滤参数化。**好消息**：`platform` 已经是被校验的字符串字段（`:115-116, :125`），全仓当前只有 `"web"` 一个值（39 处），所以加 `'tui'` 是纯加法 |
| `loadBundle` 默认用 `<script src>` | `system.ts:13-27` `defaultLoadBundle` 用 `document.createElement('script')` | **已经是可注入 option**（`manifest.ts:236` `loadBundle?: (url: string) => Promise<void>`）。TUI 传一个 Node 版：`await import(pathToFileURL(...))` 或 读文件 + `vm.runInThisContext` |
| `claimStyles` 扫 `<style>` 标签 | `system.ts:40-52` | 有 `typeof document === 'undefined'` 守卫，直接返回 `[]` ✅ |
| `window.__DSH_BOOT__` 由 HTTP index tap 注入 | `packages/client/modules/src/index.ts:161-170` | TUI 进程直接把 `graph()` 的返回值塞进 `globalThis.__DSH_BOOT__`（或改成构造参数）—— 不需要 webserver |
| seed 表 = `PLATFORM_MODULES` | `packages/client/web/src/platform.ts` | TUI 需要**自己的一张表**：`react`、`react/jsx-runtime`、`ink`、`@deepseek-ai/cordis`、`…ui-slots`、`…tui-react`、`…tui-primitives`。**不含 react-dom** |
| bundle 构建预设绑死 web | `packages/client/tsdown.client.ts:17`（import `PLATFORM_MODULES`）、`:64` `CLIENT_EXTERNALS` | TUI 需要一份并行预设：换 externals 表、**整条 CSS Modules/lightningcss 管线删掉** |
| `__DSH_MODULES__` / `__ModuleLoader__` 挂在 `globalThis` | `manifest.ts:158-170` | Node 里 `globalThis` 一样能挂 ✅ |

⇒ **模块系统本身几乎可以整包复用**，需要改的是三个注入点（platform 过滤、loadBundle、seed 表）+ 一份新的 bundle 预设。

---

## 8. 结论：(b) 可行但需要 X

### X 清单（按依赖顺序 + 工作量档次）

| # | 工作项 | 档次 | 说明 |
|---|---|---|---|
| X0 | **决定 React 版本线** | 决策 | 要么钉 `ink@5.2.x`（React 18，最后一版 2025-04-29，后续 ink 更新不再进）；要么全仓升 React 19 + react-dom 19 + ink 7（`PLATFORM_MODULES` 共享单一 React 实例，升级是一次性全仓动作） |
| X1 | `ui-slots` 契约微调 | **XS**（~30 行） | `SlotAssemblyError` + `SessionProviderComponent` 的**值侧**约定从 web-react 上移；`RenderOpts.fallback` 的裸-string 语义收紧或在渲染器兜底 |
| X2 | 新包 `client/tui-react`（ink `SlotRenderer`） | **S**（~900 行，其中 ~890 行照抄） | 7 处 JSX 替换 + 3 个设计决定（锚点契约、overlay chain 显隐、string fallback 包 `<Text>`） |
| X3 | 新包 `client/tui`（壳内核） | **M**（~400 行） | 对照 `packages/client/web/src/boot.tsx` 重写：自己的 seed 表、Node 版 `loadBundle`、`__DSH_BOOT__` 直塞、`ink.render()` 替 `createRoot()`、**装 `process.on('uncaughtException')`**（§5.4） |
| X4 | carrier | **S**（路线 A，~90 行）/ **M-L**（路线 B） | A：`NodeApiClient extends AbstractApiClient` + `resolveBase` 覆盖；B：双 cordis root + host program/client program 拆包，且要翻 `headless-direct-core-entry-point` 笔记的决定 |
| X5 | `client/connection` 加 carrier 接缝 | **XS** | `src/client/index.ts:88` 现在硬编码 `new WebApiClient()`；顺带把 `ConnectionController` 从 `./client` 导出 |
| X6 | `client/modules` 三个注入点 | **S** | `platform` 过滤参数化（`src/index.ts:350`）、TUI `loadBundle`、graph 直塞 |
| X7 | 新 tsdown TUI bundle 预设 | **S** | 抄 `packages/client/tsdown.client.ts`，换 externals、删 CSS 管线 |
| X8 | 新包 `client/tui-primitives` | **L** | 完全重写 `ui-primitives`（react-dom + shiki + katex + micromark + 5 处 `createPortal` → 终端等价物）。已知在票外，但它是 X9 的前置 |
| X9 | **~28 个 feature UI 插件的组件体重写** | **XL** | 依赖 `ui-primitives` 的包共 **30 个**（`grep -rl dsh-client-ui-primitives --include=package.json`）。每包的 `apply`/`register`/`inject`/store 骨架**能原样活下来**（它们不碰 DOM），死的是 JSX body |
| X10 | 测试基建 | **M** | `packages/test-support/client-runtime` 是 jsdom + `@testing-library/react`；TUI 侧需要 `ink-testing-library` 版孪生 |

**净判断**：X1–X7 加起来大约是 **1.5k–2k 行新代码 + 3 个真正的设计决定**，这一段完全可行且风险可控。X8–X10（primitives + 28 个 feature 包 + 测试基建）才是主体成本 —— 但那部分**与是否选 ink 无关**，选任何终端渲染方案都要付。

### 如果结论是 (c) 会是什么样（备选，仅备查）

不选 ink 的替代：(1) 自建 react-reconciler（拿到 fragment-like 宿主节点、避开 ink 的 legacy root，成本 +M，收益仅解决 §3.3 的锚点问题）；(2) 放弃 React、TUI 自成一套非-slot 架构（丢掉 runtime/object layer 复用，成本最高）；(3) 只做「只读镜像 TUI」（不复用 slot 系统，直接消费 `ConversationSnapshot`，成本最低但不是同一张票）。**当前证据不支持走这三条。**

---

## 9. 对架构的影响

### 9.1 这个结论如何约束包切分

**证实的分层是干净的**，可以直接用作包边界的依据：

```
ui-slots        —— 契约层，0 运行时依赖，reconciler 无关          【共享，改 ~30 行】
client/runtime  —— 数据/服务层，运行时零 React（lib/client.js 只 require cordis+ui-slots）
                                                                【共享，改 0 行，可清 react 死依赖】
client/connection —— 线路层，client/ 下只有 web-api-client.ts+rpc.ts 有平台味
                                                                【共享，加一个 carrier 接缝】
client/modules  —— 加载链，三个注入点已经存在或近在咫尺        【共享，改 ~3 处】
─────────────────────────── 以上是「第二个渲染器」真正能复用的东西 ───────────────────────────
web-react       ←→ tui-react      渲染器（910 行，7 处 DOM 站点）  【平行孪生】
client/web      ←→ client/tui     壳内核 + seed 表                【平行孪生】
ui-primitives   ←→ tui-primitives 原语                            【全重写】
28 个 ui-* 插件 ←→ 28 个 tui-* 插件（或同包双 platform 半边）    【组件体全重写】
```

**关键的包切分选择题**：feature 插件是「一个包两个 platform 半边」（`src/client/` + `src/tui/`，`dsh.client` 里 `platform` 变数组）还是「两个包」？证据倾向前者 —— 因为 `apply`/`register`/`inject`/store 骨架是共享的，只有 JSX body 分叉，拆两个包会把这套骨架复制两份（正是 slot 系统设计里最反对的「第二套 machinery」）。

### 9.2 要重写什么（量化）

| 层 | 重写量 |
|---|---|
| 契约 + 数据 + 线路 + 加载链 | **~0**（加起来几十行接缝） |
| 渲染器 | 7 个 JSX 站点 + 3 个设计决定（其余 890 行照抄） |
| 原语 | 100%（`ui-primitives`：react-dom + shiki + katex + micromark） |
| feature 组件 | ~28 包的 JSX body |

### 9.3 风险

1. **React 版本线是一次性、全仓的**（高）。`PLATFORM_MODULES`（`packages/client/web/src/platform.ts`）把**单一** React 实例塞进冻结模块表，所有 fetch 插件共享。选 ink 5.2.x = 接受一条 2025-04 之后不再更新的依赖线；选 ink ≥6 = 同一个 PR 里把 web 端也升到 React 19（含 react-dom 19、`defaultProps` 移除等破坏性变更）。**这条应该在票里单独立项**。

2. **`display:contents` 无等价物是设计缺口，不是实现缺口**（高）。「outlet 锚点骑在 outlet 上、永不闪烁、且布局中性」这三条在 Yoga 下**不能同时成立**（README `:210`：每个元素都是 flex 容器）。必须显式放弃一条。相关地，`data-slot` 的「可寻址动态样式接缝」在终端里没有对应概念 —— 需要用渲染器自持的注册表替代，否则 web 端的一些约定（以及基于 `data-slot` 的 e2e 定位）在 TUI 侧无处安放。

3. **Node 下的未捕获异常语义变了**（中）。`packages/client/runtime/src/client/slots.ts:191` 的 `queueMicrotask(() => { throw failure })` 在浏览器里是 error 事件，在 Node 里是进程退出。TUI 壳必须兜住。同理，ink 的 `patchConsole` 默认开着才能让渲染器里的 `console.error`（`scoped-slots.tsx:326,792`）不撕碎终端帧。

4. **路线 B（真进程内）撞 cordis Context 键**（中）。`sessions`/`loader` 在 host 与 client 两侧被声明成不同服务（`tsconfig.client.json` 头注释、`packages/core/session/src/index.ts:39` vs `packages/client/runtime/src/client/index.ts:176`），必须双 root。而且 `.agents/notes/.../2026-08-09-headless-direct-core-entry-point.md:35` 显式拒绝过在产品路径上用 in-process client。**建议先走路线 A（HTTP 回环 + `NodeApiClient`，~90 行），把 in-process 留给后续独立决策。**

5. **渲染性能模型不同**（中低）。ink 每帧跑整棵 Yoga 布局并 diff 输出行；runtime 的 rAF 合帧在 Node 下退化成 microtask（`contract/store.ts:58-61`、`notifier.ts:49`），token 流会比浏览器更频繁地触发重绘。TUI 壳应当自带一层显式节流。

6. **测试基建要开第二条道**（中低）。`packages/test-support/client-runtime` 深度绑 jsdom + `@testing-library/react`（package.json 的 `dependencies` 就是这两个 + vitest）。TUI 需要平行的 ink-testing-library 版本，否则 feature 包的 slot spec 无法在两条渲染线上共享。

### 9.4 对后续 ticket 的直接约束

- **可以先做、且几乎无风险的**：X1（ui-slots 契约微调）、X5（connection carrier 接缝）、X6（modules platform 参数化）、以及清掉 `packages/client/runtime/package.json` 的 `react` 死依赖 —— 这四项**即使 TUI 最终不做也是净收益**（把「第二个渲染器」的假设变成被检验过的接缝）。
- **必须先决策再动手的**：X0（React 版本线）、§3.3 的锚点契约三选一、路线 A/B。
- **不要在这张票里承诺的**：X8/X9（primitives + 28 个 feature 包）—— 那是产品范围问题，不是架构可行性问题。

---

## 附：本次调研核对过的关键文件

契约与渲染器
- `packages/client/ui-slots/src/renderer.ts`（全文）、`src/store.ts`（全文）、`src/index.ts`（1-120, 560-660, epoch 行）
- `packages/client/web-react/src/scoped-slots.tsx`（全文 910 行）、`src/session-provider.tsx`（全文）、`src/bind.ts`、`src/use-invoke.ts`、`src/index.ts`、`package.json`、`tsdown.config.ts`

runtime
- `packages/client/runtime/src/client/slots.ts`（全文）、`src/client/contract/store.ts`（全文）、`src/client/index.ts`（1-120, 180-260）、`package.json`、`lib/client.js`（require 审计）

线路
- `packages/client/connection/src/client/index.ts`（全文）、`src/client/web-api-client.ts`（全文）、`package.json`、`README.md`
- `packages/host/apiproxy/src/fetch/client.ts`（228-300, 516-541）、`src/fetch/handler.ts:243`

加载链与壳
- `packages/client/modules/src/client/index.ts`、`src/client/system.ts`（1-120）、`src/client/manifest.ts`（120-240）、`src/index.ts`（335-375）
- `packages/client/web/src/platform.ts`、`src/seed.ts`、`src/app-shell.ts`、`src/boot.tsx`（经 trace）
- `packages/client/tsdown.client.ts`（1-90）

文档
- `.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md`（全文）
- `.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md`（全文）
- `docs/subsystems/client-modules.md`（全文）

外部（实测，非记忆）
- `https://registry.npmjs.org/ink`（版本/peer/deps/engines/peerDependenciesMeta/发布时间）
- `https://cdn.jsdelivr.net/npm/ink@5.2.1/` 的 `build/index.d.ts`、`build/dom.d.ts`、`build/styles.d.ts`、`build/render.d.ts`、`build/reconciler.js`、`build/dom.js`、`build/ink.js`、`build/components/Box.js`、`build/render-node-to-output.js`、`readme.md`
- `node_modules/.pnpm/use-sync-external-store@1.2.0_react@18.3.1/`（shim 的 require 图与 DOM 检测分支）
