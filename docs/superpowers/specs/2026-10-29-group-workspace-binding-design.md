# 群级工作目录绑定设计

## 目标 / Goal

为普通飞书群增加一份独立于单个 Bot 配置的宿主机本地工作目录绑定，使同一宿主机上的所有 Bot 在创建群顶层会话或通过 `/th` 新开话题时得到一致、持久且可追踪的目录；同时保持话题会话任务隔离、现有 per-Bot `oncallChats` 授权语义和显式会话选仓能力。

## 背景 / Context

当前 `oncallChats` 位于每个 Bot 的 `bots.json`，实际语义是 “Bot × 群 → workingDir”，不是群内所有 Bot 共享的绑定。普通群 chat-scope 会话可临时继承其他 Bot 的 active 会话，但会随会话关闭而消失；`/th` 找不到当前 Bot 的 oncall 绑定或 active peer 时会拒绝启动。编队/profile 重写还可能覆盖 `bots.json` 中的运行态 `oncallChats`。

工作目录是宿主机绝对路径。同一飞书群可能连接多台机器，不能把一台机器的路径复制到其他机器。

## 已确认决策 / Confirmed decisions

### 状态边界与目录优先级

新增宿主机本地、跨 Bot 共享的群状态，逻辑键为 `chatId`；物理存储天然位于当前 Botmux 宿主机，不跨机器同步。平台 `machineId` 只用于展示，未绑定平台时功能仍可用。

新会话解析目录的优先级为：

1. 当前会话或指令显式指定的目录；
2. 当前 Bot 对该群的**显式/人工** `oncallChats` 专用覆盖；
3. 当前宿主机的有效群级目录；
4. 当前 Bot 的 `defaultWorkingDir` / `defaultOncall.workingDir`；
5. 仓库选择卡。

`oncallChats` 继续承担 per-Bot 对话授权，不自动迁移、不改义。为避免 `defaultOncall` 的自动绑定遮蔽已存在的群目录，cwd 来源必须区分：

- `oncall-explicit`：人工配置或明确选定的专用覆盖，优先于群目录；
- `oncall-default-auto`：`ensureDefaultOncallBound` 为授权/兼容自动生成的记录；它保留 oncall 授权效果，但在 cwd resolver 中不作为显式覆盖。存在有效群目录时取群目录，不存在群目录时才使用其 `defaultOncall` 目录。

新写入记录必须带来源；历史 `oncallChats` 没有来源时不猜测、不批量迁移，按既有显式覆盖处理，避免改变已运行部署。授权判定仍看原有 oncall 绑定，不因 cwd resolver 跳过 `oncall-default-auto` 而缩小权限。

### `/repo` 与会话范围对齐

- 普通群顶层（`scope='chat'`）执行 `/repo <path|name|index>` 或选择 repo 卡：执行下述两阶段操作；会话切换成功后才尝试提交群目录。
- 话题内相同操作只切当前话题，不写群状态。
- `/repo wt ...` 属于显式会话 worktree，不写群状态。
- `/repo here` 复用当前目录，不制造群写入；若当前目录来自群绑定，状态不变。
- `/repo show` 只读展示 session、显式 per-Bot oncall、自动 defaultOncall、group、bot default、最终来源、群 revision/状态和更新时间。
- `/repo unbind` 只允许普通群顶层执行：提交 tombstone，不修改当前会话、ACL 或 `oncallChats`。

不同事件的并发写入使用 group revision/CAS；先提交者成功，后提交者返回冲突和当前值，不自动 rebase 或覆盖。重放由持久 operation receipt 判定，而不是只比较当前 binding 的 message id。

### 稳定人类身份与权限入口

群管理主体统一为 `TenantHumanId = { tenantKey, unionId }`。`open_id (ou_*)` 只在签发 app 内用于事件解析，禁止跨 app 直接比较；`union_id (on_*)` 只有在同租户边界内才稳定。无法取得 tenant 或 union_id、来源为 Bot、身份转换不确定时，群状态写入 fail closed。

