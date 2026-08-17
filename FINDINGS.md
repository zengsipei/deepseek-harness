# ink 在 Windows 原生终端上做严肃 TUI —— 约束调研

调研日期：2026-08-17
调研环境：Windows 11 Pro build 26220，Git Bash MINGW64（Git 2.55.0.windows.4），Node v24.19.0，pnpm 11.7.0
仓库：`F:/zsp/Ai/deepseek-harness`（dsh，Node `^22.19.0 || >=24.0.0`，ESM，React 18.3.1 全仓钉死）

> 证据强度标记：
> **[E]** = 我读到了一手来源（源码 / issue / release notes / npm registry / 本机实测），附链接
> **[E-local]** = 我在本机跑出来的只读实测结果
> **[I]** = 我的推断（有证据支撑但没有直接来源）

---

## 0. 结论先行

**不推翻 ink。但必须推翻本票的前提假设，并且必须走 ink 7.x + React 19.2。**

一句话理由：ink 不是停更项目 —— 最新版是 **7.1.1（2026-07-16）**，39.7k star、**仅 36 个 open issue**、2026-08-12 仍在提交；而本票列出的 8 类 Windows / 中文约束里，**有 5 类的修复只存在于 6.7.0+ 或 7.0.0+**（CJK 截断、宽字符覆写撕裂、中文 IME 光标定位、同步刷新消闪烁、备用屏幕缓冲区），所以"用停更的 5.2.x"这条路**确实死了**，但死因不是 Windows 不可用，而是 5.2.x 缺了所有中文相关的修复。

三点补充结论：

1. **本票的版本线前提有误。** ink 5.2.1 的 `peerDependencies.react` 是 `">=18.0.0"`，看起来兼容 React 18；但它依赖 `react-reconciler: ^0.29.0`，解析到 0.29.2，**其 peer 是 `react: ^18.3.1`** —— 所以 5.2.x 事实上是 **React 18 专用**，不能升 19。同时**存在本票不知道的 ink 7.x 线**（2026-04-08 起），要求 React >=19.2 + Node >=22。
2. **中文宽字符是"已被上游修好"的问题，不是 ink 的架构缺陷。** 根因在 `slice-ansi` 对宽字符切片向上取整（chalk/slice-ansi#43），2026-04-03 报，**次日**由 sindresorhus 修好并一路传到 ink。ink 7.0.0 的修复 commit `b5f3e3a` **只改了 2 行 package.json**（依赖提版）—— 这意味着 **ink 5.2.x / 6.x 也能靠 pnpm override 拿到这个修复**，这是一条真实且便宜的缓解路径。
3. **真正无法靠版本解决的中文风险有两个**：(a) **East Asian Ambiguous 宽度**（`●○ ─│ ± → …` 等）—— `string-width` 恒按 1 列算而 Windows Terminal 2026-02 起新增了 `compatibility.ambiguousWidth: wide` 选项，用户一开就全盘错位，且**应用侧无法探测**；(b) **中文 IME 输入**（组字、候选窗、光标定位）—— ink 6.7.0 才有 `useCursor()`，而对标对象 Claude Code 自己到 2026-08 仍有多个 open 的 CJK IME bug。

---

## 1. 约束矩阵

| # | 问题 | ink 5.2.x（React 18） | ink 6.x（React 19） | ink 7.x（React 19.2 + Node 22） | 缓解手段 | 严重度 | 证据 |
|---|---|---|---|---|---|---|---|
| 1a | CJK `<Box width>` / `wrap="truncate"` 溢出 | **坏**（cli-truncate ^4 / slice-ansi ^7） | **坏**（cli-truncate ^5.1.1 / slice-ansi ^8） | **已修**（cli-truncate ^6 / slice-ansi ^9） | pnpm override `cli-truncate@^6` + `slice-ansi@^9` + `string-width@^8.2`，API 无破坏性变更（v6 唯一 breaking 是 Node>=22） | 高 | [E] ink#927, chalk/slice-ansi#43, commit b5f3e3a |
| 1b | 宽字符被重叠写入切成半个（终端花屏） | **坏** | **坏** | **已修**（PR #930） | 只能升 7.x（是 ink 自己 `output.ts` 的逻辑，不是依赖） | 高 | [E] ink#929/#930, v7.0.0 notes |
| 1c | 新 emoji / ZWJ / 变体选择符宽度算错 | 中（string-width ^7：emoji-regex 版本锁死，新 emoji 算 1 列） | 好（6.8.0 起 string-width ^8） | 好（string-width ^8.2） | 6.8+/7.x 用 `Intl.Segmenter` + `\p{RGI_Emoji}`，跟随 Node 自带 Unicode 数据 | 中 | [E-local] + [E] string-width v8 源码 |
| 1d | East Asian **Ambiguous** 宽度与终端渲染不一致 | **坏** | **坏** | **坏** | 无。ink 从不传 `ambiguousIsNarrow`，恒为窄；WT 用户若开 `ambiguousWidth: wide` 则全盘错位。只能在 UI 里**禁用歧义宽度字符**（禁 `●○ ─│ → …`，改用纯 ASCII 或明确的全角/半角） | **高（不可修）** | [E] string-width 源码 + microsoft/terminal#19864 |
| 2a | Shift+Tab / 方向键 / Esc 的转义序列 | 好 | 好 | 好（+Kitty 协议自动探测） | ink 的 `parse-keypress.ts` 已覆盖 libuv 的 Cygwin 风格序列（`[[A`=F1、`[1~`=Home、`[4~`=End、`[Z`=Shift+Tab） | 低 | [E] ink parse-keypress 源码 + libuv win/tty.c |
| 2b | Windows 原始模式输入通路 | 依赖 Node 版本，非 ink | 同 | 同 | Node >= 24.2.0 / 22.17.0 才用 `UV_TTY_MODE_RAW_VT`（`ENABLE_VIRTUAL_TERMINAL_INPUT`）。dsh 的 `engines` 允许 24.0/24.1 —— **建议收紧到 `^22.19 \|\| >=24.2`** | 中 | [E] node PR#58358, libuv win/tty.c |
| 2c | 鼠标事件 / `ENABLE_MOUSE_INPUT` | 坏 | 坏 | 坏 | Node `setRawMode` 会覆盖 console mode flags，鼠标标志被抹掉。ink 7 的 `onClick` 在 Windows 上大概率不可用 | 中 | [E] node#61161, node#56338 |
| 3 | Ctrl+C 两次退出 | **可实现** | **可实现** | **可实现** | 三条线实现完全一致：ink 读 stdin 里的裸字节 `\x03`，从不听 SIGINT。设 `exitOnCtrlC: false`，在 `useInput` 里自己做两段式 | 低 | [E] ink App.tsx（三个 tag 都一致）+ Node docs + libuv |
| 4 | 真彩色 / 降级 | 好（WT/现代 conhost） | 好 | 好 | `supports-color` 在 win32 上**只看 `os.release()` build 号**，>=14931 一律返回 level 3，不看 `COLORTERM`/`WT_SESSION`。Win11 恒为真彩色 | 低 | [E] supports-color 源码 |
| 5a | resize 事件 | 有（`stdout.on('resize')`） | 有 | 有（+`useWindowSize()` hook） | 7.x 仅在 `interactive` 为真时订阅 resize | 低 | [E] ink ink.tsx |
| 5b | 备用屏幕缓冲区（`?1049`） | **无** | **无** | **有**（`render(el, {alternateScreen: true})`，closes #263） | 只能升 7.x。这是"严肃 TUI"与"会污染 scrollback 的 CLI"的分水岭 | **高** | [E] ink v7.0.0 release notes + ink.tsx |
| 5c | 渲染时清屏擦掉终端 scrollback（CSI 3 J） | 坏 | 坏 | 坏（**#935 仍 open**） | 开 `alternateScreen`（仅 7.x）可绕开；或 `incrementalRendering`（6.5.0+） | 中 | [E] ink#935（明确点名 claude-code#16310/#2479） |
| 5d | 闪烁（flicker） | **坏**（无同步刷新） | 6.7.0+ 好（DECSET 2026） | 好 | WT 自 2025-04 起支持 DECSET 2026 | 中 | [E] ink v6.7.0 notes + microsoft/terminal#18826 |
| 6a | Git Bash / mintty 下 `stdin.isTTY` | ink 直接 `throw` | 同 | 同（但可用 `interactive` 覆盖输出侧） | **已实测的解法**：改用 `fs.openSync('\\\\.\\CONIN$','r+')` / `CONOUT$` 建 `tty.ReadStream`/`WriteStream` 传给 `render({stdin, stdout})` —— 本机验证可得到真 TTY（120×30、24bit 色、raw mode OK） | 中（原为高，有解法后降级） | [E-local] + [E] node#63852/#63856 |
| 6b | Git Bash 下无颜色 | 坏 | 坏 | 坏 | `supports-color`：`!streamIsTTY → return 0`。需要 `FORCE_COLOR=3` | 中 | [E] supports-color 源码 |
| 6c | ink 6.8+/7.x 在非 TTY 下会 spawn `tput` | 无此依赖 | 6.8.0+ 有 | 有 | `terminal-size` 在 win32 上 `execFileSync('tput', ...)`。仅当 `stdout.columns` 为假值时触发 | 低 | [E] terminal-size 源码 |
| 7 | 中文 IME（组字 / 候选窗 / 光标） | **无支持** | 6.7.0+ 有 `useCursor()` | 有 | ink#759（CJK IME 输入延迟/掉字）**至今 open**；Claude Code 同类 bug 多个 open | **高** | [E] ink#759, PR#866, claude-code#82716/#77009/#73064 |
| 8 | 维护活跃度 | **已停更（2025-04-29）** | 停更（2026-02-19） | **活跃**（2026-08-12 仍在提交） | — | — | [E] npm registry + GitHub API |

