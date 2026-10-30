# 群级工作目录绑定：统一准入架构修订

## 状态与审查边界

- 固定实现基线：`85fa2fdd9ed135967281b85138474bcc488e5275`。
- **当前代码仍为 NO-GO / DO NOT MERGE。** 本文是对已批准目标的重新设计，不是实现批准、合并批准或部署批准。
- 本轮只修订架构、迁移协议、计划和覆盖证据；不改实现或测试，不部署、不重启。
- 新方案审查预算固定为 R1–R3：R1 全面审查本文与覆盖矩阵；R2 只复核 R1 blocker 和其触达边界；R3 必须给终态 GO/NO-GO，不开启 R4。
- 分级、范围或取舍争议的 arbiter 是**原始需求的决策 owner**；reviewer 和实现者均不能自行改写目标。

## 冻结目标、范围与非目标

### 目标

在同一宿主机上提供跨 Bot、按 `chatId` 共享的群工作目录。群顶层 `/repo X` 更新它；Bot A/B 的新 chat session 与 `/th` 一致消费它；话题内 `/repo` 仍只影响话题；显式 oncall 覆盖仍优先；所有业务输入只能在已证明的有效工作目录与 worker generation 上执行。

### 范围

1. 统一所有离散业务 turn 的准入与实际派发边界。
2. 统一 daemon、external trigger、Dashboard、新建/恢复/启动的异步工作目录解析和消费。
3. 统一跨 app 真人身份、tenant 来源、授权和提交前复验。
4. 将目录实体 `{path, dev, ino}` 从 prepare 贯穿 switch、spawn、ready、CAS 与恢复。
5. 为 group store、operation journal/receipt、follow journal、session row 定义 schema v2 兼容和回滚。
6. 明确 saga/follow 启动恢复、同源并发 winner adoption、Riff/Mojo 有效执行上下文证明。

### 非目标

- 不跨宿主机同步或映射绝对路径。
- 不新增 Dashboard 群目录编辑 UI。
- 不自动迁移、合并或删除既有 `oncallChats`；历史无 provenance 仍保守视为显式。
- 不改变 oncall 对话授权语义、worktree 生命周期或 `/repo wt` 语义。
- 不把 Dashboard 终端逐字节输入伪装成离散业务 turn；它继续走终端写权限，但在 group-sourced session 落后或 follow 未收敛时必须拒绝写入。
- 不把输出投递 `/durable-send` 当成业务输入准入。

## 总体不变量

1. **先准入，后占位/租约/attempting/发送。** 任何业务输入在 Turn Admission 返回 `admitted` 前，不得取得业务 lease、把 durable head 标为 attempting、调用 `sendWorkerInput`/`forkWorker` 或 backend `writeBusinessInput`。
2. **一次解析，多点证明。** Resolver 产生的 `WorkspaceIdentity` 是本 turn/session 的冻结目标；消费点只复验，不自行重算或回退。
3. **故障不是“无绑定”。** group store、identity probe、authority 或 backend proof 不可用时 fail closed。
4. **目录身份而非路径字符串。** 相同 path 但 `{dev, ino}` 改变即不同目录。
5. **持久化先于内存发布。** journal/follow/session 的 next state 先 CAS 落盘，成功后才替换 live object。
6. **恢复先于 ingress。** 启动恢复完成前不开普通业务入口；不可证明的状态 quarantine，绝不猜测重放。

## A. Unified Turn Admission

### 契约

新增 `src/core/turn-admission.ts`，唯一公开入口：

```ts
type TurnKind = 'management' | 'business' | 'terminal_bytes' | 'output_delivery';
type TurnAdmissionResult =
  | { status: 'admitted'; session: DaemonSession; workspace: WorkspaceConsumptionProof }
  | { status: 'deferred'; reason: 'busy' | 'fifo_owned' | 'needs_user' | 'startup_recovery' }
  | { status: 'rejected'; reason: WorkspaceFailure | 'unsupported_backend' | 'stale_owner' };

async function admitTurn(request: TurnAdmissionRequest): Promise<TurnAdmissionResult>;
```

`admitTurn` 在既有 `withBotTurnAdmission`（或 failed-turn recovery 的更强 `withBotTurnMutation`）内部运行，并按固定顺序：

1. 分类 management/business；
2. 恢复或解析 session；
3. 调用 Workspace Resolver；
4. 若 group-sourced session 落后，持 admission/FIFO owner 执行 follow；
5. 复验 workspace identity 与 backend effective-context capability；
6. 返回 proof；调用方随后才可领取细粒度 principal/XPI lease、改变 durable head、send/fork。