默认管理者集合来自宿主机的管理员 union 快照：对所有已注册 Bot 的 `resolvedAllowedUsers`，通过各自 app 将真人归一化为 `TenantHumanId`，去重后持久化/缓存。每次授权必须同时校验快照的 `configFingerprint` 与当前参与计算的 Bot 配置指纹一致；配置变化、快照过期、转换失败或租户不一致时先刷新，无法得到 fresh snapshot 则拒绝，不使用旧管理员资格。`workspaceManagers` 也存同一 `TenantHumanId` 类型；非空时完全替代默认并集。

文本命令和卡片动作在接收 Bot 的通用 `canRunDaemonCommand` / repo-card gate **之前**增加窄路由：仅当事件已经解析为普通群的 `/repo <selection>` 或 `/repo unbind`（卡片则为该群原始 repo 请求对应的 selection/unbind action），且 `canManageGroupWorkspace(chatId, TenantHumanId, freshSnapshot)` 通过时，允许到达 group-workspace 操作路径。该例外：

- 不授予普通对话、其他 daemon 命令、thread `/repo`、`/repo wt`、`/repo here` 或跨群卡片权限；
- 不绕过目标路径校验、operation journal、CAS 或 session switch 的原有安全检查；
- 对仅有群管理权、没有接收 Bot 权限的人，只允许这次群操作。若会话切换需要接收 Bot 的额外能力而不具备，则不得降级为普通 switch；应明确拒绝且不写群状态。

飞书群主/群管理员不自动获得本地文件系统控制权。受信任 Bot 代办必须携带并验证原始真人的 `TenantHumanId`；首版无法验证时拒绝群写入。所有终态收据记录稳定 `actor`、源事件、旧/新值和 revision。

### 持久状态模型：单调群版本、ACL 与历史收据

共享 store 位于 `SESSION_DATA_DIR/group-workspaces.json`，使用现有跨进程锁和原子写模式。目录状态、ACL 和版本生命周期分离：

```ts
type TenantHumanId = { tenantKey: string; unionId: string };

type GroupDirectoryState =
  | { kind: 'bound'; workingDir: string }
  | { kind: 'unbound' }; // tombstone

interface GroupWorkspaceRecord {
  chatId: string;
  revision: number;              // set/unbind 均严格递增，永不因重绑归零
  directory: GroupDirectoryState;
  workspaceManagers?: TenantHumanId[]; // unbind 后保留
  updatedAt: number;
  updatedBy: TenantHumanId;
}

type GroupOperationKind = 'set' | 'unbind';
interface GroupOperationReceipt {
  operationKey: string;          // digest(sourceEventId, kind)
  sourceEventId: string;         // 下述文本/卡片 canonical source identity 的稳定 digest
  originMessageId?: string;      // 卡片原始请求/卡片消息，参与卡片 source identity 并供审计
  kind: GroupOperationKind;
  payloadDigest: string;         // 首次请求的 canonical semantic intent；明确不含 expectedRevision
  chatId: string;
  outcome: 'committed' | 'conflict' | 'invalid_dir' | 'unauthorized' | 'store_unavailable';
  resultingRevision?: number;
  resultingDirectory?: GroupDirectoryState;
  actor: TenantHumanId;
  completedAt: number;
}
```

`sourceEventId` 必须是跨接收 Bot、跨实时投递与历史恢复都相同的 canonical stable identity：

- 文本命令使用带版本的 tuple/digest `(stableTenantIdentity, chatId, originalImmutableLarkMessageId)`。`originalImmutableLarkMessageId` 只取飞书原始 `message_id`；投递 `event_id`、delivery/attempt id 仅写审计字段，绝不进入 `sourceEventId`、`operationKey` 或其他幂等键。`stableTenantIdentity` 优先取事件中可信的 tenant key；缺失时只允许回退到已通过飞书身份转换验证、且在各接收 app 下解析为同一 tenant key 的宿主机 tenant 映射。无法建立这种稳定 tenant identity 时 fail closed，不读取/创建 operation，也不执行 session/group 副作用；app id、Bot id 或 app-scoped `open_id` 不能充当回退值。
- 卡片动作保留独立的 source identity：使用带版本的 tuple/digest `(stableTenantIdentity, chatId, originalImmutableRequestOrCardMessageId, immutableActionIdentity)`；其中 immutable action identity 是飞书 action event id（或平台明确保证不可变且全局唯一的等价 action id）。原始请求/card 与 action identity 都参与 canonical source identity，投递 attempt id 仍只供审计，因此同一张卡的两个独立 action 不会被误合并，单个 action 的重复投递会命中同一 operation。

