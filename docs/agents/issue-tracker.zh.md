# Issue 追踪器：GitHub

[English](issue-tracker.md) | 中文

本仓库的 issue 与规格说明以 GitHub issue 的形式存在。所有操作都使用 `gh` CLI（命令行界面）。

## 约定

- **创建 issue**：`gh issue create --title "..." --body "..."`。多行正文使用 heredoc。
- **读取 issue**：`gh issue view <number> --comments`，用 `jq` 过滤评论，并同时取回标签。
- **列出 issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，配合合适的 `--label` 与 `--state` 过滤条件。
- **评论 issue**：`gh issue comment <number> --body "..."`
- **添加／移除标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭**：`gh issue close <number> --comment "..."`

本仓库是 `zengsipei/deepseek-harness`，由 `git remote -v` 推断得出：在克隆目录内运行时，`gh` 会自动完成这一步。

## 把 pull request 作为 triage 入口

**PR（Pull Request）作为需求入口：否。** _（如果本仓库把外部 PR 视为功能请求，将其设为 `yes`；`/triage` 会读取该开关。）_

设为 `yes` 后，PR 与 issue 走同一套标签和状态，使用 `gh pr` 对应命令：

- **读取 PR**：`gh pr view <number> --comments`，用 `gh pr diff <number>` 查看差异。
- **列出待 triage 的外部 PR**：`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，然后只保留 `authorAssociation` 为 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR` 或 `NONE` 的条目（丢弃 `OWNER`/`MEMBER`/`COLLABORATOR`）。
- **评论／打标签／关闭**：`gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 让 issue 和 PR 共用一个编号空间，因此单独的 `#42` 可能指向其中任意一种：先用 `gh pr view 42` 解析，失败则回退到 `gh issue view 42`。

## 当某个 skill 说「发布到 issue 追踪器」时

创建一个 GitHub issue。

## 当某个 skill 说「取回相关工单」时

运行 `gh issue view <number> --comments`。

## Wayfinding 操作

由 `/wayfinder` 使用。**map** 是单个 issue，其**子** issue 充当工单。

- **Map**：一个带 `wayfinder:map` 标签的 issue，承载 Notes／Decisions-so-far／Fog 正文。`gh issue create --label wayfinder:map`。
- **子工单**：作为 GitHub 子 issue 链接到 map 的 issue（对子 issue 端点调用 `gh api`）。未启用子 issue 时，把子项加入 map 正文的任务列表，并在子项正文顶部写 `Part of #<map>`。标签：`wayfinder:<type>`（`research`/`prototype`/`grilling`/`task`）。一旦被认领，工单指派给推进该工作的开发者。
- **阻塞**：使用 GitHub 的**原生 issue 依赖**，这是规范的、在 UI 中可见的表示方式。用 `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>` 添加一条边，其中 `<blocker-db-id>` 是阻塞方的数值型**数据库 id**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`，_不是_ `#number` 或 `node_id`）。GitHub 会给出 `issue_dependencies_summary.blocked_by`（只统计未关闭的阻塞方，即实时闸门）。依赖功能不可用时，回退为在子项正文顶部写一行 `Blocked by: #<n>, #<n>`。当所有阻塞方都已关闭，该工单即解除阻塞。
- **前沿查询**：列出 map 下未关闭的子项（`gh issue list --state open`，范围限定为 map 的子 issue／任务列表），剔除存在未关闭阻塞方（`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 行中仍有未关闭 issue）或已有指派人的条目；map 中排序靠前者胜出。
- **认领**：`gh issue edit <n> --add-assignee @me`，这是本次会话的第一次写操作。
- **解决**：`gh issue comment <n> --body "<answer>"`，然后 `gh issue close <n>`，再把上下文指针（gist 加链接）追加到 map 的 Decisions-so-far。