### management 与 business 分类

- `management`：`/repo show`、授权失败回复、repo picker 展示、`/repo unbind` 的 group-only CAS、关闭/暂停/rename 等不向 CLI 提交用户业务内容的动作。它们不触发 follow，但修改 cwd/session/group 的动作仍走各自 mutation/saga gate。
- `business`：普通消息、listener 生成 prompt、external trigger、Dashboard create/start 的 opening prompt、Dashboard trigger/chat、`/queue` payload、principal-lane/XPI durable head、scheduler task、failed-turn retry/fresh、automatic continuation/recovery 中将再次送入 CLI 的内容。
- `terminal_bytes`：不是离散 turn；若 session 是 group source 且 revision/identity 未证明为 current，worker terminal WS 必须拒绝写入并要求先通过 resume/follow。
- `output_delivery`：model→Lark/Dashboard 输出，不进 admission。

### 生产 ingress 与旁路清单

| ingress | 当前链 | 修订适配点 | 业务发送前要求 |
|---|---|---|---|
| 普通 new topic | `dispatchHumanMessageViaHandlers → handleNewTopic → handleNewTopicAdmitted` | `handleNewTopicAdmitted` 在 session side effect 前调用 `admitTurn` | proof 后 `forkWorker` |
| thread/existing | `handleThreadReply → handleThreadReplyAdmitted` | 替换局部 follow 检查为 `admitTurn` | proof 后 queue/send/fork |
| realtime/polled listener | 最终汇入普通 handlers | 无独立 resolver；携带 origin adapter | 同普通消息 |
| external trigger | `triggerSessionTurn → triggerSessionTurnAdmitted` | trigger adapter 在 `beginAsyncTrigger`、lease、send/fork 前调用 | store error 禁止 fallback |
| Dashboard create/start/board/resume | IPC routes → `spawnDashboardSession`/`activateQueuedSession`/`resumeSession` | IPC gate 内调用 admission；create 先 async resolve 再注册 | proof 后 opening prompt/fork |
| `/queue` | `handleCommand → submitQueuedMessage` | 命令复用已持有 admission；submit 再要求 proof token | deferred/rejected 不返回 accepted |
| principal lane | live route → lane FIFO → `driveNextPrincipalLaneTurn` | materialization 可先做；head attempting/发送前 admission | 失败保留 durable head |
| XPI | `driveNextXpiSharedCwdTurn` | workspace admission 先于 exact XPI lease/attempting | 失败保留 queue/lease 未取 |
| scheduler | callback → `executeScheduledTask` | 现有 bot gate 内、session send/fork 前 admission | 目标 identity 不一致拒绝 |
| failed-turn recovery | `recoverFailedTurn`（mutation gate） | 使用 `admitTurnUnderMutation`，不嵌套 shared gate | receipt attempting 前完成 |
| ordinary continuation | worker-pool recovery send/fork | 已 admitted logical turn仅可重放同 proof；generation 变化则重新 admission | 禁止跨 generation 沿用 proof |
| startup saga/follow recovery | boot barrier | recovery 自身是 management；不得发送业务内容 | barrier 完成后开 ingress |
| terminal WS | proxy → worker `cp.write` | 加 `canAcceptTerminalBytes` fence | stale group session 拒绝 |
| durable output send | `/durable-send` | `output_delivery`，明确不适用 | 无业务 admission |

任何新增调用 `sendWorkerInput`、`forkWorker`、backend `writeBusinessInput` 或 durable head `attempting` 的生产节点，必须接受不可伪造、绑定 `{sessionId, workerGeneration, WorkspaceIdentity, turnId}` 的 `WorkspaceConsumptionProof`；结构测试只检查 API 依赖，行为测试证明拒绝绕过。

## B. Async Workspace Resolver / Consumption

新增 `src/core/workspace-resolver.ts` 与 `src/core/workspace-consumption.ts`：

```ts
type WorkspaceIdentity = { path: string; dev: string; ino: string };
type WorkspaceResolution =
  | { status: 'resolved'; source: WorkingDirSource; identity: WorkspaceIdentity; groupRevision?: number }
  | { status: 'needs_picker'; candidates: RepoCandidate[] }
  | { status: 'unbound' }
  | { status: 'store_unavailable'; detail: string }
  | { status: 'invalid_dir'; detail: string }
  | { status: 'inaccessible'; detail: string }
  | { status: 'identity_changed'; expected: WorkspaceIdentity; actual?: WorkspaceIdentity };

async function resolveWorkspace(input: WorkspaceResolveInput): Promise<WorkspaceResolution>;
async function consumeWorkspace(input: WorkspaceConsumeInput): Promise<WorkspaceConsumptionResult>;
```