收据跨重启持久保留（首版不做自动清理）。幂等查找的唯一顺序不变量是：**在读取当前 group revision、重新解析 repo target 或执行任何副作用之前**，先按 `(canonical sourceEventId, operation kind)` 查 journal/receipt。若已存在，先将本次请求的 canonical semantic intent 与首次操作冻结的 `payloadDigest` 比较；该 digest 覆盖 `chatId + kind + normalized selection/requested path`（unbind 为 tombstone），明确排除 `expectedRevision` 以及任何当前状态。digest 不同即以 protocol conflict 拒绝；digest 相同则复用首次 journal 冻结的 canonical target、`expectedRevision` 和 expected session generation，禁止重新解析 target 或重读 revision 来改写它们。只有首次看见 `(sourceEventId, kind)` 时才解析 canonical target、读取当前 revision/session generation，并把 semantic payload digest、target、`expectedRevision`、session generation 一次性持久化。这样介入写入改变 revision 后的重放仍返回首次操作结果，`payloadDigest` 不会因 revision 重读而变化。解绑自身也有 receipt，并提交 `revision + 1` 的 tombstone；后续重绑继续递增。解绑不删除 `workspaceManagers`，因此不会扩大 ACL。

共享 store 损坏、lock/read/write/fsync/rename 失败均 fail closed；不能解释成“没有绑定”。

### 两阶段操作 journal 与成功响应边界

顶层 `/repo` 是跨 session store 与 group store 的持久 saga，不宣称文件级原子。副作用前先持久化 journal：

```ts
type RepoGroupOperationPhase =
  | 'prepared'
  | 'session_committed'
  | 'group_committed'
  | 'conflict'
  | 'store_unavailable'
  | 'unknown';

interface RepoGroupOperationJournal {
  operationKey: string;
  sourceEventId: string;
  payloadDigest: string;          // 首次 semantic intent，不含 expectedGroupRevision
  chatId: string;
  sessionId: string;
  expectedSessionGeneration: number;
  expectedGroupRevision: number;
  targetWorkingDir: string;
  actor: TenantHumanId;
  phase: RepoGroupOperationPhase;
  sessionGenerationAfter?: number;
  groupRevisionAfter?: number;
}
```

状态转移：

1. 入口先用 canonical `sourceEventId + kind` 查 journal/receipt，并按上节校验 semantic intent；命中时复用冻结的 target、expected revision 与 session generation。只有首次操作才解析 target、读取当前 revision/session generation；授权、路径可用性与 revision 校验后，在任何 session/worker 副作用前把这些值连同不含 expectedRevision 的 payload digest 写入 `prepared`。
2. 重放/恢复不得先重读 revision 或重新解析 target；终态 receipt 直接返回，`prepared` 使用冻结值读回 session generation/cwd，只有能证明未提交时才执行一次 switch，能证明已提交则推进，无法证明则置 `unknown` 并停止人工可见操作。
3. session 安全切换及持久化完成后写 `session_committed`，记录新 generation。此时会话目标目录的 provenance 是 `explicit`，直到 group CAS 成功；这样群提交失败时不会被后续 auto-follow 覆盖。
4. 以 journal 的 expected revision 做 group CAS。成功时在同一 group-store 锁/原子写中写 record 与 operation receipt；receipt 是群提交的权威证明。释放 group 锁后再将 journal 标记 `group_committed`，并把该 session provenance 收敛为 `group` + 新 revision；任一后续写入结果未知时，恢复均以 receipt + session generation 读回收敛，不重复 group CAS。
5. CAS 冲突写 `conflict` receipt；store 明确失败写 `store_unavailable` receipt（若底层提交结果不确定则 journal 为 `unknown`，不得伪造失败 receipt）。两者都保留已切换会话为 `explicit`，明确提示“会话已切换，群目录未更新”及当前群值/修复方式，不自动重基。
6. `unknown` 恢复先在锁内按 operation key 读 receipt 和 group record：有 receipt 即收敛；无 receipt 且 record 精确证明该 operation 已提交时补 receipt；否则保持 unknown、拒绝再次切 session 或覆盖群值，提示管理员重试新的事件或检查状态。

