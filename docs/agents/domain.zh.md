# 领域文档

[English](domain.md) | 中文

工程类 skill（技能）在探查代码库时应如何使用本仓库的领域文档。

## 探查之前先读这些

- 仓库根目录的 **`CONTEXT.md`**，或者
- 仓库根目录的 **`CONTEXT-MAP.md`**（如果存在）：它为每个上下文指向一份 `CONTEXT.md`。凡与当前主题相关的都要读。
- **`docs/adr/`**：阅读涉及你即将改动区域的 ADR（架构决策记录）。在多上下文仓库中，还要查看 `packages/<group>/docs/adr/` 中作用于特定上下文的决策。

如果这些文件都不存在，**静默继续**。不要指出它们缺失，也不要预先建议创建。`/domain-modeling` skill（经由 `/grill-with-docs` 和 `/improve-codebase-architecture` 抵达）会在术语或决策真正被确定下来时惰性创建它们。

## 文件结构

本仓库是单上下文的：根目录一份 `CONTEXT.md` 加一个 `docs/adr/`，覆盖 `packages/` 与 `apps/` 下的所有工作区：

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-vendored-cordis-plugin-spine.md
│   └── 0002-typert-rpc-gateway.md
├── packages/<group>/<pkg>/
└── apps/
```

多上下文仓库的形态，供参考（以根目录存在 `CONTEXT-MAP.md` 为标志）：

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← system-wide decisions
└── packages/
    ├── llm/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← context-specific decisions
    └── session/
        ├── CONTEXT.md
        └── docs/adr/
```

## 使用术语表的词汇

当你的产出提到某个领域概念时（在 issue 标题、重构提案、假设、测试名称中），使用 `CONTEXT.md` 中定义的术语。不要漂移到术语表明确回避的同义词上。

如果你需要的概念尚未进入术语表，这本身就是一个信号：要么你在生造项目并不使用的说法（重新考虑），要么确实存在一处空缺（记下来交给 `/domain-modeling`）。

## 标记 ADR 冲突

如果你的产出与既有 ADR 相抵触，明确指出来，而不是悄悄覆盖：

> _与 ADR-0007（事件溯源的订单）相抵触，但值得重新讨论，因为……_
