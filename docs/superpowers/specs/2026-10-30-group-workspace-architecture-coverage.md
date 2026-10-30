# 群级工作目录架构覆盖与审查台账

## 使用规则

本文件固定在实现基线 `85fa2fdd9ed135967281b85138474bcc488e5275`。当前实现为 **NO-GO**；所有 P1 状态均为 `deferred-to-redesign`，表示已进入重设计任务，**不表示已修复或批准**。证据行号对应固定基线；实现变更后以函数名与行为测试重新定位。

审查预算：新架构 R1 全量；R2 仅复核 R1 blocker 及触达边界；R3 终态。arbiter 为原始需求决策 owner。

## 最终 17-P1 ledger

| ID | trigger | expected / actual | impact | evidence pointer | acceptance link | minimal architectural fix | planned task | status |
|---|---|---|---|---|---|---|---|---|
| P1-01 | group-bound Riff/Mojo worker 启动 | 期望 backend output 始终进入 Botmux；实际 cwd guard 分支与 normal `onData` 分支互斥后均未接 listener | 无 progress/final/error/ready 可见 | `src/worker.ts:24827-24834,25590-25595`; `RiffBackend.onData`; `MojoBackend.onData` | AC-09, AC-12 | backend proof 与 output ownership 解耦，始终接线且测真实输出 | T10 | deferred-to-redesign |
| P1-02 | 真实 repo-card callback | 期望从签名 envelope/app 得 tenant；实际读 synthetic `data.tenant_key` | selection 落 legacy，unbind 拒绝 | `src/im/lark/card-handler.ts:216-240,5439-5457`; `group-workspace-route-runtime.ts:69-73` | AC-04 | Workspace Authority 从 verified callback header/per-app tenant map 派生 | T4,T8 | deferred-to-redesign |
| P1-03 | 多 tenant host 上的请求 | 期望每个 Bot 自带 verified tenant；实际 `registeredBots(tenantKey)` 用请求 tenant 重标所有 Bot | 跨 tenant union 误授权 | `src/daemon.ts:32984-33000` | AC-04 | 持久 verified app→tenant source，仅同 tenant 参与并集 | T4 | deferred-to-redesign |
| P1-04 | prepared 后管理员被移除 | 期望 commit 前 fresh 复验拒绝；实际后续 mutation 复用 `authorized:true` | 已撤权 actor 仍切 session/写 group | `group-workspace-operation.ts:146-153,250,266`; probe: generation `7→8`, receipt committed | AC-04, AC-07 | authority proof 在 switch 前与 CAS 前按 live fingerprint 重验 | T4,T7 | deferred-to-redesign |
| P1-05 | crash 于 group_committed→session convergence 或 unresolved 且无重投 | 期望 boot 主动收敛；实际 `listUnresolved/recover` 无生产 startup caller且漏 committed-pending | session 留 explicit，后续不 follow | `group-workspace-operation.ts:405-416`; `group-workspace-operation-store.ts:302-314` | AC-07, AC-08 | startup saga sweep 包含 terminal pending convergence | T6 | deferred-to-redesign |
| P1-06 | follow phase persist 抛错 | 期望 persist-first immutable next state；实际直接 mutate live journal 后 persist | 内存/磁盘分叉，retry 跳步骤 | `session-cwd.ts:96-150`; `daemon.ts:6429-6436` | AC-07, AC-09 | journal revision CAS；落盘成功后发布 clone | T3,T6 | deferred-to-redesign |
| P1-07 | legacy `/repo` 成功原地更新同一 ds object | 期望 durable generation/cwd/owner 证明成功；实际要求 `current !== ds` | 成功被报 unknown | `src/daemon.ts:33053-33076` | AC-05, AC-07 | 用持久 session CAS/generation/identity proof，不用对象身份 | T7 | deferred-to-redesign |
| P1-08 | async admin refresh 时配置收紧 | 期望 publish/use 前比较 live fingerprint；实际只比较捕获旧配置 | detached old config 可授权 | `daemon.ts:32984-32991`; `bot-admin-unions-store.ts:166-177` | AC-04 | refresh 后与 commit 前重新取 live fingerprint | T4 | deferred-to-redesign |
| P1-09 | 顶层 group `/repo` 被识别但 identity/snapshot 失败 | 期望 consume recognized denial；实际等同 not applicable 后落 generic route | fail-closed 写可产生 legacy switch side effect | `group-workspace-route-runtime.ts:64-83`; `event-dispatcher.ts:5872-5894` | AC-04, AC-12 | `not_applicable` / `recognized_denied` discriminated result | T4,T8 | deferred-to-redesign |
| P1-10 | 两个相同 canonical source 首次并发 | 期望 loser采用 winner frozen journal；实际各自 resolve 后字段不同即 protocol conflict | 同一操作结果不对称/unknown | `group-workspace-operation.ts:316-341`; `group-workspace-operation-store.ts:220-239` | AC-05 | journal-lock winner + loser adoption + single-flight join | T5 | deferred-to-redesign |
| P1-11 | trigger 读 group store corrupt/locked | 期望 store_unavailable 拒绝；实际转换为 absent 后回 Bot default/config/`~` | 错目录执行外部事件 | `core/trigger-session.ts:239-260` | AC-01, AC-10, AC-12 | 共享 async resolver，错误不折叠不 fallback | T2,T8 | deferred-to-redesign |
| P1-12 | existing trigger session r1，group 已 r2 | 期望 send/fork 前 follow；实际直接 `forkWorker` | 旧 cwd 执行业务 turn | `core/trigger-session.ts:1714-1734` | AC-01, AC-09, AC-12 | external-trigger adapter 进入 Turn Admission | T1,T8 | deferred-to-redesign |
| P1-13 | Dashboard create 对有 group binding 的 chat | 期望完整 async precedence；实际同步 resolver 只看 oncall/Bot default | Dashboard session 错 cwd | `core/session-manager.ts:5329-5348` (`resolveDashboardSpawnWorkingDir`) | AC-01, AC-03, AC-12 | Dashboard create/start/resume 调共享 resolver/consumption | T2,T8 | deferred-to-redesign |
| P1-14 | resolve 后、switch/spawn 前 path inode 被换 | 期望 `{path,dev,ino}`贯穿；实际 prepared 只冻结 path | worker 在替换目录执行并可能提交成功 | `src/daemon.ts:33041-33076` | AC-05, AC-10, AC-11 | WorkspaceIdentity v2贯穿 saga/session/spawn/ready/CAS | T3,T5,T7 | deferred-to-redesign |
| P1-15 | group target X，但 `mojo.cwd=Y` 或 host isolation cwd | 期望 effective repository context=X；实际只证明 host target 可访问，执行可用 Y/isolation | cwd proof 虚假 | `mojo-backend.ts:604-647,1824-1826` | AC-09, AC-10 | 禁 override；isolation/cloud 返回可验证 repo proof，否则 unsupported | T10 | deferred-to-redesign |
| P1-16 | principal-lane/XPI durable FIFO head pending，group已更新 | 期望 follow 在 lease/attempting 前；实际 driver 先 attempting/send | durable turn 在旧 cwd 执行 | `daemon.ts:21172-21213,21899-21999` | AC-09, AC-12 | driver 调统一 admission，失败保留 head 且不取 lease | T1,T9 | deferred-to-redesign |
| P1-17 | `/queue task` 时 session落后 | 期望 admission/follow 后才 accepted；实际直接 `submitQueuedMessage` 可先返回 accepted | 用户认为已接收但 cwd 未迁移 | `command-handler.ts:1972-1995`; `daemon.ts:6284-6351` | AC-09, AC-12 | 复用外层 proof；submit API 强制 proof token | T1,T9 | deferred-to-redesign |