---

## 2. 中文宽字符（重点章节）

这是本票里返工最贵的一项，所以拆开讲。

### 2.1 ink 的宽度是怎么算出来的

ink **不用** Yoga 算字符宽度。Yoga 只做 flexbox 排版，文本尺寸由 ink 通过 measure function 喂进去：

`src/measure-text.ts`（v5.2.1 与 v7.1.1 **实现基本相同**，7.x 只是把 `Record` 换成 `Map`）：

```ts
import widestLine from 'widest-line';
const width = widestLine(text);
const height = text.split('\n').length;
```

`widest-line` 就是逐行调 `string-width`：

```js
export default function widestLine(string) {
	let lineWidth = 0;
	for (const line of string.split('\n')) {
		lineWidth = Math.max(lineWidth, stringWidth(line));
	}
	return lineWidth;
}
```

`src/render-node-to-output.ts` 里再用 `widestLine(text)` 对比 `getMaxWidth(yogaNode)` 决定是否 `wrapText()`。

所以**宽度真相的唯一来源是 `string-width`**。三条线的版本：

| ink | string-width | 内部实现 |
|---|---|---|
| 5.2.1 | `^7.2.0` | `Intl.Segmenter` + **`emoji-regex@^10.3.0`** + `get-east-asian-width@^1.0.0` |
| 6.8.0 | `^8.1.1` | `Intl.Segmenter` + **`\p{RGI_Emoji}`（v flag）** + `get-east-asian-width@^1.3.0` |
| 7.1.1 | `^8.2.0` | 同上 + `get-east-asian-width@^1.5.0` |

来源：
- <https://registry.npmjs.org/ink>（各版本 `dependencies`）[E]
- <https://raw.githubusercontent.com/vadimdemedes/ink/v5.2.1/src/measure-text.ts> / `.../v7.1.1/src/measure-text.ts` [E]
- <https://raw.githubusercontent.com/sindresorhus/string-width/v7.2.0/index.js> 与 `.../main/index.js` [E]

**string-width v7 → v8 是一次实质性升级**，v8（2025-08-22）**删掉了 `emoji-regex` 依赖**，改用引擎自带的 `\p{RGI_Emoji}`，并新增：按 grapheme cluster 分段、Hangul jamo 合并、trailing spacing mark / 半角全角形式补宽、未完全限定的 ZWJ 序列与 keycap 序列判宽、纯 ASCII 快路径。

实际差异（本机实测的等价推演）：v7 的 emoji 判定被 `emoji-regex` 的 Unicode 数据版本锁死，**Unicode 15/16 新增 emoji 会落到 EAW 分支算成 1 列**；v8 跟随 Node 自带的 Unicode 数据，不会随时间腐化。

### 2.2 本机实测：宽度计算的坑长什么样 [E-local]

仓库里恰好有一份老的 `string-width@5.1.2`（`eastasianwidth@0.2.0`，2015 年的 Unicode 表），我拿它跑了一遍，用来演示"宽度库版本落后 = 静默算错"这一类失效的形状：

```
  2 | CJK 中文                     ← 每字 2 列，对
  2 | ZWJ 家庭 emoji 👨‍👩‍👧‍👦          ← 算 2，现代 WT 也渲染 2，对
  1 | U+1FA77 粉心（Unicode 15）    ← 算 1，终端渲染 2，✗ 错位
  1 | U+1FAE9（Unicode 16）         ← 算 1，✗ 错位
  1 | ● ○ ─ │ ± × ÷ → …            ← Ambiguous，恒算 1（见 2.3）
  1 | 组合字 e+U+0301               ← 对
  2 | 🇨🇳 国旗                       ← 对
```

结论：**宽度库的 Unicode 数据版本每落后一年，中文/emoji 界面就多一批静默错位**。ink 6.8+/7.x 用 `\p{RGI_Emoji}` 把这个腐化点消掉了，5.2.x 没有。

### 2.3 唯一真正无解的一项：East Asian **Ambiguous**

`string-width` v7 和 v8 **都**默认 `ambiguousIsNarrow: true`：

```js
const {ambiguousIsNarrow = true, countAnsiEscapeCodes = false} = options;
const eastAsianWidthOptions = {ambiguousAsWide: !ambiguousIsNarrow};
```

而 **ink 从来不传这个 option** —— `widest-line` 的调用是裸的 `stringWidth(line)`。所以 ink 在**任何版本上**都把 `●○ ─│ ± × ÷ → … ‘’ “” §` 这类 Ambiguous 字符算成 **1 列**。

问题在于终端侧：

- **microsoft/terminal PR #19864**（2026-02-13 提，**2026-02-27 合入**）新增全局设置 **`compatibility.ambiguousWidth`**，取值 `narrow`（默认）/ `wide`，closes #153 与 #370。
  <https://github.com/microsoft/terminal/pull/19864> [E]
  PR 正文自己承认："Some client applications (for example PSReadLine/readline-based apps) may still compute character widths independently. In such cases, cursor movement or Backspace behavior can differ from visual cell width even when terminal-side policy is consistent."

**这对我们意味着什么**：
- 默认情况下 WT 是 `narrow`，跟 `string-width` 一致 → 对齐正确。**[E]**
- 但一个中文用户为了"CJK 字体下更好看"把它调成 `wide`，终端就按 2 列画，ink 仍按 1 列排版 → **整个界面横向错位，且我们无法探测这个设置**（没有对应的终端查询序列）。**[E/I]**
- 传统 conhost（PowerShell 5.1 默认宿主）在 CJK 代码页（936）下历史上也倾向把 Ambiguous 当宽字符处理，同样无法探测。**[I]**

**唯一可靠的缓解是设计层面的**：在 TUI 的视觉语言里**禁用歧义宽度字符**。具体就是：边框只用 ink 内置的 `cli-boxes`（这些是 Box Drawing 区，属于 Ambiguous，**风险最高的恰恰是边框**），spinner 不用 `●○`，箭头不用 `→`，省略号不用 `…`。改用纯 ASCII（`- | + > ...`）或明确的全角字符。**这是架构 spec 必须写死的一条约束，不是实现细节。**

> 补一句：这也解释了为什么很多"看起来对齐"的 ink demo 在中文环境下会散架 —— 不是中文字宽算错了，是**边框字符**算错了。

### 2.4 已被修好的两个 CJK bug（决定版本线的关键）

**(a) ink#927 —— `<Box width>` / `wrap="truncate"` 被 CJK 撑破**
<https://github.com/vadimdemedes/ink/issues/927>（2026-04-03 报，2026-04-04 关）[E]

报告人 RyogaK 的定位极其干净，值得原样引用：

> The root cause is in `cli-truncate` (used by `wrap="truncate"`), not in Ink's layout engine.
> **What works correctly**: Box width calculation — `widest-line` and `string-width` both return correct display widths for CJK characters. Yoga layout computes correct dimensions. `wrap="wrap"` mode — `wrap-ansi` handles CJK character boundaries correctly. Output buffer — `output.ts` correctly handles multi-column characters.
> **What's broken**: `cli-truncate` calls `sliceAnsi(text, 0, columns - 1)` internally. When the slice boundary falls in the middle of a 2-column character, `slice-ansi` rounds **up** to include the full character.

上游 issue：<https://github.com/chalk/slice-ansi/issues/43> [E]

**修复链**：`slice-ansi v9`（2026-04-04）→ `cli-truncate v6`（2026-04-04）→ ink 7.0.0（2026-04-08）。

**关键发现**：ink 侧的修复 commit `b5f3e3ac4ea17e0208bb367d242071b912d04f66` 的 diff 是
```
package.json      +2/-2
test/text-width.tsx  +51/-0
```
—— **纯依赖提版**。[E]

各版本依赖：

| ink | cli-truncate | slice-ansi | 结论 |
|---|---|---|---|
| 5.2.1 | `^4.0.0` | `^7.1.0` | 有 bug |
| 6.8.0 | `^5.1.1` | `^8.0.0` | 有 bug |
| 7.0.0+ | `^6.0.0` | `^9.0.0` | 已修 |

`cli-truncate` v5.0.0 / v6.0.0 的 breaking change **只有 "Require Node.js 20/22"**，**没有 API 变更**（<https://github.com/sindresorhus/cli-truncate/releases>）[E]。dsh 已经要求 Node `^22.19 || >=24`，所以：