优先级固定为：turn/session 显式 > `oncall-explicit` > group > `oncall-default-auto`/Bot default > picker。legacy oncall 无 provenance 按 explicit；`legacy-unknown` 不自动 follow。

Resolver 由 daemon ordinary、trigger、Dashboard create/start/resume、new `/th`、scheduler、restore/recovery 调用。`store_unavailable`、损坏、锁失败、path probe 失败均原样传播，禁止折成 `undefined` 或 fallback。Consumption 在 session commit、spawn 前、worker ready、每次 remote backend business submit 前复验同一 identity；ready proof 必须匹配冻结 identity。

路径 probe 使用 daemon 实际 uid/gid，要求绝对 canonical path、目录、可进入，并返回字符串化 `dev/ino`（避免 JSON number 精度差异）。probe 不要求写权限。

## C. Workspace Authority

新增 `src/core/workspace-authority.ts`，并收敛 `bot-admin-unions-store.ts`：

```ts
type AuthorityRouteResult =
  | { status: 'not_applicable' }
  | { status: 'recognized_denied'; reason: 'identity_unavailable' | 'stale_config' | 'unauthorized' | 'tenant_mismatch' }
  | { status: 'authorized'; actor: TenantHumanId; configFingerprint: string };

async function authorizeWorkspaceOperation(input: WorkspaceAuthorityInput): Promise<AuthorityRouteResult>;
async function revalidateWorkspaceCommit(proof: WorkspaceAuthorityProof): Promise<AuthorityCommitResult>;
```

- 每个注册 Bot 的 tenant 必须来自其签名 app 的可信 tenant 发现/缓存，记录 `{appId, tenantKey, verifiedAt, source}`；禁止用当前请求 tenant 给其他 Bot 贴标签。
- `TenantHumanId={tenantKey,unionId}`；`ou_*` 只在接收 app 内解析。
- 卡片 tenant 从经过签名验证的 callback header/app tenant 映射取得，不读取不存在的 synthetic `data.tenant_key`。
- fresh snapshot 计算后、发布前、首次授权前和 group CAS 提交前都重取 live config fingerprint；变化即丢弃并刷新/拒绝。
- 顶层 group `/repo` 已被识别但身份/授权失败时返回 `recognized_denied` 并消费事件；只有 `not_applicable` 可以进入 legacy route。
- prepared 后权限收紧必须在 session switch 前及 group CAS 前被发现；若 session 已切换而 commit 被拒，保持 explicit provenance，写 `unauthorized` receipt，不误报成功。

## D. Workspace Identity 与 schema v2

### v2 持久模型

- `group-workspaces.json` v2：bound record 与 committed set receipt 都要求 `workspaceIdentity`。
- `group-workspace-operations.json` v2：set journal 要求 `targetWorkspaceIdentity`；winner 冻结 path/dev/ino、expected revision/generation；unbind 明确无 identity，不再用 `/` 哨兵表达目录。
- session row：新增 `workspaceSchemaVersion: 2`；group source 必须有 `groupWorkspaceIdentity`；launch guard 与 proof 使用同一 identity。
- follow journal v2：新增 `schemaVersion:2`、target identity 和 journal revision；每次 phase CAS 使用 immutable next object。

identity 必须贯穿：target resolve/probe → prepared → session switch → session row → spawn opts → worker ready proof → group CAS/receipt → recovery。任一点不匹配均 fail closed，且不能重新解析成“当前 path 的新 inode”继续旧操作。

### 迁移、兼容与回滚

1. 启动时先只读扫描四类状态并写 migration manifest；未知未来版本 fail closed，不覆盖文件。
2. v1 group bound record：对 path 做一次 probe；成功后生成 v2 identity；失败则保留 v1 文件并 quarantine，管理员修复前不消费。
3. v1 set journal/receipt 只有 path：未终态操作不能安全补 identity，标记 `migration_blocked_identity_missing`，不重放 switch/CAS；已终态 receipt 可由当前 record identity补齐，但必须证明 revision/target/actor 一致。
4. v1 follow journal：若 phase 为 prepared 且旧 worker仍可证明未退出，可 probe 并升级；其它 phase 无 identity 则 quarantine，禁止 spawn。
5. legacy session：group source 且可由同 revision group record证明时补 identity；否则降为 `legacy-unknown` 并禁止自动 follow，不猜测。
6. 迁移以 sibling v2 temp + fsync + rename 发布；原 v1 文件保留为 `.v1.rollback`，migration manifest 记录 hash。SQLite session migration在事务内写 v2，导出只读 rollback snapshot。
7. forward rollback：旧 binary 看到 v2 必须 fail closed，不能重写；运维回滚代码时继续保留 v2、journal、receipt、session 数据，通过显式 migrator 生成 v1 兼容副本，绝不删除审计文件。

