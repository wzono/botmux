# 群级工作目录绑定设计

## 目标 / Goal

为普通飞书群增加一份独立于单个 Bot 配置的宿主机本地工作目录绑定，使同一宿主机上的所有 Bot 在创建群顶层会话或通过 `/th` 新开话题时得到一致、持久且可追踪的目录；同时保持话题会话的任务隔离、现有 per-Bot `oncallChats` 的授权语义和显式会话选仓能力。

## 背景 / Context

当前 `oncallChats` 存在于每个 Bot 的 `bots.json` 配置项中，实际语义是 “Bot × 群 → workingDir”，不是群内所有 Bot 共享的绑定。普通群 chat-scope 会话可被其他 Bot 临时继承，但依赖 active 会话存在。`/th` 的 “here” 生命周期找不到当前 Bot 的 oncall 绑定或 active chat-scope peer 时会拒绝启动。编队/profile 重写还可能覆盖 `bots.json` 中的运行态 `oncallChats`，因此用户观察到群目录“经常丢失”。

工作目录是宿主机绝对路径。同一飞书群可能连接多台机器，不能把一台机器上的路径复制到其他机器。

## 已确认决策 / Confirmed decisions

### 状态边界与优先级

新增宿主机本地、跨 Bot 共享的群绑定，逻辑键为 `chatId`；物理存储天然位于当前 Botmux 宿主机，因此不跨机器同步绝对路径。平台 `machineId` 只用于展示；未绑定平台时功能仍可用。

新会话解析目录的优先级为：

1. 当前会话或指令显式指定的目录；
2. 当前 Bot 对该群的 `oncallChats` 专用覆盖；
3. 当前宿主机的群级目录；
4. 当前 Bot 的 `defaultWorkingDir` / `defaultOncall.workingDir`；
5. 仓库选择卡。

`oncallChats` 继续同时承担 per-Bot 工作目录覆盖和对话授权，不自动迁移、不改义。

### `/repo` 与会话范围对齐

- 普通群顶层（`scope='chat'`）执行 `/repo <path|name|index>` 或在 repo 卡片中选择目录：切换当前 chat-scope 会话，并在会话切换成功后更新群级目录。
- 话题内（`scope='thread'`）执行相同操作：只切换当前话题，不写群级目录。
- `/repo wt ...` 创建任务 worktree，属于显式会话目录，不写群级目录，避免把短生命周期 worktree 设为全群默认。
- `/repo here` 复用当前目录但不制造新的群级写入；若顶层当前目录已经来自有效群绑定，其状态不变。
- `/repo show` 只读展示当前会话目录、群级目录、当前 Bot 的专用覆盖、最终来源、revision 和最后更新时间。
- `/repo unbind` 只允许在普通群顶层解除当前宿主机群绑定；不修改当前已运行会话或 `oncallChats`。

顺序写入以后一次成功提交为准。真正并发写入使用 revision/CAS；先提交者成功，后提交者收到冲突和当前值，不静默覆盖。相同 `sourceMessageId` 重放幂等返回既有结果。

### 运行中会话

群级目录更新不强切正在执行的会话：

- 发起 `/repo` 的 chat-scope 会话按现有安全切仓流程立即切换，切换成功后提交群绑定。
- 之后创建的新会话和 `/th` 读取新绑定。
- 既有 thread-scope 会话保持自己的目录。
- 其他 Bot 的既有 chat-scope 会话不被跨进程主动关闭；下一次空闲回合开始前若其目录来源是旧群绑定且没有显式/per-Bot 覆盖，则安全恢复到新群目录并给出一次提示。

### 权限

群绑定修改权限不取决于命令发给哪个 Bot：

- 默认管理者是当前宿主机所有已注册 Bot 的 `resolvedAllowedUsers` 并集。
- 群级记录可带 `workspaceManagers`；非空时只允许该名单中的人修改，默认并集不再生效。
- 飞书群主/群管理员不自动获得本地文件系统控制权。
- Bot 事件不能以 Bot 自身身份修改群绑定。受信任 Bot 代办时必须携带并验证原始人类操作者；首版没有可靠人类来源时拒绝群级写入，但仍可按既有规则切当前会话。
- 所有成功写入记录 `updatedBy`、`sourceMessageId`、旧值、新值和 revision。

### 持久化与失效

新增共享 store，位于 `SESSION_DATA_DIR` 下，不进入 `bots.json`。建议文件为 `group-workspaces.json`，以现有跨进程文件锁和原子写模式更新。记录结构：

```ts
interface GroupWorkspaceBinding {
  chatId: string;
  workingDir: string;
  revision: number;
  updatedAt: number;
  updatedBy: string;
  sourceMessageId: string;
  workspaceManagers?: string[];
}
```