## P2 backlog

| ID | backlog | disposition |
|---|---|---|
| P2-01 | `unauthorized`/`invalid_dir` terminal outcome 被折成 `store_unavailable` | T7 保留 discriminated outcome；非 P1 gate，但随 saga 契约修正 |
| P2-02 | follow coordinator 无内部 single-flight，安全依赖调用者共享 admission lock | T1/T6 加 session+generation single-flight |
| P2-03 | real-worker ambiguous recovery isolated case 有一次 prompt-ready timeout flake | T11 用可控 readiness probe 与独立 timeout evidence |
| P2-04 | provenance normalization 在 `session-cwd.ts` 与 `session-store.ts` 重复且强度不同 | T3 收敛到 schema codec |
| P2-05 | remote/adopt fail-closed 只有 component test | T10 增 real backend contract test；provider 不可测项标 unknown |
| P2-06 | Windows follow path 用 `startsWith('/')` | T3 用 `path.isAbsolute` + platform fixtures |
| P2-07 | `/repo show` provenance 标签不完整/误导 | T8 从 resolver outcome 生成展示模型 |
| P2-08 | leading `@Bot /repo` 预处理与 dedicated route 不一致 | T8 统一 route classifier 输入 |

## Full coverage matrix

| acceptance item | affected behavior | required caller/callee nodes | original issue IDs | revised contract | verification evidence/result |
|---|---|---|---|---|---|
| AC-01 | 普通群 Bot A set 后 Bot B new chat 使用 X | `event-dispatcher.dispatchHumanMessageViaHandlers → daemon.handleNewTopic/handleNewTopicAdmitted → admitTurn → resolveWorkspace/consumeWorkspace → worker-pool.forkWorker` | P1-14 | A+B+D | planned `group-workspace-turn-admission-e2e`; current result NO-GO |
| AC-01 | `/th` 使用 X | `handleNewTopicAdmitted` topic-header path → resolver → create/session spawn | P1-14 | B+D | planned cross-Bot `/th` restart test; current partial v1 evidence |
| AC-01 | external trigger new/existing 使用 X | `dashboard/trigger-api.dispatchTriggerRequest → dashboard-ipc-server POST /api/trigger → triggerSessionTurn/triggerSessionTurnAdmitted → admitTurn` | P1-11,P1-12 | A+B | planned store-fault/new/existing trigger matrix; current NO-GO |
| AC-01 | Dashboard create/start/resume 使用 X | `dashboard.ts POST create → dashboard-ipc-server spawn/start/resume → spawnDashboardSession/activateQueuedSession/resumeSession → admitTurn` | P1-13 | A+B | planned Dashboard real IPC test; current NO-GO |
| AC-01 | daemon restart 后仍消费 X | `restoreSessionsAndScheduleStartupRecovery → saga/follow recovery → ingress barrier → admitTurn` | P1-05 | A+B+D | planned restart-without-redelivery test; current NO-GO |
| AC-02 | thread repo 隔离；wt/here 不写 group | `classifySlash/topic-header → command-handler → route-runtime` | P1-09 | C + management classification | existing route suites retained; revised denial parity planned |
| AC-03 | precedence 与 defaultOncall/oncall 授权分离 | `resolveWorkspace` called by ordinary/trigger/Dashboard/scheduler/resume | P1-11,P1-13 | B | table-driven adapter parity test planned |
| AC-04 | 跨 app text 真人 identity | `event-dispatcher → workspace-authority → bot-admin-unions-store` | P1-03,P1-08 | C | per-app verified tenant + config-race test planned |
| AC-04 | authentic card tenant/identity | `card-handler verified envelope → workspace-authority → route-runtime` | P1-02 | C | authentic callback fixture, no synthetic field planned |
| AC-04 | prepared 后 revoke + commit fresh check | `operation coordinator → revalidateWorkspaceCommit → group store mutate` | P1-04,P1-08 | C | controlled config change at both boundaries planned |
| AC-04 | recognized denial 不落 legacy | `route-runtime → event-dispatcher/card-handler` | P1-09 | C | `recognized_denied` consumes text/card planned |
| AC-05 | historical replay/frozen identity | `operation-store.prepare/adopt → coordinator → session switch → group store` | P1-07,P1-14 | D | M1/M2/replay with inode replacement planned |
| AC-05 | same-source concurrent winner adoption | `GroupWorkspaceOperationStore.prepareOrAdopt → coordinator single-flight` | P1-10 | D | barrier-controlled two-delivery test planned |
| AC-06 | monotonic revision/tombstone/ACL | `GroupWorkspaceStore.mutate/reconcileExactOperation` | — | D v2 preserves v1 semantics | existing store tests + v2 migration roundtrip planned |
| AC-07 | saga crash boundaries/boot convergence | `operation-store.listRecoverable → coordinator.recover → session convergence → boot barrier` | P1-04,P1-05,P1-06,P1-07,P1-14 | A+C+D | restart without source redelivery and fault matrix planned |
| AC-08 | explicit `/cd`/IPC 不跟随；legacy unknown | `session-cwd codec → session-store row → resolver/follow eligibility` | P1-06,P1-14 | B+D | session v1/v2 migration, resume and explicit-race tests planned |
| AC-09 | ordinary existing business turn safe follow | `handleThreadReplyAdmitted → admitTurn → runGroupWorkspaceSessionFollow → send/fork` | P1-06 | A+D | two local PTY families retained + persist-failure test planned |
| AC-09 | `/queue` | `command-handler.handleCommand → submitQueuedMessage(proof) → sendWorkerInput` | P1-17 | A | deferred/rejected must not accepted test planned |
| AC-09 | principal lane | `handlePrincipalLaneLiveMessage → handleThreadReply → driveNextPrincipalLaneTurn → admitTurn → lease/send` | P1-16 | A | durable head remains pending on follow failure planned |
| AC-09 | XPI | `enqueue/selectNext → driveNextXpiSharedCwdTurn → admitTurn → exact lease/send/fork` | P1-16 | A | no lease/attempting before proof planned |
| AC-09 | scheduler | `scheduler.tick/runTaskNow → daemon execute callback → executeScheduledTask → admitTurn → send/fork` | P1-16 (shared bypass class) | A+B | schedule existing/new group session test planned |
| AC-09 | listener realtime/backfill | `evaluateMessageListener.../poll → dispatchHumanMessageViaHandlers → ordinary adapter` | P1-16 (shared bypass class) | A | both origins reach same admission spy planned |
| AC-09 | failed-turn recovery | `dashboard-ipc-server → recoverFailedTurn → withBotTurnMutation → admitTurnUnderMutation → send/fork` | P1-05,P1-16 | A | stronger-gate no-deadlock and proof-before-receipt test planned |
| AC-09 | ordinary continuation/recovery | `ordinary-turn-recovery/worker-pool → proof generation check → send/fork` | P1-05 | A | stale generation proof rejected planned |
| AC-09 | Riff output/effective repo | `worker.spawnCli/flushPending → RiffBackend validated proof/createTask/followUp/onData` | P1-01 | A+B backend proof | actual output wiring + primary repo mismatch planned |
| AC-09 | Mojo override/isolation/cloud | `worker.flushPending → MojoBackend.realWorkingDir/resolveCwd/runTurn` | P1-01,P1-15 | A+B backend proof | override rejected; isolation proof; cloud unknown→unsupported planned |
| AC-10 | path access/inode/store failure no fallback | `resolveWorkspace → path probe → consumeWorkspace → spawn/ready/backend submit` | P1-11,P1-14,P1-15 | B+D | revoke/unmount/replace/store corrupt matrix planned |
| AC-10 | terminal WS stale group fence | `terminal-proxy → worker WS message → canAcceptTerminalBytes` | P1-16 (input bypass class) | A terminal_bytes rule | semantic scope confirmed; stale group bytes rejected planned |
| AC-10 | output delivery excluded | `dashboard-ipc-server durable-send → durableSessionSendHandler` | — | A output_delivery rule | contract test: no turn admission, no business input |
| AC-11 | profile rewrite independent | `bot config publisher` vs `group-workspaces.json` | P1-03,P1-08 | C+D | existing independence test + fingerprint refresh planned |
| AC-11 | group store v1→v2/backward rollback | group store migrator/read codec | P1-14 | D | byte-preserved `.v1.rollback`, hash manifest, v2 read test planned |
| AC-11 | operation receipt/journal v1→v2 | operation migrator/recovery | P1-05,P1-10,P1-14 | D | unresolved no-identity quarantine; terminal exact adoption planned |
| AC-11 | follow journal/session row v1→v2 | session-store migration + follow recovery | P1-06,P1-14 | D | transaction rollback, future-version fail-closed planned |
| AC-11 | forward rollback old binary behavior | v2 files + explicit downgrade exporter | P1-05,P1-14 | D | old reader refuses/refrains from rewrite; files retained planned |
| AC-12 | command router/repo card/thread/worktree/oncall regression | `command-router`, `command-handler`, `event-dispatcher`, `card-handler` | P1-02,P1-09 | A+C | existing oracle/schema/card suites + route parity planned |
| AC-12 | every `sendWorkerInput` production caller | daemon call sites incl ask, principal, XPI, approvals, normal; trigger/session-manager scheduler | P1-12,P1-16,P1-17 | A proof-token callee contract | compile-time/API negative tests + behavior per ingress planned |
| AC-12 | every `forkWorker` production caller | ordinary, trigger, Dashboard, scheduler, resume/recovery, principal/XPI | P1-12,P1-13,P1-16 | A proof-token or management-only spawn mode | caller inventory gate planned; unknown provider internals marked below |
| AC-12 | unknown external provider cwd semantics | Riff service remote pathname; Mojo cloud sandbox pathname | P1-15 | B backend effective-context proof | **unknown** until provider returns identity; design outcome is fail closed |

## Call-chain completeness notes

- `withBotTurnAdmission` remains the bot-wide concurrency primitive; it is not by itself workspace admission.
- principal-lane and XPI leases remain narrower resource gates and occur **after** workspace admission.
- failed-turn recovery retains `withBotTurnMutation`; it invokes a non-reentrant adapter rather than nesting a shared gate.
- Dashboard terminal bytes are covered by a stale-workspace fence, not modeled as one turn per keystroke.
- scheduler and realtime/polled listeners already converge toward known paths, but still receive explicit matrix rows to prevent future divergence.
- Riff remote absolute path and Mojo cloud sandbox path are outside this repository and remain unknown; the accepted behavior is rejection without proof, not inference.