## Saga、follow 与启动恢复

启动 barrier 顺序：加载/迁移 schema → 恢复 session stores → 枚举所有 operation journal（包括 `group_committed` 但 session 未 convergence）→ 以 receipt/session generation/identity 收敛 → 恢复 follow journal → 证明最多一个 worker → 驱动 principal/XPI durable queues → 开启 ingress。

operation recovery 不依赖原事件重投。无法证明 switched/not-switched、committed/not-committed 或 worker owner 的 journal 进入 quarantine。group lock 期间不得等待 worker。

follow 每个 phase 使用 `next = structuredClone(current)`，CAS 持久化成功后才发布内存；旧 worker 未确认退出不得 spawn。`spawned` 恢复只在 pid/generation/identity proof 匹配时采用；否则先持久化 rebase generation，再 spawn 一次。

## 同 canonical source 并发

首次同源同 kind 同 semantic intent 的两个请求可并发解析，但只有 journal-lock winner 可冻结 target/revision/generation/identity。loser 在 lock 内按 request-intent digest 采用 winner journal，随后 single-flight join 同一 operation promise/receipt；不得因 winner 已推进 phase 返回 `protocol_conflict` 或 `unknown`。同 source 不同 intent/kind 仍 protocol conflict。

## Remote backend 有效上下文证明

- **Riff**：host path 不能等同 remote absolute cwd。proof 必须绑定由 `WorkspaceIdentity` 推导出的 primary repo identity（repo remote/name + exact branch/commit/worktree mapping）及实际提交给 `createTask/followUp` 的首个 repo；worker `onData` 始终接线。无法从 group target 唯一推导 repo，或显式 `riffRepoDirs` 覆盖 target 时拒绝 group business turn。
- **Mojo**：group provenance 禁止 `mojo.cwd` 覆盖 session target。host isolation 模式必须由 adapter 明确证明 repository context 被挂载/传给 agent 且与 target identity一致；仅 prompt 要求 `cd` 不算证明。cloud 模式若 provider 不返回可验证 repository identity，则对 group provenance返回 `unsupported_backend`。
- backend proof 在 ready 和每次 business submit 前复验；path 可访问性不是 effective-context proof。

## 验收标准（冻结）

AC-01 Bot A 顶层 `/repo X` 后，Bot B 新 chat、`/th`、trigger 和 Dashboard create 使用 X；重启后成立。

AC-02 thread `/repo Y` 仅影响 thread；`/repo wt`、`/repo here` 不写 group。

AC-03 显式 oncall > group > 自动 defaultOncall/Bot default；授权语义不变；历史 oncall 保守兼容。

AC-04 跨 app 真人身份、真实卡片 tenant、per-app tenant、fresh fingerprint 和 manager override 正确；recognized denial 不落 legacy route。

AC-05 文本/卡片 canonical source、历史重放、payload digest 和 frozen target/revision/generation/identity正确；同源并发采用 winner。

AC-06 set→unbind→set revision 单调、旧 CAS 失败、ACL 保留。

AC-07 四个 crash boundary、明确/未知写失败、startup recovery 与最终回复边界正确且不重复 switch/worker/CAS。

AC-08 group→`/cd`/IPC 后不跟随；restart/resume保留 provenance；legacy unknown 不误跟随。

AC-09 本地 PTY 安全 retire/spawn/ready；busy/FIFO/needs_user延后；Riff/Mojo 必须证明有效上下文，否则拒绝。

AC-10 不可进入、inode 替换、撤权/卸载、store failure 均停止且无 fallback；show 提供修复信息。

AC-11 profile rewrite 不影响 group store；v1→v2、未来版本、向后/向前回滚保留文件并 fail closed。

AC-12 现有 command router、repo card、worktree、oncall、thread、mid-session switch 无回归；所有生产 business ingress 均由统一 admission 覆盖。

详细的 17-P1 ledger、调用链与逐项验证见 `2026-10-30-group-workspace-architecture-coverage.md`。