“群目录更新成功”的最终回复只能在 `group_committed` receipt 可读回后发送。现有 session-switch 成功文案必须延迟/改为中间结果，不能在 group CAS 前让用户误认整体成功。若进程在提交后、回复前退出，重放直接使用 receipt 发相同终态回复，不重启 worker、不增加 revision。`/repo unbind` 没有 session 阶段，但也先 journal、CAS 后 receipt，再发送成功。

### 路径可用性与 TOCTOU

set 写入前以及每次消费（新会话、`/th`、恢复、auto-follow、worker spawn 前）均以 daemon 的实际 uid/gid 执行：规范化绝对路径、`stat` 确认为目录，并通过独立 fd 或受控子进程实际 `chdir`/打开目录探测搜索权限。只 `stat` 成功不算可用。不要求目录可写。

校验与 worker 启动之间仍有 TOCTOU：worker 必须以目标 cwd 启动并回报实际 cwd/ready，任一 chdir、挂载、权限或 realpath 变化失败都终止本 turn，不能回退到 `~`、Bot 默认目录或 picker。绑定记录保留，管理员用新的顶层 `/repo` 修复或 `/repo unbind` 解除。

### 运行中会话、provenance 与安全跟随

群更新不强切正在执行的会话。所有 cwd mutation 入口必须原子更新 `{workingDir, workingDirSource, groupWorkspaceRevision}`：

- 顶层 group 解析/成功收敛：`source='group'` 并记录 revision；
- `/repo`、`/cd`、worktree、人工 IPC repin 等显式操作：`source='explicit'`，清除 group revision；
- 显式 oncall：`source='oncall-explicit'`；自动 defaultOncall：`source='oncall-default-auto'`；Bot 默认：`source='bot-default'`；
- resume/recovery/session restore 必须恢复已持久化来源，不得仅恢复 path；跨进程 IPC 必须传递并校验 source/revision；
- 历史无 provenance 的 session 标为 `legacy-unknown`，即使路径恰好等于群目录也不猜为 group，不自动跟随。

其他 Bot 的既有 chat-scope session 仅在 `source='group'`、revision 落后且进入**下一业务 turn 之前**跟随。安全切换契约是：保持 turn admission/FIFO 锁，确认 idle 且非 busy/streaming/needs_user；真实 suspend 当前 CLI（若适配器要求）、kill 并等待旧 worker/PTY 退出，持久化新 cwd/provenance/generation，重新 spawn worker，以目标 cwd 到达 ready 并回报一致后，才把尚未投递的业务消息交给新 worker。任何一步失败都不投递该 turn，并给出一次可恢复提示；不得只 repin session 记录。

thread、`explicit`、两种 oncall、bot-default、legacy-unknown 都不自动跟随。remote/adopt 或不支持可靠 suspend/kill/restart/ready 确认的 backend fail closed，保持原 session 并阻止该业务 turn，不能假装已迁移。崩溃恢复根据 generation 和 journal 读回，确保最多一个 worker；旧 worker 未确认退出时不得启动新 worker。

## 非目标 / Non-goals

- 不跨宿主机同步或映射绝对路径。
- 不自动迁移、合并或删除现有 `oncallChats`；只给新自动绑定写来源，历史值保守兼容。
- 不改变 oncall 对话授权语义。
- 不让 `/repo wt` 自动成为群默认目录。
- 首个 PR 不要求 Dashboard 编辑界面。
- 不清理历史 worktree，不改变 worktree 生命周期。

## 验收标准 / Acceptance criteria