> **可行的缓解**：即使留在 ink 5.2.x 或 6.x，也能用 pnpm `overrides` 把 `cli-truncate` 强制到 `^6`、`slice-ansi` 到 `^9`、`string-width` 到 `^8.2`，拿到 CJK 截断修复。**这一条把"CJK 截断"从版本线决策里摘出去了。** [E → I（override 可行性是推断，但依赖约束与 API 稳定性是实证）]

**(b) ink#929 / PR#930 —— 重叠写入把宽字符切成半个**
<https://github.com/vadimdemedes/ink/issues/929>（2026-04-03，PR #930 于 2026-04-04 合入）[E]
标题："Overlapping write on wide (CJK) character splits it, corrupting terminal output"。

这个**不是依赖问题**，是 ink 自己 `src/output.ts` 的单元格缓冲逻辑。**只能靠升 7.x 拿到，无法 override。** [E]

历史上同类问题反复出现：#443/#444（2021，宽字符/emoji 破坏 box border）、#733/#861（2025-07/2026-01，emoji box border 对齐）、#748（2025-08，U+23F3 ⏳ 宽度不一致）、#784（2025-10，单格 UI 符号的 string-width 误算）。**这类 bug 在 ink 里是慢性病，每隔几个月复发一次。** [E]

### 2.5 中文 IME —— 比宽度更痛，且没有完全解决

对中文用户而言，**输入**比**渲染**更痛：raw mode 下终端把每个按键原样送进来，IME 组字过程（拼音串、候选窗、上屏）需要应用配合把光标放到正确的屏幕位置，否则候选窗会飘到别处、组字过程会掉字。

- **ink#759 "Input Lag, Characters Drop and Cursor position issue in languages using IME(CJK)"**，2025-08-30 开，**至今 open**。报告人明确说是从 gemini-cli 一路 debug 到 ink 的输入处理。
  <https://github.com/vadimdemedes/ink/issues/759> [E]
- **ink PR#866 "Add IME cursor positioning and Synchronized Update Mode"**（2026-02-08 合入，进 **6.7.0**）：新增 `useCursor()` hook —— "enabling CJK IME composition characters to appear at the correct location"；同时用 DECSET 2026 包裹输出，避免多路复用器读到中间态光标。
  <https://github.com/vadimdemedes/ink/pull/866> [E]
- 相关：#865 "IME composition buffering for Vietnamese, Chinese, Japanese, Korean input"、#846 "Synchronized Update Mode to fix IME issues"、#931 "CURSOR_MARKER for IME cursor positioning"。[E]

**结论**：ink **5.2.x 完全没有 IME 支持**（`useCursor` 是 6.7.0 才有的）。6.7.0+/7.x 有了 API，但**这是个需要应用主动使用的 hook，不是自动的** —— 你得自己知道光标该在哪一格并调 `useCursor()`。而且 #759 仍然 open，说明输入侧的延迟/掉字没有根治。[E]

对标对象 Claude Code 的现状（见 §8）说明这条路谁都没走通。

---

## 3. 原始模式输入（Windows 各终端的转义序列差异）

### 3.1 Windows 上 raw mode 的真实通路

这一层很多人搞错，值得写清楚。Node 的 `process.stdin.setRawMode(true)` 在 Windows 上走 libuv：

`libuv/src/win/tty.c` 的 `uv_tty_set_mode`：[E] <https://github.com/libuv/libuv/blob/v1.x/src/win/tty.c>

```c
case UV_TTY_MODE_RAW_VT:
  try_set_flags = ENABLE_VIRTUAL_TERMINAL_INPUT;
  InterlockedExchange(&uv__tty_console_in_need_mode_reset, 1);
  /* fallthrough */
case UV_TTY_MODE_RAW:
  flags = ENABLE_WINDOW_INPUT;
  break;
...
if (!SetConsoleMode(tty->handle, flags | try_set_flags) &&
    !SetConsoleMode(tty->handle, flags)) { ... }
```

两条路径：

- **`UV_TTY_MODE_RAW_VT`（现代）**：设 `ENABLE_VIRTUAL_TERMINAL_INPUT`，让**终端/ConPTY 自己**把按键翻成 VT 序列，Node 原样收。行为与 POSIX 一致。
- **`UV_TTY_MODE_RAW`（回退）**：只设 `ENABLE_WINDOW_INPUT`，**libuv 用自己的表**把 Windows `INPUT_RECORD` 翻成 VT 序列。

Node 用哪个？`src/tty_wrap.cc`：[E] <https://github.com/nodejs/node/blob/main/src/tty_wrap.cc>

```cpp
// UV_TTY_MODE_RAW_VT is a variant of UV_TTY_MODE_RAW that
// enables control sequence processing on the TTY implementer side,
// rather than having libuv translate keypress events into
// control sequences, aligning behavior more closely with
// POSIX platforms. This is also required to support some control
// sequences at all on Windows, such as bracketed paste mode.
int err = uv_tty_set_mode(&wrap->handle_,
    args[0]->IsTrue() ? UV_TTY_MODE_RAW_VT : UV_TTY_MODE_NORMAL);
```

**这是 Node PR #58358 "tty: use terminal VT mode on Windows"（2025-05-18 合入）带来的**，随 **Node v24.2.0（2025-06-09）** 与 **v22.17.0（2025-06-24）** 发布。[E]
- <https://github.com/nodejs/node/pull/58358>
- <https://github.com/nodejs/node/releases/tag/v24.2.0>（含 `c094bea8d9 tty: use terminal VT mode on Windows`）

> **对 dsh 的直接影响**：`engines.node` 目前是 `^22.19.0 || >=24.0.0`。`^22.19` 分支没问题（>=22.17），但 **`>=24.0.0` 允许 24.0.0 / 24.1.0，这两个版本还没有 VT input mode**，会退化到 libuv 的翻译表。建议收紧为 `^22.19.0 || >=24.2.0`。[E→I]

### 3.2 回退路径的具体坑（libuv 翻译表）

如果 `SetConsoleMode` 带 `ENABLE_VIRTUAL_TERMINAL_INPUT` 失败（老 conhost、被策略限制、非 ConPTY 宿主），libuv 用自己的 `get_vt100_fn_key()` 表。这张表有三个具体问题：[E]

1. **表里根本没有 `VK_TAB`。** 我核对过：`grep -c VK_TAB libuv/src/win/tty.c` → **0**。而且 `get_vt100_fn_key()` 只在 `KEV.uChar.UnicodeChar == 0`（"Function key pressed"）时才被调用。Shift+Tab 的 `UnicodeChar` 是 `\t`（0x09），走的是字符分支 → **Shift+Tab 塌陷成普通 Tab**，`\x1b[Z` 永远不会出现。
2. **F1–F5 用的是 Linux console 序列** `\x1b[[A` … `\x1b[[E`，不是 xterm 的 `\x1bOP`。源码注释自己写了："These mappings are the same as Cygwin's ... F1..f12 and shift-f1..f10 comply with linux console, f6..f12 with and without modifiers comply with rxvt."
3. **Home/End 是 `\x1b[1~` / `\x1b[4~`**，不是 xterm 的 `\x1b[H` / `\x1b[F` 或 `\x1bOH` / `\x1bOF`。

**好消息：ink 已经覆盖了这些。** `src/parse-keypress.ts`（源自 enquirer/keypress，最终源自 Node readline）在 **5.2.1 和 7.1.1 都**包含：[E]

```ts
/* from Cygwin and used in libuv */
'[[A': 'f1', '[[B': 'f2', '[[C': 'f3', '[[D': 'f4', '[[E': 'f5',
...
'[1~': 'home',
'[4~': 'end',
...
'[Z': 'tab',   // 配合 key.shift = true
```

所以**转义序列差异这一项，ink 的覆盖度是够的**；真正的风险是回退路径下 **Shift+Tab 在 libuv 层就丢了**，ink 再怎么解析也拿不到。

### 3.3 Kitty 键盘协议（Windows 上的新变量）

- **ink 6.7.0** 加入 Kitty keyboard protocol（opt-in，PR #855）；**ink 7.0.0** 改为 "query all terminals in auto mode instead of a hardcoded allowlist"（#895）。ink 7 有独立的 `src/kitty-keyboard.ts` + `src/input-parser.ts`，完整解析 CSI-u（`\x1b[<codepoint>;<mods>[:<eventType>][;<text>]u`）与增强版 legacy CSI。[E]
- **Windows Terminal 在 2026-01-29 合入了 Kitty 键盘协议**（microsoft/terminal#19817 "Implement the Kitty Keyboard Protocol"）。后续修 bug：#20361（AltGr 组合字被吞，2026-06-25 修）、#20499（按键重复被抑制，2026-08-02 修）；仍 open：#20243（F13-F20 序列不对）、#20246（扩展功能键消歧）、#20522（瑞士法语键盘重复字符）。[E]

**意味着**：ink 7.x + 较新的 Windows Terminal 才能在 Windows 上可靠地区分 `Shift+Enter` / `Ctrl+Enter` / `Shift+Tab`。conhost / PowerShell 5.1 宿主拿不到。**如果 TUI 的交互设计依赖这些组合键，就必须要求 WT + ink 7.x，并为 conhost 准备降级键位。** [E→I]