设置时必须验证目录存在且为目录。绑定建立后目录失效时 fail closed：新会话、`/th` 和需要恢复的会话明确报“群级目录已失效”，不得回退到 `~`、Bot 默认目录或选仓卡。记录保留，管理员通过新的顶层 `/repo` 修复或 `/repo unbind` 解除。

## 备选方案与否决理由

1. **复制到每个 Bot 的 `oncallChats`**：改动小，但继续与授权耦合，新增 Bot 和编队重写仍会产生漂移，否决。
2. **只复用 active chat-scope 会话**：无需新存储，但会话关闭/回收后失效，不能解释和修复“绑定丢失”，否决。
3. **新增 `/workspace` 命令**：边界清楚，但增加第二套工作目录心智模型；用户明确要求与 `/repo` 运行时范围对齐，否决。

## 非目标 / Non-goals

- 不跨宿主机同步或映射绝对路径。
- 不自动迁移、合并或删除现有 `oncallChats`。
- 不改变 oncall 对话授权、defaultOncall 或 Bot 默认目录语义。
- 不让 `/repo wt` 自动成为群默认目录。
- 首个 PR 不要求 Dashboard 编辑界面；只读展示可后续增加，命令行为和 store 是本 PR 范围。
- 不清理历史 worktree，不改变 worktree 生命周期。

## 验收标准 / Acceptance criteria

1. Bot A 在普通群顶层成功执行 `/repo X` 后，同机 Bot B 新开的 chat-scope 会话和 `/th` 使用 X；daemon 重启后仍成立。
2. 在话题内执行 `/repo Y` 只影响该话题；群绑定仍为 X，其他 Bot 新会话仍使用 X。
3. 当前 Bot 存在 `oncallChats[chatId]=Z` 时，该 Bot 使用 Z；无专用覆盖的 Bot 使用 X。
4. 编队/profile 重写 `bots.json` 不改变共享群绑定。
5. 两个不同 source message 基于同 revision 并发写入时仅一个成功；另一个返回冲突和当前值。相同 source message 重放不增加 revision。
6. 未授权真人、无可验证真人来源的 Bot 不能写或解绑群绑定；配置 `workspaceManagers` 后默认管理员并集不再越权。
7. X 被删除后，新会话、`/th` 和需要跟随的旧 chat-scope 会话均停止并显示修复方法，不静默回退。
8. `/repo show` 能区分 session / per-Bot oncall / group / bot default 的值和最终来源；`/repo unbind` 不改变已运行会话或 oncall 配置。
9. 现有 thread `/repo`、pending repo 卡、mid-session switch、`/repo wt`、remote backend fail-closed 和 oncall 测试无回归。

## 风险与 Gate / Risks and gates

- 这是跨进程持久状态语义变更，必须覆盖人工中途干预、部分写入失败、并发重入，并按仓库规则做独立对抗复核和变异复验。
- 群绑定只能在会话切换成功后提交；先写绑定后切会话会留下“记录已变、实际会话未变”的半完成状态。
- 共享 store 损坏或锁失败必须 fail closed，不得当作“无绑定”。
- Draft PR 可在规格和计划提交后创建；实现、自测、独立审查完成前不得合并或部署。
- 部署/重启由 Botmux 维护者在用户另行授权后执行，本 PR 创建不包含生产切换。

## AI Agent 执行指引 / Implementation guidance

优先新增聚焦的 `src/services/group-workspace-store.ts`，不要把共享状态塞入 `bot-registry.ts` 或 `oncall-store.ts`。在 `src/daemon.ts` 的新会话目录解析中加入群绑定层，并在失效时返回可区分的错误而不是 `undefined`。文本 `/repo` 与卡片选择必须通过同一个“会话提交成功后更新群绑定”的 helper，避免入口漂移。

关键调用链：

- `src/daemon.ts`：`resolvePinnedWorkingDir`、`resolveForceTopicCurrentWorkingDir`。
- `src/core/command-handler.ts`：`case '/repo'`、文本选仓提交与 show/unbind。
- `src/im/lark/card-handler.ts`：模块级 `commitRepoSelection` 和 repo 卡权限。
- `src/im/lark/event-dispatcher.ts`：`canOperate` / `canRunDaemonCommand` 与原始人类来源。
- `src/services/session-store.ts`：跨 Bot chat-scope 会话枚举。

测试先写失败用例，再做最小实现；至少运行定向 Vitest、`bun run build` 和受影响命令/路由测试。PR 描述记录 before/after 证据、影响面、回退方式和独立复核结果。