1. Bot A 顶层 `/repo X` 后，Bot B 新 chat session 和 `/th` 使用 X；daemon 重启后仍成立。
2. thread `/repo Y` 只影响该 thread；`/repo wt`、`/repo here` 不写群。
3. 显式 oncall Z 优先于 group X；defaultOncall 自动目录 Z 不遮蔽 X，但 oncall 授权不变；历史无来源 oncall 保守保持旧行为。
4. 同一真人在 A/B app 下不同 open_id 均归一到同租户 union_id，文本和卡片可管理；普通成员、Bot、租户不符、旧配置指纹快照、收紧名单均拒绝。窄 bypass 不放行任何其他命令/范围。
5. 文本 M1 的 canonical source ID 在不同接收 Bot、实时投递与历史恢复中都由同一 tenant/chat/original message tuple 得到；delivery event/attempt 变化不影响它。`M1 set X@r0 → M2 set Y@r1 → replay M1` 必须在重读 revision/重解析 target 前命中 M1，复用首次冻结的 X、r0 和 session generation，返回 M1 收据且 Y/r2 不变；payload digest 不含 expectedRevision。同 source 不同 semantic intent 拒绝；跨 Bot/重启同样成立。卡片则由原始请求/card + immutable action identity 区分 source。
6. `set → unbind → set → 旧 CAS` 中 revision 单调且旧 CAS 失败；unbind 重放幂等，ACL 在 tombstone 上保留。
7. 在 switch 前、session committed 后、group commit 结果未知、group committed 后回复前分别崩溃，恢复/重放不重复 switch/worker，不误报成功；CAS/ENOSPC/锁失败明确区分，最终回复只在 receipt 可证明后发出。
8. group→`/cd`/显式 IPC→群更新不自动跟随；restart/resume 保留 provenance；legacy unknown 不误跟随。
9. 支持的本地 PTY CLI 在安全边界确实 suspend/kill/restart，下一消息实际 cwd 为新目录且只有一个 worker；busy/FIFO/needs_user 延后；remote/adopt fail closed。
10. 目录存在但不可进入、校验后撤权/卸载、消费时失效均停止，不回退；`/repo show` 给出修复信息。
11. profile 重写 `bots.json` 不改变共享群状态；store 损坏/锁失败 fail closed。
12. 现有 thread `/repo`、pending repo card、mid-session switch、worktree、oncall 授权和 command router 无回归。

## 风险与 Gate / Risks and gates

- 这是跨进程持久状态语义变更，必须覆盖人工中途干预、两阶段半写入、长等待与并发重入，并按仓库规则做独立对抗复核和变异复验。
- operation journal、group record/receipt 与 session generation 的锁顺序必须固定，避免跨 store 死锁；不得持 group 文件锁等待 worker。
- store 损坏或结果未知必须 fail closed，不得当作无绑定或自动重试覆盖。
- Draft PR 可在规格和计划提交后创建；实现、自测、独立审查完成前不得合并或部署。
- 部署/重启由维护者另行授权，本 PR 不包含生产切换。

## AI Agent 执行指引 / Implementation guidance

优先新增聚焦的 group workspace store、operation journal 和纯策略模块，不把共享状态塞入 `bot-registry.ts` 或 `oncall-store.ts`。文本与卡片必须复用同一 saga；目录解析返回 discriminated result，失效/不可访问/store unavailable 不得折成 `undefined`。

关键调用链：

- `src/daemon.ts`：新会话、`/th`、turn admission、resume/recovery 与 worker 生命周期。
- `src/core/command-handler.ts`：`/repo`、`/cd`、show/unbind、成功响应边界。
- `src/im/lark/card-handler.ts`：repo card action 来源事件与窄权限入口。
- `src/im/lark/event-dispatcher.ts`：接收 Bot gate、defaultOncall 自动来源、真人身份解析。
- `src/core/session-cwd.ts` / session IPC：所有 cwd mutation 的 provenance。
- `src/services/bot-admin-unions-store.ts`：fresh config fingerprint 管理员 union snapshot。

测试先写失败行为，再做最小实现；至少运行定向 Vitest、build 和受影响命令/路由测试。PR 描述记录故障注入序列、影响面、回退方式和独立复核结果。