### 3.4 鼠标

- **node#61161**（2025-12-23）："Windows: setRawMode(true) overwrites console mode flags instead of preserving them" —— `ENABLE_MOUSE_INPUT | ENABLE_EXTENDED_FLAGS` 被抹掉。[E]
- **node#56338**（2024-12-22 开，2026-05-26 关）："tty.ReadStream does not pass in mouse event ANSI escape codes in Windows terminal"。[E]

**ink 7.0.0 新增的 `onClick`（PR #955）在 Windows 上大概率不可用。** [E→I] 不要把交互设计押在鼠标上。

---

## 4. Ctrl+C 两次退出

**结论：在 Windows 上完全可以实现，而且三条 ink 版本线的实现完全一致。**

### 4.1 Windows 上 Ctrl+C 到底走哪条路

Node 官方文档（`doc/api/process.md`，Signal events 小节）原文：[E] <https://nodejs.org/api/process.html#signal-events>

> `'SIGINT'` from the terminal is supported on all platforms, and can usually be generated with Ctrl+C (though this may be configurable). **It is not generated when terminal raw mode is enabled and Ctrl+C is used.**
>
> `'SIGTERM'` is not supported on Windows, it can be listened on.
>
> `'SIGHUP'` is generated on Windows when the console window is closed ... however Node.js will be unconditionally terminated by Windows about 10 seconds later.

底层机制（我核对到源码级）：Windows 只有在 console mode 里设了 **`ENABLE_PROCESSED_INPUT`** 时才会把 Ctrl+C 变成 `CTRL_C_EVENT`（→ Node 的 SIGINT）。libuv 的 raw 模式设的是 `ENABLE_WINDOW_INPUT`（RAW_VT 再加 `ENABLE_VIRTUAL_TERMINAL_INPUT`），**两者都不含 `ENABLE_PROCESSED_INPUT`** → raw mode 下 Ctrl+C **不产生 SIGINT，而是作为 `\x03` 字节从 stdin 进来**。[E]

### 4.2 ink 的处理（三条线一致）

`src/components/App.tsx`，v5.2.1：[E]

```ts
handleInput = (input: string): void => {
    // Exit on Ctrl+C
    if (input === '\x03' && this.props.exitOnCtrlC) {
        this.handleExit();
    }
    ...
};
```

v7.1.1 改成了函数组件 + hooks，但语义一字未改：`if (input === '\x03' && exitOnCtrlC) { ... }`。[E]

**ink 从不监听 `process.on('SIGINT')`。** 这反而是好消息 —— 意味着 Windows 与 POSIX 的行为天然一致。

### 4.3 实现方案

```
render(<App/>, { exitOnCtrlC: false })
```
然后在自己的 `useInput` 里：第一次收到 `\x03`（ink 会给出 `key.ctrl && input === 'c'`）→ 清空输入框 / 显示 "再按一次 Ctrl+C 退出" + 起一个 ~2s 定时器；定时器内第二次 `\x03` → 调 `useApp().exit()`。

**Windows 上唯一需要额外处理的**：
1. **非 raw mode 的窗口**（启动前、退出后、`suspendTerminal()` 交出终端期间）Ctrl+C 会走真 SIGINT 路径 → 需要同时挂一个 `process.on('SIGINT')` 兜底。[I]
2. **`SIGTERM` 在 Windows 上不可用**，优雅退出不能依赖它。[E]
3. **控制台窗口被关闭时 Windows 会在约 10 秒后无条件杀进程** —— 清理逻辑必须在 10s 内完成。[E]
4. ink#989 "Fix: restore terminal input modes when the process is continued (SIGCONT)"（2026-08-11 合入，尚未发版）说明**终端模式恢复**这条链到 2026 年 8 月还在修。[E]

---

## 5. 真彩色 / 256 色与降级路径

### 5.1 `supports-color` 在 Windows 上的探测逻辑

`chalk/supports-color` 的 `index.js`（ink 三条线都通过 chalk 5.x 用它）：[E] <https://github.com/chalk/supports-color/blob/main/index.js>

```js
if (haveStream && !streamIsTTY && forceColor === undefined) {
    return 0;
}

if (env.TERM === 'dumb') { return min; }

if (process.platform === 'win32') {
    // Windows 10 build 10586 is the first Windows release that supports 256 colors.
    // Windows 10 build 14931 is the first release that supports 16m/TrueColor.
    const osRelease = os.release().split('.');
    if (Number(osRelease[0]) >= 10 && Number(osRelease[2]) >= 10_586) {
        return Number(osRelease[2]) >= 14_931 ? 3 : 2;
    }
    return 1;
}
```

**两个关键性质**：

1. **win32 分支在检查 `COLORTERM` / `TERM` / `TERM_PROGRAM` 之前就 return 了。** 所以在 Windows 上，`COLORTERM=truecolor`、`WT_SESSION`、`TERM=xterm-256color` **一律不被参考**。本机 build 26220 → 恒定 **level 3（truecolor）**。[E-local + E]
2. **`isTTY` 为假直接返回 0**（无色）。这就是 Git Bash 下 ink 完全没颜色的原因。[E]

### 5.2 Windows 各宿主的实际支持度

| 宿主 | 真彩色 | 备注 | 证据 |
|---|---|---|---|
| Windows Terminal | 是 | 完整 24-bit | [E] MS 文档 |
| conhost（Win10 1703+ / Win11） | 是（VT 处理开启后） | libuv 在写侧会 `dwMode \|= ENABLE_VIRTUAL_TERMINAL_PROCESSING`（`src/win/tty.c`） | [E] libuv 源码 |
| PowerShell 7 | 跟宿主走 | 本身不限制 | [I] |
| PowerShell 5.1 / cmd.exe（conhost 宿主） | 同 conhost | 与 shell 无关，取决于宿主 | [I] |
| Git Bash / mintty | 支持，但 **ink 拿不到**（isTTY=false → level 0） | 需 `FORCE_COLOR=3` | [E] |

**降级路径**：`supports-color` 在 Windows 上基本不会给出 level 1/2（除非 Win10 < 14931，2026 年已不存在）。所以**降级在 Windows 上实际上是二值的：3 或 0**。要么全真彩色，要么完全无色。设计上应该保证**无色时界面仍然可读**（不能靠颜色区分语义），并支持 `FORCE_COLOR` / `NO_COLOR`。[E→I]

---

## 6. resize / 光标 / 备用屏幕缓冲区

### 6.1 resize

三条线都订阅 `process.stdout.on('resize')`。ink 7.1.1 `src/ink.tsx`：[E]

```ts
if (this.interactive) {
    options.stdout.on('resize', this.resized);
    this.unsubscribeResize = () => { options.stdout.off('resize', this.resized); };
}
```

ink 7.0.0 另外提供 `useWindowSize()` hook（返回 `{columns, rows}` 并在 resize 时自动重渲染）。[E]

尺寸读取走 `src/utils.ts` 的 `getWindowSize()`（6.8.0 起新增 `terminal-size` 依赖）：[E]

```ts
const {columns, rows} = stdout;
if (columns && rows) { return {columns, rows}; }
const fallbackSize = terminalSize();
return {columns: columns || fallbackSize.columns || 80, rows: rows || fallbackSize.rows || 24};
```

**Windows 隐患**：`terminal-size` v4 在 win32 上的实现是 [E] <https://github.com/sindresorhus/terminal-size/blob/main/index.js>

```js
if (process.platform === 'win32') {
    // We include `tput` for Windows users using Git Bash.
    return tput() ?? fallback;
}
```
`tput()` 是 `execFileSync('tput', ['cols'])` + `execFileSync('tput', ['lines'])`（各 500ms 超时）。**只在 `stdout.columns` 为假值（即非 TTY）时才走到**，而非 TTY 时 ink 也是非 interactive（只在 unmount 时写一帧），所以实际触发面很小。但在 Git Bash 下如果有人强制 `interactive: true`，**每帧会同步 spawn 两个子进程**。[E→I]

已知 Windows resize 相关 bug：
- **ink#916 "fix: account for visual line wrapping when erasing output on resize"** —— PR **未合入**，仍是问题。[E]
- **gemini-cli#28370 "Windows Hot-Reload & Terminal Resizes Trigger Unsolicited Full-History Replay (C-Dump) to stdout (Ink UI redraw loop cascade)"**（2026-07-12，已关）—— 说明 Windows 上 resize 触发全量重绘是真实发生过的。[E]

### 6.2 备用屏幕缓冲区 —— **版本线的第二个分水岭**

**ink 5.2.x 和 6.x 都没有。ink 7.0.0 才有。** [E]

ink v7.0.0 release notes：

> Add [`alternateScreen`](…) option to `render()` ([#263](https://github.com/vadimdemedes/ink/issues/263))  `5a60eb9`
> Renders into the terminal's alternate screen buffer (like vim or less), restoring the previous terminal content on exit.

`src/ink.tsx` 的门控：[E]

```ts
private resolveAlternateScreenOption(alternateScreen, interactive): boolean {
    return Boolean(alternateScreen) && interactive && Boolean(this.options.stdout.isTTY);
}
// 开启时写入 ansiEscapes.enterAlternativeScreen (= "\x1b[?1049h") + 隐藏光标
```

`#263 "Can ink be used as a 'full' screen application?"` 从 **2020-03-14** 开到 **2026-04**，整整四年。[E]

**Windows 支持**：`?1049` 在 Windows Terminal 与现代 conhost 上可用（microsoft/terminal#17154 "cursor size/type/isblinkingallowed get restored when switching back to main buffer from alt buffer" 已修，证明 alt buffer 是实现了的）。**未实现的是老的 DEC private 47 / 1047**（microsoft/terminal#3082，仍 open）—— 而 `ansi-escapes` 用的正是 `?1049`，所以没问题。[E]

### 6.3 不用备用屏幕时的代价（#935，仍 open）

**ink#935 "Render loop calls clearTerminal (CSI 3 J) — wipes terminal scrollback when output exceeds viewport"**，2026-04-10 开，**至今 open**。[E] <https://github.com/vadimdemedes/ink/issues/935>

> Ink's render path calls `clearTerminal` from `ansi-escapes` when `outputHeight > viewportRows`. This sequence includes `\e[3J` (CSI 3 J, "Erase Saved Lines"), which wipes the host terminal's scrollback buffer on every re-render that overflows.
> Long-running apps hit this on every re-render cycle. **The most visible downstream case is `@anthropic-ai/claude-code`**, where this has generated 25+ interactions across two open issues (anthropics/claude-code#16310, #2479).
> Downstream issues: anthropics/claude-code#16310, #2479; openai/codex#14277; microsoft/terminal#8736 (closed without toggle).

注意 `ansi-escapes` 在 Windows 上的 `clearTerminal` 定义（issue 里引用的）：
```js
ansiEscapes.clearTerminal = process.platform === 'win32'
    ? `${ansiEscapes.eraseScreen}${ESC}0f`
    : `${ansiEscapes.eraseScreen}${ESC}3J${ESC}H`;
```
Windows 分支不带 `3J`，所以**理论上 Windows 上 scrollback 不会被 3J 擦掉** —— 但 ink#800 "clearTerminal on Windows fails to clear history, causing excessive output when UI overflows"（2025-10-23）说明 Windows 分支反而导致**旧输出清不掉、屏幕堆积**。**这是同一个设计缺陷的两个 Windows/非 Windows 侧的表现。** [E]

相关仍 open：#917 "clamp cursor-up to viewport height, preventing terminal scroll-to-top"（PR #934 未合入）。[E]

**结论：一个"严肃 TUI"必须开 `alternateScreen`，而这只有 ink 7.x 有。** 这条比 CJK 截断更硬 —— CJK 截断能 override，alternateScreen 不能。

### 6.4 闪烁与同步刷新

- **ink 6.7.0** 加入 Synchronized Update Mode（DECSET 2026）："This fixes flickering in many modern terminals 🎉"。实现见 `src/write-synchronized.ts`（`bsu = '\x1b[?2026h'`, `esu = '\x1b[?2026l'`，门控 `isTTY && (interactive ?? !isInCi)`）。[E]
- **Windows Terminal 自 2025-04-23 起支持 DECSET 2026**（microsoft/terminal#18826，closes #8331）。[E]
- **ink 6.5.0** 加入 `incrementalRendering`（只更新变化的行），6.6.0 修了一部分增量渲染闪烁。[E]
- **ink 5.2.x 全都没有** —— 5.2.x 在 Windows 上做长时间运行的 TUI 会明显闪。[E→I]

历史闪烁 issue：#359（2020）、#450（2021，"Flickering when rendering element with height precisely equal to `process.stdout.rows`"）、#513（2022）。[E]

### 6.5 Windows 专属渲染 bug（近期）

| issue | 日期 | 状态 | 说明 |
|---|---|---|---|
| **#969 "Ink 7 rendering broken on all Windows terminals"** | 2026-06-10 | 已关（v7.0.6） | "Since upgrading from Ink 6 to 7, the ANSI escape sequences generated by Ink 7's render pipeline are incompatible with every Windows terminal — Git Bash, PowerShell, cmd, Windows Terminal. All produce garbled, overlapped text. Reverting to Ink 6 resolves the issue completely." |
| #971 "Fix stale frames on Windows when output exactly fills the terminal" | 2026-06-12 | 合入 → **v7.0.6** | #969 的修复 |
| #943 "Process left hanging after app exit on Windows" | 2026-05-04 | 已关 | |
| #800 "clearTerminal on Windows fails to clear history" | 2025-10-23 | 已关 | |
| #752 "Ink 6 adds a blank row at the bottom in full-screen mode (regression vs 5.x)" | 2025-08-26 | 已关 | |

[E] 全部来自 <https://github.com/vadimdemedes/ink/issues>

> **#969 是本调研里对"Windows 是否被认真对待"最有信息量的一条**：ink 7.0.0（2026-04-08）到 7.0.5（2026-05-29）**整整两个月，在所有 Windows 终端上都是坏的**，直到有人报了才在 7.0.6 修掉。**ink 没有 Windows CI。** [E→I]
>
> 直接推论：**永远不要在 ink 的 x.y.0 版本上跟进**，等至少一个补丁版；并且 dsh 自己必须有 Windows 渲染的快照/E2E gate（仓库里已经有 `check:ci:windows-blocking` / `check:ci:windows-complete` / `check:windows-wine` 这些 gate，应该把 TUI 渲染纳进去）。[E-local]

---

## 7. Git Bash / MSYS 伪终端

**这是本票里对"用户实际就在 Git Bash 上工作"这个前提威胁最大的一节。**

### 7.1 核心问题

`node.exe` 是原生 Windows 程序。在 mintty（Git Bash 默认终端）下运行时，它的 stdin/stdout 是 **MSYS 的命名管道**，不是 Windows console handle → **`process.stdin.isTTY` 为 `undefined`/`false`**。

而 ink 三条线的 raw mode 门控都是裸的 `stdin.isTTY`：[E]

```ts
// v5.2.1
isRawModeSupported(): boolean { return this.props.stdin.isTTY; }
// v7.1.1
const isRawModeSupported = stdin.isTTY;
```

不支持时 ink 直接抛：
```
Raw mode is not supported on the current process.stdin, which Ink uses as input stream by default.
Read about how to prevent this error on https://github.com/vadimdemedes/ink/#israwmodesupported
```

**本机实测**：[E-local] 我在这台机器的 Git Bash（MINGW64、Git 2.55.0.windows.4）上跑 node，得到
```
platform win32
stdin.isTTY undefined
stdout.isTTY undefined
columns undefined rows undefined
setRawMode ERR process.stdin.setRawMode is not a function
```
> ⚠️ **这次实测不构成 Git Bash 的判据** —— 我的 Bash 工具会把 stdout 接到管道，所以 isTTY 本来就该是 false。**需要人工在真实 mintty 窗口里交互式复现一次才能定论。** 这是本调研留下的最大一个未验证点。

### 7.2 现状（2026）

- `/usr/bin/winpty` **仍然随 Git for Windows 2.55 分发**。[E-local]
- 本机 `MSYS` 环境变量**未设置**（即没有显式 `enable_pcon`）。[E-local]
- git-for-windows#5960 "winpty aliases applied unnecessarily in Windows Terminal; break env var cygpath rewriting"（2025-11-17 已关）说明 **Git Bash 至今仍在给交互式程序套 winpty 别名**。[E]
- git-for-windows#3823 "Missed color for `CSI 2 m` with the enabled support for pseudo consoles"（仍 open）说明 Git for Windows **有** ConPTY 支持路径。[E]

**[I]** 我的判断：Git Bash 在 **mintty 宿主**下仍然是命名管道，`isTTY=false`；但 Git Bash 在 **Windows Terminal 宿主**（WT 的 "Git Bash" profile 直接跑 `bash.exe`）下走的是 ConPTY，**很可能 isTTY=true**。这个差异必须实测确认。

### 7.3 缓解手段（按优先级）

#### ⭐ 方案 1：绕开 `process.stdin`/`stdout`，直接开 `\\.\CONIN$` / `\\.\CONOUT$`（**本机已实测通过**）

Windows 上的 `/dev/tty` 等价物是 `\\.\CONIN$` / `\\.\CONOUT$`，**但两者都必须用读写权限（`'r+'`）打开**。

文献依据 —— nodejs/node#63852（2026-06-11 开）+ PR#63856：[E]
> `\\.\CONIN$` opens and `new tty.ReadStream(fd)` reports `isTTY: true`, but `setRawMode(true)` throws `EPERM`.
> （PR#63856 的结论）Document that `tty.ReadStream#setRawMode()` on Windows requires **write access** to the console input buffer. ... a read-only flag such as `'r'` allows creating a readable TTY stream, but `setRawMode()` fails because Windows needs write permission. **Recommend using a read/write flag such as `'r+'`.**

**本机实测结果 [E-local]**（Windows 11 build 26220，Git Bash MINGW64，Node v24.19.0，且该进程的 `process.stdin.isTTY` / `process.stdout.isTTY` 均为 `undefined`）：

```
process.stdin.isTTY=undefined  process.stdout.isTTY=undefined  columns=undefined rows=undefined

CONIN$  'r'  : open OK  isatty=true   ReadStream.isTTY=true   setRawMode ERR=EPERM      ✗
CONIN$  'r+' : open OK  isatty=true   ReadStream.isTTY=true   setRawMode=OK            ✓
CONOUT$ 'w'  : open OK  isatty=false  WriteStream ERR=uv_tty_init returned EPERM        ✗
CONOUT$ 'r+' : open OK  isatty=true   WriteStream.isTTY=true  columns=120 rows=30
                                       getColorDepth=24  hasColors(2^24)=true           ✓
```

**即：在 `process.stdout.isTTY` 为假的进程里，仍然可以拿到一个真正的 TTY —— 有正确的 120×30 尺寸、24 位色深、且 raw mode 可用。**

落地写法（ink 三条线的 `render()` 都接受自定义 `stdin`/`stdout`）：

```js
import fs from 'node:fs';
import tty from 'node:tty';

let stdin = process.stdin, stdout = process.stdout;
if (process.platform === 'win32' && !stdin.isTTY) {
  try {
    stdin  = new tty.ReadStream(fs.openSync('\\\\.\\CONIN$',  'r+'));  // 必须 'r+'
    stdout = new tty.WriteStream(fs.openSync('\\\\.\\CONOUT$', 'r+')); // 必须 'r+'
  } catch { /* 退回非交互模式 */ }
}
render(<App />, { stdin, stdout });
```

**残留不确定性**：这次实测的进程虽然 stdio 是管道，但它**仍然挂在一个 Windows console 上**（所以 CONIN$/CONOUT$ 能解析到真实控制台）。**在纯 mintty 宿主下、且没有 winpty/ConPTY 分配 console 的情况下，`\\.\CONIN$` 可能直接打不开。** 这一点仍需在真实 mintty 窗口里复现确认。[E-local + I]

#### 方案 2 及以下

2. **`winpty node ...`** —— 传统方案，但会引入额外的翻译层，且 winpty 不支持一些现代序列。[I]
3. **`FORCE_COLOR=3`** —— 因为 `isTTY=false` 会让 `supports-color` 直接返回 0。若采用方案 1，`getColorDepth()` 已是 24，此项可省。[E-local]
4. **ink 7.0.0 的 `interactive: true`** 可以强制输出侧走交互模式，但**不能**解决输入侧的 raw mode（那还是 `stdin.isTTY` 说了算）。[E]

2. **`winpty node ...`** —— 传统方案，但会引入额外的翻译层，且 winpty 不支持一些现代序列。[I]

3. **`FORCE_COLOR=3`** —— 因为 `isTTY=false` 会让 `supports-color` 直接返回 0。[E]

4. **ink 7.0.0 的 `interactive: true`** 可以强制输出侧走交互模式，但**不能**解决输入侧的 raw mode（那还是 `stdin.isTTY` 说了算）。[E]

### 7.4 codepage / 编码

Git Bash 本身是 UTF-8，但 Windows console 的 ANSI codepage 在中文系统上默认是 **CP936（GBK）**。这会污染**子进程**的输出：

- gemini-cli#20684 "fix(core): prevent CJK garbling in PTY shell output on Windows CP936"（已关）[E]
- gemini-cli#27142 "run_shell_command continuously garbles UTF-8 stdout on systems with non-UTF8 ANSI code pages (e.g. CP936)"（已关）[E]
- claude-code#81187 "Windows: harness sets `$OutputEncoding` but not `[Console]::OutputEncoding`, leaving PowerShell tool output mojibake after any chcp"（**open**）[E]

**对 dsh 的直接影响**：任何 spawn 子进程读输出的地方（工具调用、shell 执行）都必须显式处理 CP936 → UTF-8，**这与 ink 无关，但在中文 Windows 上是必然遇到的墙。** [E]

---

## 8. 生态现状与替代方案

### 8.1 ink 的健康度 —— 本票的前提需要更正

| 指标 | 值 | 来源 |
|---|---|---|
| star | 39,672 | `gh api repos/vadimdemedes/ink` [E] |
| **open issues** | **36** | 同上 [E] |
| 最后 push | **2026-08-12** | 同上 [E] |
| archived | false | 同上 [E] |
| 最新版本 | **7.1.1（2026-07-16）** | npm registry [E] |

发版节奏（npm registry `time` 字段）[E]：

```
5.2.0  2025-03-09     6.5.0  2025-11-12     7.0.0  2026-04-08
5.2.1  2025-04-29 ←   6.5.1  2025-11-19     7.0.1  2026-04-17
6.0.0  2025-05-29     6.6.0  2025-12-22     7.0.2  2026-05-05
6.0.1  2025-06-25     6.7.0  2026-02-10     7.0.3  2026-05-13
6.1.0  2025-07-27     6.8.0  2026-02-19 ←   7.0.4  2026-05-24
6.1.1  2025-08-13                           7.0.5  2026-05-29
6.2.x  2025-08                              7.0.6  2026-06-12
6.3.x  2025-09                              7.1.0  2026-06-17
6.4.0  2025-10-26                           7.1.1  2026-07-16 ←
```

**"ink ≥6 要求 React 19，所以只能用停更的 5.2.x" 这个二选一是错的** —— 真正的选择是 **"停在 React 18 + 一个停更 16 个月且缺全部中文修复的 ink"** vs **"升 React 19.2 + 一个活跃维护的 ink 7"**。

`master` 上尚未发版的提交（截至 2026-08-12）：`Fix unbounded text caches`、`Support generic Node.js streams in render options`、`Fix: Keep cursor on the last line when output has no trailing newline (#982)`、`Fix: restore terminal input modes when the process is continued (SIGCONT) (#989)`。[E]

**风险点：bus factor。** 提交几乎全部来自 vadimdemedes 与 sindresorhus。单人项目 + 无 Windows CI（见 §6.5 的 #969）。[E→I]

### 8.2 替代方案评估

硬约束：dsh 的 `SlotRenderer.renderRoot(host, ownerProps): ReactNode`（`packages/client/ui-slots/src/renderer.ts:189`，本机核实 [E-local]）要求替代品**必须是 React reconciler**，否则整个 client UI 层（`packages/client/ui-*` 二十多个包）全部作废。

| 方案 | React reconciler？ | React 版本 | 运行时 | Windows | 中文 | 结论 |
|---|---|---|---|---|---|---|
| **ink 7.x** | ✔ | >=19.2 | Node >=22，纯 JS | 有 bug 但在修，无 CI | 见 §2 | **推荐** |
| **ink 6.8** | ✔ | >=19.0 | Node >=20 | 同 | 缺 #930 修复 | 次选 |
| **ink 5.2.1** | ✔ | **18 only** | Node >=18 | 缺全部近期修复 | **缺 IME、缺同步刷新、缺 CJK 修复** | 不推荐 |
| **@opentui/react 0.5.3** (2026-08-13) | ✔（`react-reconciler ^0.33.0`） | **>=19.2** | Node（NAPI）或 Bun；**8 个原生平台包**，core 解包 13.3 MB | 有 win32-x64 / win32-arm64 包；近期修过多个 Windows bug | **CJK open issue 更多** | 见下 |
| **tuir 1.1.3** (2025-03-03) | ✔ | >=18（`react-reconciler ^0.29.0`） | Node >=18 | 未知 | 未知 | **比 ink 5.2.x 更停更**，淘汰 |
| **react-blessed 0.7.2** (2021-03-11) | ✔ | **>=17 <18** | Node | blessed 依赖 terminfo | — | **死项目**，淘汰 |
| Bubble Tea / Ratatui / Textual | ✘ | — | — | — | — | 需重写整个 UI 层，出局 |

**OpenTUI 详评**（<https://github.com/anomalyco/opentui>，13,035 star，**217 open issues**，2026-08-16 仍在推）[E]：

优点：非常活跃；确实是 React reconciler（`@opentui/react` peer `react >=19.2.0`）；已支持 Node.js（#1046/#1052/#1054 "Node.js runtime support for native core"，#1027 "remove Bun-specific runtime dependencies"，#1149 "support Node.js 26 alongside Bun"）；有真正的 TUI 能力（scrollbox、选择、embedded terminal、图片）；Windows 上主动修过 bug（#1272 `write Windows console output with WriteConsoleW`、#797 `treat raw \b as Ctrl+Backspace in Windows Terminal`、#1255 `resume() leaves input dead on Windows when setRawMode throws`）。

**致命缺点（对本项目）**：
1. **原生二进制分发** —— 8 个 optionalDependencies 平台包（含 `@opentui/core-win32-x64` / `-win32-arm64`），静态链接 libghostty，core 包解包 13.3 MB。对一个 npm 分发的 CLI 是重大的供应链与安装体积负担。[E]
2. **中文情况并不比 ink 好，反而更差。** open 的 CJK issue 一长串：#837 "CJK text rendered underneath a popup/overlay gets hidden or overwritten"、#1143 "allow line wraps between CJK characters"、#1226 "add common Chinese punctuation to wrap break characters"、#845 "Markdown CJK wrap duplicates glyph"、#1296 "Focused CJK textarea corrupts sibling content on the same row"、#1289 "Textarea vertical navigation can place the cursor inside a wide CJK grapheme"、#1329 "snap visual cursor columns to grapheme boundaries"、#1006 "improve handling of grapheme in OptimizedBuffer and GraphemeTracker"。[E]
3. **仍要 React 19.2** —— 换掉 ink 并不能免掉 React 升级。[E]

**→ 换 OpenTUI 不能解决本票任何一个核心痛点，只会把 ink 的已知问题换成一个更年轻库的更大 CJK backlog + 原生二进制。淘汰。**

---

## 9. 参考实现：别人踩到了什么

### 9.1 Claude Code（对标对象）

- npm `@anthropic-ai/claude-code` 最新 **2.1.233**，`dependencies: {}`（**完全 bundle**），`engines.node >= 22`。[E]
- ink#935 **直接点名**：`The most visible downstream case is @anthropic-ai/claude-code, where this has generated 25+ interactions across two open issues (anthropics/claude-code#16310, #2479).` —— 这是 Claude Code 使用 ink 的硬证据。[E]

**Claude Code 到 2026-08 仍然 open 的 TUI bug（全部与本票直接相关）**[E]：

| issue | 日期 | 主题 |
|---|---|---|
| **#82716** | 2026-07-30 | "IME-committed character inserted mid-line duplicates the CJK prefix and suffix (**display-width miscalculation in the IME commit path only**)" |
| **#77009** | 2026-07-12 | "Korean (Hangul) IME composition inserts stray characters (e.g. '?') across CLI TUI and Agents view" |
| **#73064** | 2026-07-02 | "Korean IME: cannot switch from English to Korean input (한/영 toggle ignored) **in Windows Terminal**" |
| **#66269** | 2026-06-08 | "CJK text corrupted (mojibake) when copying terminal output — **no-flicker/fullscreen renderer is the cause**; `tui: \"default\"` fixes it" |
| **#77390** | 2026-07-14 | "PgUp/PgDn not scrolling — Scroll context activates (cursor hides) but viewport doesn't move **on Windows**" |
| **#51418** | 2026-04-21 | "Terminal rendering repeats entire conversation history (regressed in v2.1.101)" |
| **#80629** | 2026-07-23 | "Terminal control sequences (SGR mouse reports, etc.) can leak literally into the composer during extended-thinking re-renders" |
| **#77072** | 2026-07-13 | "Persian/RTL text renders reversed inside boxed TUI components" |
| **#73630** | 2026-07-02 | "**Windows (CJK locale)**: permission rules with non-ASCII prefix never match; 'Always allow' persists mojibake rules" |

**#66269 尤其重要**：它揭示 Claude Code 有一个 `tui` 设置，可以在 **"no-flicker/fullscreen renderer"** 和 **"default"** 之间切换，且**前者会破坏 CJK 复制**。也就是说 **Anthropic 也没有一个同时满足"不闪"和"中文正确"的渲染模式，只能给用户一个开关。** [E→I]

> **对本票的直接输入**：以 Claude Code 为对标 = **继承这批问题**。用 ink 做中文 TUI，投入了 Anthropic 级别的资源，2026 年 8 月仍然有开着的中文 IME 与宽度 bug。**这必须作为 spec 的显式风险登记，并且在设计上主动规避（见 §2.3 的字符集约束、§10 的建议）。**

### 9.2 Gemini CLI —— **它没用上游 ink**

`google-gemini/gemini-cli` 的 `packages/cli/package.json`：[E]

```json
"ink": "npm:@jrichman/ink@6.6.9",
"react": "19.2.4",
"@types/react": "19.2.0",
```

**它用的是一个 fork**：`@jrichman/ink`（<https://github.com/jacob314/ink>，vadimdemedes/ink 的 fork，31 star，51 个已发布版本，从 6.3.1 分叉，最新 7.1.0 / 2026-06-24）。[E]

fork 的提交日志显示这是一次**渲染器重写**，不是小补丁：[E]

```
2026-06-24  feat: add offline static render caching and fix backbuffer overflow
2026-04-15  Optimize measure-text and styled-line.ts to reduce time from 1.97s to 1.31s
2026-04-14  Performance optimizations. / Further optimizations
2026-04-13  perf(regions): optimize memory allocation and terminal sync
2026-04-13  perf(terminal-buffer): optimize sticky headers equality check
2026-04-10  fix(scrollback): edge case where we would miss the backbuffer was dirty ...
2026-04-09  performance: optimize StyledLine for unstyled 1-width characters
2026-04-08  fix(layout): workaround yoga flex-shrink bug in column containers
2026-04-08  Switch StyledLine to stop using Uint16Array
2026-04-03  fix(scroll): completely remove stableScrollback padding
2026-03-31  Fix trailing space on line wrap issue.
```
新增了 `terminal-buffer` / `StyledLine` / `regions` / scrollback / sticky headers / scroll —— 全是上游 ink **至今没有**的东西（上游对应的还是 open issue：#988 "Add scrolling primitives"、#984/#985 selection）。依赖上它扔掉了 `widest-line`，直接用 `string-width ^8.1.0` + `is-fullwidth-code-point ^5.0.0`，并加了 `mnemonist`（高效数据结构）。[E]

**Gemini CLI 的 Windows / 中文 issue（大样本经验数据）**[E]：

| issue | 状态 | 主题 |
|---|---|---|
| **#18716** | **open** (2026-02-10) | "Severe **IME candidate window misalignment** when typing CJK characters **on Windows**" |
| #10673 | **open** (2025-10-07) | "Flicker free robust terminal rendering" |
| #28760 | **open** (2026-08-10) | "Thai combining characters (vowels/tones) missing/stripped when typing interactively ... (Windows)" |
| #28641 | **open** (2026-08-03) | "prevent ghost text wrapping infinite loop at narrow widths" |
| #27470 | closed (2026-05-27) | "Extra spaces appear between CJK characters in shell output" |
| #27505 | closed (2026-05-28) | "Prevent extra spaces on **width-0 CJK continuation cells**" |
| #27491 | closed (2026-05-27) | "Chinese characters result in garbled text" |
| #28309 | closed (2026-07-08) | "improve markdown rendering for **CJK text wrapping**" |
| #14475 | closed (2025-12-03) | "Fix **word navigation for CJK** characters" |
| #2458 / #2462 | closed (2025-06-28) | "Japanese/Chinese IME input shows only last character" / "Address IME character sequence issue for East Asian languages" |
| #25126 | closed (2026-04-10) | "[CRITICAL] CLI crashes on **Windows 11** with Node v22.16.0. `TypeError: newSpans.at is not a function at _StyledLine.mergeSpans`" |
| #27634 | closed (2026-06-02) | "**Windows** CLI text window automatically scrolls up to older messages while typing" |
| #28370 | closed (2026-07-12) | "**Windows** Hot-Reload & Terminal Resizes Trigger Unsolicited Full-History Replay (C-Dump) to stdout (Ink UI redraw loop cascade)" |
| #20684 | closed (2026-02-28) | "prevent CJK garbling in PTY shell output on **Windows CP936**" |

> **这是本调研最有价值的经验数据**：全世界最大的、有 Google 资源的 ink 应用，在 Windows + 中文上踩过上面每一个坑，**最后的选择是 fork ink 重写渲染器**。

**对我们的启示**：
1. **中文 + Windows 的 ink TUI 是可以做的**（gemini-cli 做出来了、Claude Code 做出来了），但**代价被反复低估**。
2. **fork 是一个真实存在的终局选项**，但 `@jrichman/ink` 是为 gemini-cli 定制的（31 star、单人、跟随上游 6.x/7.x 但不完全同步），**不建议作为 dsh 的依赖**。[E→I]
3. **上游 ink 7.x 正在往同一个方向走**（#988 scrolling primitives、#984/#985 selection、#980 frame-level cell composition，都是 2026-06~08 的 open PR）—— 说明这些能力是"严肃 TUI"的必需品，上游还在补。[E]

### 9.3 其他

- **openai/codex#14277** 被 ink#935 引用为同一 CSI 3 J 根因的下游案例（xterm.js 侧）。[E]
- 没有找到公开的、专门讲"ink + Windows + 中文"的 postmortem / 博客。**最好的公开经验数据就是上面两个 issue tracker。** [E]

---

## 10. 对 React 版本线决策的输入

### 10.1 先更正前提

| 本票的假设 | 实际情况 [E] |
|---|---|
| "ink 5.2.x 兼容 React 18" | 部分对。`peerDependencies.react` 是 `>=18.0.0`，但依赖 `react-reconciler ^0.29.0` → 0.29.2，其 peer 是 `react: ^18.3.1`，且带 `scheduler ^0.23.0`（React 18 的 scheduler）→ **事实上 React 18 专用，升不到 19**。 |
| "ink ≥6 要求 React 19" | 对。6.0.0+ peer `react >=19.0.0`（`react-reconciler ^0.32.0` → peer `react ^19.1.0`）。 |
| "实际可选的只有 5.2.x 和 6.x" | **错。存在 ink 7.x**（7.0.0 = 2026-04-08，7.1.1 = 2026-07-16），peer `react >=19.2.0` + `@types/react >=19.2.0`，`engines.node >= 22`，`react-reconciler ^0.33.0`。 |
| "5.2.x 在 2025-04 后不再更新" | 对。5.2.1 = 2025-04-29，之后无 5.x 发布。 |

### 10.2 基于 Windows 表现的排序

**推荐：ink 7.x（≥ 7.0.6，最好 7.1.1）+ React 19.2 + Node ≥ 22（建议 engines 收紧到 `^22.19.0 || >=24.2.0`）**

理由（全部是 Windows / 中文相关，与"用新版本比较好"这种泛论无关）：

1. **`alternateScreen` 只有 7.x 有**（#263，2020→2026）。没有它，长驻 TUI 会持续与终端 scrollback 打架（#935 至今 open，Claude Code 因此产生 25+ 条用户投诉）。**这是"严肃 TUI"的准入条件，且无法 override / backport。** [E]
2. **宽字符重叠写入撕裂的修复（#930）只有 7.x 有**，是 ink 自己 `output.ts` 的逻辑，**无法靠依赖 override 拿到**。中文界面必然大量触发重叠写入。[E]
3. **CJK 截断修复（#927）虽然 7.x 才默认带**，但**可以 override 到 6.x/5.2.x**（纯依赖提版，cli-truncate v6 唯一 breaking 是 Node>=22，dsh 已满足）。所以这一项**不是**版本线的决定因素，但 7.x 免去这份维护负担。[E]
4. **中文 IME 支持（`useCursor()`）从 6.7.0 起才有** —— 中文用户的输入框没有它就是不可用。**5.2.x 直接出局。** [E]
5. **同步刷新（DECSET 2026，消闪烁）从 6.7.0 起才有**，WT 自 2025-04 起支持。5.2.x 在 Windows 上会明显闪。[E]
6. **Kitty 键盘协议自动探测只有 7.x 有**（6.7.0 是 opt-in + 白名单），而 **WT 2026-01-29 才实现该协议** —— 只有 7.x 能自动吃到 Windows Terminal 上的 Shift+Tab / Ctrl+Enter 消歧。[E]
7. **`interactive` 覆盖选项只有 7.x 有** —— 在 Git Bash 这类 TTY 探测失败的环境里，这是唯一能强制交互式输出的开关。[E]
8. **只有 7.x 线还在收 bug fix。** 5.2.x 停在 2025-04，6.x 停在 2026-02。[E]

### 10.3 明确的反面：为什么不能停在 5.2.x

**"用停更的 5.2.x" 这条路死了 —— 但死因不是 Windows 崩溃，而是它缺了 2025-05 之后**所有**的中文与终端修复：**

| 能力 | 引入版本 | 5.2.x |
|---|---|---|
| 中文 IME 光标定位 `useCursor()` | 6.7.0 | ✘ |
| 同步刷新（消闪烁） | 6.7.0 | ✘ |
| 增量渲染 `incrementalRendering` | 6.5.0 | ✘ |
| `maxFps` 节流 | 6.3.0 | ✘ |
| Home / End 键 | 6.6.0 | ✘ |
| string-width v8（grapheme + RGI emoji） | 6.8.0 | ✘（v7，emoji 数据锁死） |
| CJK 截断修复 | 7.0.0 | ✘（可 override） |
| 宽字符重叠写入修复 | 7.0.0 | ✘（**不可 override**） |
| 备用屏幕缓冲区 | 7.0.0 | ✘（**不可 override**） |
| 括号粘贴 `usePaste` | 7.0.0 | ✘ |
| Kitty 协议自动探测 | 7.0.0 | ✘ |
| `interactive` 覆盖 | 7.0.0 | ✘ |

### 10.4 6.x 值不值得作为过渡

**不值得。** 6.8.0（2026-02-19）之后不会再有 6.x 发版，而 6.x → 7.x 的迁移成本很小（breaking 只有三条：Node>=22、React>=19.2、`key.backspace` 取代 `key.delete`、Escape 不再置 `key.meta`）。既然都要升 React 19，就一步到位到 19.2 + ink 7.x。[E]

**唯一的 6.x 理由**：如果全仓卡在 React 19.0/19.1 升不到 19.2。但 19.1→19.2 是 minor，不构成障碍。[I]

### 10.5 升级到 React 19 的实际代价（仓库侧）

- 全仓 **30+ 个 `packages/client/*` 包**把 `react` 钉在 `^18.2.0`（peer + dev），lockfile 解析到 **react 18.3.1**、`@types/react 18.3.31`、`@testing-library/react 16.3.2`。[E-local]
- 这些包是 **web 端**共用的（`packages/client/web-react`），所以升 React 19 **不只影响 TUI，会波及整个 web client**。这是本次决策的真实成本中心，**不是 ink 造成的**，但由 ink 触发。[E-local → I]
- `SlotRenderer.renderRoot(...): ReactNode` 契约本身与 React 版本无关，**升级不会破坏 slot 架构**，`ReactNode` 类型在 19 里仅有细微收紧（`bigint` 加入、`{}` 被移除）。[E-local + I]

### 10.6 建议写进架构 spec 的硬约束

1. **视觉语言禁用 East Asian Ambiguous 字符**（边框、spinner、箭头、省略号），因为终端侧 `ambiguousWidth` 不可探测。这是唯一无法靠版本解决的中文错位来源。
2. **必须开 `alternateScreen`**（→ 强制 ink 7.x），并为不支持的场景准备降级。
3. **`exitOnCtrlC: false` + 自管两段式 Ctrl+C**，同时挂 `process.on('SIGINT')` 兜底非 raw 窗口；不依赖 `SIGTERM`（Windows 无）；清理逻辑 < 10s（控制台关闭时 Windows 强杀）。
4. **Windows 上不走 `process.stdin`/`process.stdout`，改为 `fs.openSync('\\\\.\\CONIN$', 'r+')` + `fs.openSync('\\\\.\\CONOUT$', 'r+')` 建 `tty.ReadStream`/`tty.WriteStream` 传给 `render({stdin, stdout})`**，以覆盖 Git Bash / 管道场景。**注意两个句柄都必须用 `'r+'`（`'r'`/`'w'` 会 EPERM）。本机已实测通过**（见 §7.3）。
5. **`engines.node` 收紧到 `^22.19.0 || >=24.2.0`**，保证拿到 `UV_TTY_MODE_RAW_VT`。
6. **交互设计不依赖鼠标**（Windows 上 `ENABLE_MOUSE_INPUT` 被 `setRawMode` 抹掉）。
7. **不跟进 ink 的 `x.y.0`**，至少等一个补丁版（#969 前车之鉴：7.0.0–7.0.5 在所有 Windows 终端上是坏的）。
8. **补一条 Windows TUI 渲染的 CI gate**（仓库已有 `check:ci:windows-blocking` / `check:windows-wine` 骨架），因为 **ink 上游没有 Windows CI**。

---

## 11. 未验证 / 待补

1. **Git Bash（真实 mintty 窗口，交互式）下 `node` 的 `stdin.isTTY` 到底是不是 false** —— 我的实测被工具管道污染了。需要人工在 mintty 里跑一次 `node -e "console.log(process.stdin.isTTY, process.stdout.isTTY)"`，以及在 Windows Terminal 的 Git Bash profile 里跑同一条命令对比。
2. **`\\.\CONIN$` / `\\.\CONOUT$` + `'r+'` 的方案在纯 mintty 宿主下是否也成立** —— 本机已实测在一个 stdio 为管道的进程里成立（§7.3），但那个进程仍挂在一个 Windows console 上。若 mintty 完全不给子进程分配 console，`CreateFile` 会直接失败，需要回退到 winpty。**这是本调研留下的最大一个未验证点。**
3. **Windows Terminal 把 `compatibility.ambiguousWidth` 设为 `wide` 后，ink 界面的实际错位程度** —— 需要人工截图确认严重度。
4. **conhost（PowerShell 5.1 宿主）在中文 codepage 936 下对 Ambiguous 字符的实际渲染宽度** —— 我只找到历史 issue（microsoft/terminal#370、#153），没有 2026 年的一手确认。
5. **ink 7.x 的 `useCursor()` 在 Windows Terminal + 微软拼音下是否真的把候选窗放对位置** —— gemini-cli#18716 说这条路在 fork 上都还没走通。
6. **`@jrichman/ink` fork 相对上游到底改了什么（逐项）** —— 只看了提交标题，没有做 diff。若最终决定跟进上游 7.x，建议把这个 fork 的 `terminal-buffer` / `StyledLine` / scrollback 实现作为 dsh 自研渲染层的参考。
