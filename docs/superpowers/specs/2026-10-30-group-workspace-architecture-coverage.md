# 群级工作目录统一准入：实现覆盖与独立复核提交矩阵

## 1. 冻结审查口径

- **提交基线**：最终实现范围为 `8ac153a3d9439750db9c6712aaa91f4109d7832c..HEAD`；本矩阵只陈述该范围内代码和可复现行为测试已经证明的结果。
- **目标**：同一宿主机内按 `chatId` 共享群工作目录；所有已迁移的离散业务 turn 在实际派发前证明冻结目录身份、群修订、worker generation 与派发许可；群目录管理操作使用可信 tenant/真人身份、提交前复验、持久 journal/receipt 与启动恢复。
- **本轮范围**：Tasks 1–11 的契约、authority/saga、host-wide migration、ordinary/trigger/listener/Dashboard/scheduler/recovery/queue/principal/XPI/terminal/continuation、Riff effective repository proof，以及中英文用户文档。
- **裁决范围**：Mojo/cloud 因缺少 provider 可验证的 host→execution 映射而明确 fail closed；原需求 owner 已移除新增 approval 产品 emitter/UI 与其端到端验收，通用 control-wait/Ask exact-turn 仍在范围内。
- **评审结论边界**：这是供最终 R3 的 submitter evidence，不是 merge 或部署批准。当前实现**未部署、未重启 daemon、未 push**。
- **审查轮次**：R1 已完成全量设计/覆盖复核；R2 仅复核 blocker 与直接触达边界并完成修复；本矩阵供 R3 给终态 GO/NO-GO，不开启 R4。冻结设计文档开头的 `NO-GO / DO NOT MERGE` 是 2026-10-29 实现前状态，保留作历史决策记录，不是本矩阵的最终 verdict。

## 2. 可复现证据（R2 closure HEAD）

### 2.1 本轮实际执行

```bash
/data00/home/zhongweijie.x/.bun/bin/bun x vitest run \
  test/admitted-turn-dispatch.test.ts \
  test/admitted-turn-driver-structure.test.ts \
  test/admitted-worker-workspace-identity.test.ts \
  test/ask-resume-startup-guards.test.ts \
  test/card-handler-repo-select.test.ts \
  test/daemon-ordinary-ingress-failure-notice.test.ts \
  test/daemon-rename-route.test.ts \
  test/dashboard-ipc.test.ts \
  test/event-dispatcher.test.ts \
  test/group-workspace-authority-v2.test.ts \
  test/group-workspace-daemon-resolution.test.ts \
  test/group-workspace-daemon-wiring.test.ts \
  test/group-workspace-e2e.test.ts \
  test/group-workspace-follow-real-worker.integration.test.ts \
  test/group-workspace-operation-v2.test.ts \
  test/group-workspace-operation.test.ts \
  test/group-workspace-provenance.test.ts \
  test/group-workspace-repo-entrypoints.test.ts \
  test/group-workspace-resolver-contract.test.ts \
  test/group-workspace-route-authorization.test.ts \
  test/group-workspace-schema-v2.test.ts \
  test/group-workspace-session-follow.test.ts \
  test/group-workspace-store.test.ts \
  test/group-workspace-turn-admission.test.ts \
  test/pin-streaming-card-recovery-wiring.test.ts \
  test/session-store-sqlite.test.ts \
  test/turn-permit-startup-order.test.ts
```

历史 R2 结果：**27 test files passed；1703 tests passed、3 skipped（1706 total）**。

最终增量证据（2026-11-04 最新树）：

- `test/group-workspace-*.test.ts`（排除单独运行的真实 PTY 文件）：**24 files / 400 tests passed**。
- `test/group-workspace-follow-real-worker.integration.test.ts`：低负载复验 **13/13 passed**；此前宿主 load >2000 时出现 timeout-only 失败，未用重试掩盖，低负载完整矩阵证明行为稳定。
- architecture/migration/docs/K3/command/card/hygiene + backend proof focused：**13 files / 297 tests passed**；Riff/Mojo/local proof latest focused：**5 files / 192 tests passed**。
- Task 9 晚发现 ACK/Ask/terminal/raw-input latest focused：**8 files / 100 tests passed**；后续 refined exact suite：**79/79 passed**。
- `bun run build`、TypeScript noEmit、`git diff --check`：PASS。
- `env -u NODE_OPTIONS bun run test` 在宿主 load 约 2100 时一次执行：**2019 files passed / 127 failed / 4 skipped；39111 tests passed / 592 failed / 109 skipped；2 uncaught errors**。失败广泛为进程/超时/截断 JSON 等环境敏感 baseline，不能标为全仓绿色，也不影响上述 focused gate 的客观通过。

### 2.2 Task 7 / Task 8 增量证据

- Task 7 terminal approved HEAD：`8933f67ec9f2d08b85a051efe360c90690e3cb86`；authority/saga 修复提交 `03fee3bf6`、`e545eb0d9`、`8933f67ec`，客观覆盖 repair ownership、fresh snapshot 与提交期租约。
- Task 8 生产证据以真实入口 suite 为准：trigger 全分支、Dashboard create/queued/board、scheduler existing/fresh、failed-turn retry/fresh、ordinary realtime/polled listener 共用 handler；已移除无生产 caller 的参数化 helper 与未消费的 listener-origin metadata。
- Task 8 focused run：**16 files / 1147 tests passed**（含 `decision-board-delivery`、`dashboard-create-session`、trigger、Dashboard managed spawn、scheduler 三组、failed-turn、turn admission/resolver/daemon/follow、ordinary failure notice、event dispatcher）；trigger 源码已无直接 business `sendWorkerInput`/`forkWorker`。
- `bun run build`：PASS；`git diff --check`：提交前复验。

### 2.3 基础实现提交锚点

| contract | first implementation | blocker-closing commits | focused evidence |
|---|---|---|---|
| typed turn admission / durable permits | `e4a5fca4a`, `27707e61b`, `64b247fe6` | `8153a31ca`, `7f6b74c5a`, `1bfa3ae3d`, `f4024d6a0`, `dcd64f119`, `3d0252289`, `f0a4d3860` | `group-workspace-turn-admission`, `admitted-turn-dispatch`, `turn-permit-startup-order` |
| async resolver / immutable identity / follow | `9bbca3f0a`, `6f278d2d1` | `6851ae860`, `362211ac5`, `7878443b2`, `5ed838df8`, `85cf4cfa9` | `group-workspace-resolver-contract`, `schema-v2`, `session-follow`, `admitted-worker-workspace-identity` |
| trusted authority / route consumption | `7a4c6eba3` | `89ac489c3`, `f0d029f4f`, `e58ff8f91`, `3d4ce1f7d`, `3237ad1cf` | `group-workspace-authority-v2`, `route-authorization`, `daemon-wiring`, `card-handler-repo-select` |
| winner adoption / fenced operation recovery | `ce08af3b9` | `133d1028d`, `35797d8f1`, `6de89f7ca`, `81ef84184`, `bf9812b0d`, `efda0ff3a`, `43e44bfd7`, `2b69ea5f4` | `group-workspace-operation-v2`, `group-workspace-operation`, `follow-real-worker.integration` |
| production caller subset / startup barrier | `a4d468559` | `66757d241`, `451a72cff`, `1956c455f`, `0b23e7d20`, `582ba46e2`, `247f417bd`, `bca401860`, `564fd8201`, `2b69ea5f4` | `admitted-turn-driver-structure`, `daemon-ordinary-ingress-failure-notice`, `ask-resume-startup-guards`, `turn-permit-startup-order` |

## 3. 原始问题与基础 blocker 实现 ledger

状态含义：`fixed` 表示当前最终 review 范围内已有代码与行为证据；`unsupported/fail-closed` 表示 provider 能力缺失但安全契约已验证；`wontfix/by-design` 只用于冻结设计明确接受的策略（principal FIFO bounded retry exhaustion 进入 terminal quarantine，需人工干预，不自动重放）。

| ID | disposition | fixed / remaining contract | commit / evidence |
|---|---|---|---|
| P1-01 | fixed（host output ownership） | Riff/Mojo 的 host cwd guard 不再拥有/切断 output listener；provider effective-context 仍见 P1-15 | `ef0e7f86e`; `group-workspace-daemon-resolution` 的 riff/mojo host-contract ready cases；provider proof 未覆盖 |
| P1-02 | fixed | 卡片 tenant 来自可信 callback app→tenant 映射，不读 synthetic `data.tenant_key` | `f0d029f4f`, `3237ad1cf`; `group-workspace-authority-v2`, `daemon-wiring`, `card-handler-repo-select` |
| P1-03 | fixed | 生产 registry 只纳入与请求 tenant 一致的逐 app signed-callback tenant；跨 tenant Bot 排除且 recognized denial 不落 legacy | `group-workspace-daemon-wiring` production two-tenant denial；`workspace-authority` registry |
| P1-04 | fixed | switch 前、group mutation 前及锁内 fresh authority 复验 | `e58ff8f91`, `3d4ce1f7d`, `3237ad1cf`; `group-workspace-operation` revoke cases |
| P1-05 | fixed（基础 operation/follow recovery） | startup 枚举 recoverable 与 committed-pending convergence，并在 ingress 前恢复 | `6de89f7ca`, `bca401860`, `43e44bfd7`, `2b69ea5f4`; `operation-v2`, `operation`, `turn-permit-startup-order` |
| P1-06 | fixed | follow journal revision CAS，persist-first 后才发布 live state | `6f278d2d1`, `362211ac5`; `group-workspace-session-follow` persistence/overlap/recovery cases |
| P1-07 | fixed | 实际 `/repo` 原地复用 DaemonSession 后，以 durable sessionId/owner/generation/cwd/WorkspaceIdentity 判成功，不依赖对象不等 | `group-workspace-operation` in-place replacement proof；生产 saga wrapper |
| P1-08 | fixed | snapshot/fingerprint 在授权及提交边界 fresh 比对 | `7a4c6eba3`, `3237ad1cf`; `group-workspace-authority-v2`, `group-workspace-e2e` |
| P1-09 | fixed | `recognized_denied` 消费 text/card 路由，不落 legacy | `89ac489c3`; `route-authorization`, `daemon-wiring` zero-fallback cases |
| P1-10 | fixed | 同 intent loser 采用 frozen winner；共享 lease epoch/fencing token 决定执行权 | `ce08af3b9`, `133d1028d`, `35797d8f1`; `operation-v2` 含 two-OS-process/expiry-steal/late effect |
| P1-11 | fixed（Task 8 host adapters） | trigger 与 Dashboard create 共用 async resolver；store/path/identity failure 原样 fail closed，不折成 absent/default | `group-workspace-ingress-adapters`、`trigger-session-root-message`、`resolver-contract`、`daemon-resolution` |
| P1-12 | fixed（Task 8 production ingress） | ordinary/listener/trigger/Dashboard/scheduler/failed-turn 实际 caller 在 permit 前 follow/identity；trigger wait/async/idempotent/new/existing 全分支无 payload 直送旁路 | focused 16 files/1147 pass；`trigger-session-root-message`、`decision-board-delivery`、`dashboard-create-session`、`failed-turn-recovery` |
| P1-13 | fixed（Dashboard resolver/provenance） | Dashboard create/start/board/resume 使用同一 resolver contract；list/detail row 显示 source/revision/identity provenance | `group-workspace-ingress-adapters` Dashboard rows；`dashboard-managed-spawn` regression |
| P1-14 | fixed（基础 identity chain） | `{path,dev,ino}` 贯穿；未终态 v1 set journal 在 execute/recover/advance/store mutate 全边界保持 `migration_blocked_identity_missing` quarantine，缺冻结 identity 不 resolve、switch、CAS 或建 receipt；终态历史保持迁移 | `dana-r2-closure-regressions` 三种真实 store replacement/recover/replay 零副作用；`group-workspace-operation-v2`, `group-workspace-store` |
| P1-15 | fixed / 明确 unsupported | Riff 以 native `config.repos {repoName,repoBranch}` 选择 provider checkout，follow-up 以 `parentTaskId` 保持血缘；ready 与每次 HTTP submit 前后复验 host dev/ino、repo、remote branch，pre-fetch 拒绝不 ACK。Mojo/cloud 无机械映射时 `unsupported_backend` fail closed | `group-workspace-remote-backend`, `riff-backend` receipt/JWT/same-repo inode barriers, `worker-riff-env.integration`, `worker-local-workspace-proof` |
| P1-16 | fixed | principal/XPI 在 permit 后 acquire/attempting；scheduler/failed-turn/queue/terminal/control reply 均进入 typed permit/fence；结构护栏禁止直调 send/fork | `admitted-turn-driver-structure`, `admitted-turn-dispatch`, `group-workspace-durable-ingress`, `retained-control-reply-lifecycle`, `worker-codex-effort-input`, `worker-codex-app-effort-fence`, `raw-input-followup-atomicity` |
| P1-17 | fixed | `/queue` 通过中央 admitted driver；拒绝/异常不留下已接收终态，派发 receipt 可恢复 | `64b247fe6`, `0b23e7d20`; `admitted-turn-driver-structure`, `admitted-turn-dispatch`, `turn-admission` |
| AR-01 | fixed | durable blank bootstrap → zero-payload fork → exact ready proof → durable business permit → ACK receipt；过期/失败须证明孤儿 generation 已退役才可重发 | `27707e61b`, `1bfa3ae3d`, `f4024d6a0`, `dcd64f119`, `3d0252289`; `turn-admission`, `admitted-turn-dispatch` |
| AR-02 | fixed（Ask path） | exact original turn/wait/generation/frozen identity/authority 的 control permit；worker ACK 后终态；拒绝、迟到 ACK、restart/ambiguous 有持久语义 | `1bfa3ae3d`, `582ba46e2`, `451a72cff`, `247f417bd`; `turn-admission`, `admitted-turn-dispatch`, `turn-permit-startup-order` |
| AR-03 | fixed（operation effects） | observer 只返回 observing/receipt；markUnauthorized 的 SQLite provenance effect 与 transition、markUnknown transition 都要求当前 lease/fence，租约被 steal 后不写 session/journal | `dana-r2-closure-regressions` fake-clock unauthorized/unknown takeover 两例；`group-workspace-operation` observer zero-mutation；`operation-v2` real two-process expiry/late-old-owner fence |
| AR-04 | fixed | host-wide manifest/epoch/fencing 覆盖 group JSON、operation JSON、session SQLite、admin snapshot；首个 publish 前可回滚，publish 后只向前恢复；downgrade export 不改 live v2 且原文件/hash 保持 | `workspace-schema-migrator`, `group-workspace-migration` phase/restart/two-daemon/export/hash matrix |
| AR-05 | fixed | legacy 与已知 group source 隔离；不可证明 identity 持久 quarantine，只有 fresh authorized repair 生成 superseding event 并解除；future schema 原样 fail closed | `group-workspace-migration`, `group-workspace-repair-production`, `group-workspace-schema-v2` |
| foundation R1-F1 | fixed | permit dispatch 的“提交成功”必须由下游 worker exact ACK/receipt 决定，不能以 IPC write 返回代替 | `8153a31ca`, `7f6b74c5a`, `451a72cff`; `turn-admission`, `admitted-turn-dispatch` |
| foundation R1-F2 | fixed | executor lease 不能只围栏 JSON；生产副作用与 journal/session/group write 都校验 token | `133d1028d`, `35797d8f1`; `operation-v2` late old-owner effect |
| foundation R1-F3 | fixed | startup 必须先恢复 operation/follow/permit，再按 bot 开 ingress；恢复失败保持关闭 | `bca401860`, `1956c455f`, `66757d241`; `turn-permit-startup-order`, `ask-resume-startup-guards` |
| foundation R1-F4 | fixed | trusted card tenant、完整 frozen authority/origin 与 lock 内复验 | `3237ad1cf`, `3d4ce1f7d`; authority/operation/card focused suites |
| foundation R2-F1 | fixed | cold-start ready 等待 exact generation/identity，deferred fork 不得提前提交；失败释放持久引用 | `564fd8201`, `3d0252289`, `f0a4d3860`; `admitted-turn-dispatch`, `turn-admission` |
| foundation R2-F2 | fixed | operation startup recovery 按 Bot/runtime registry 与执行租约分配，missing-session committed completion 与可修复 orphan 分流 | `43e44bfd7`, `2b69ea5f4`; `operation-v2` ownership/orphan/committed-pending cases |
| foundation R2-F3 | fixed | v1 operation/receipt identity 从各自历史 frozen target 迁移，不从当前 mutable path 猜测；非法状态 fail closed | `6de89f7ca`, `bf9812b0d`, `efda0ff3a`, `81ef84184`; `schema-v2`, `operation-v2` |

> R1/R2 基础 blocker 在仓库历史中没有独立的 `R1-*`/`R2-*` 原始编号；上面 F1… 是按实际 blocker-closing commit 与行为测试稳定分组，避免把提交序列伪装成不存在的 issue ID。

## 4. Full submitter coverage matrix

| acceptance item | affected behavior | required caller/callee nodes | original issue IDs | revised contract | verification evidence/result |
|---|---|---|---|---|---|
| AC-01 | Bot A set 后 Bot B new chat 与 `/th` 消费 X | ordinary handler → admitted initial dispatch → resolver → blank fork/ready/business submit；`/th` → shared resolver | P1-12,P1-14,AR-01 | two-phase typed permit + frozen identity | `group-workspace-e2e` “Bot B and /th”；`daemon-resolution`; `admitted-turn-dispatch`；**基础路径通过** |
| AC-01 | external trigger new/existing | trigger adapter → shared resolver → admitted dispatch | P1-11,P1-12 | errors fail closed；business input requires permit | `group-workspace-ingress-adapters` trigger new/existing + `trigger-session-root-message`；通过 |
| AC-01 | Dashboard create/start/board/resume | Dashboard IPC/session manager → shared resolver/follow/admission | P1-13 | 与 ordinary 相同 async resolver/admission；可见 banner 前 fail closed | `dashboard-create-session`, `decision-board-delivery`, Dashboard provenance；通过 |
| AC-01 | restart 后仍消费 X | startup barrier → operation/follow/permit recovery → per-bot ingress open | P1-05,AR-01 | recovery before ingress | `turn-permit-startup-order`, `operation-v2`, `session-follow`; `bca401860`,`43e44bfd7`,`2b69ea5f4`；**基础恢复通过** |
| AC-02 | thread `/repo` 隔离；wt/here 不写 group | route classifier → thread command path / group route runtime | P1-09 | 只有 ordinary-group set/unbind 进入 group saga | `group-workspace-route-authorization` accepts-only case；focused route/card suites 通过 |
| AC-03 | explicit/oncall/group/default precedence | resolver → selected source/provenance | P1-11,P1-13 | explicit > oncall-explicit > group > auto/default > picker；fault 不 fallback | `resolver-contract`, `daemon-resolution`, `group-workspace-ingress-adapters` real store/provenance；通过 |
| AC-04 | 跨 app 真人、per-app tenant | event/card → authority → admin union snapshot | P1-02,P1-03,P1-08 | verified app tenant + tenant-scoped union + fresh fingerprint | `authority-v2`, `route-authorization`, `daemon-wiring`; `7a4c6eba3`,`f0d029f4f`,`3237ad1cf`；通过 |
| AC-04 | prepared 后 revoke 与 recognized denial | operation coordinator → revalidate before switch/CAS/under lock；route runtime consumes denial | P1-04,P1-09 | no stale authorization/no legacy fallthrough | `group-workspace-operation` revoke cases；`route-authorization` visible denial/zero fallback；通过 |
| AC-05 | historical replay/frozen target/identity | operation store prepare/adopt → coordinator → receipt | P1-07,P1-14 | source intent freezes target/revision/generation/identity；replay does not reread mutable target | `group-workspace-operation` frozen/replay/readback cases；通过 |
| AC-05 | same-source concurrent executor | operation store → executor lease → fenced effects/writes | P1-10,AR-03 | winner journal adoption + one live fenced executor | `operation-v2` real shared store across two OS processes、expiry steal、late old effect；通过 |
| AC-06 | monotonic revision/tombstone/ACL | group store mutate/reconcile | — | v2 preserves revision/CAS/ACL | `group-workspace-e2e` set-unbind-set-old-CAS；`group-workspace-store`; 通过 |
| AC-07 | saga crash/readback/startup convergence | operation journal → exact receipt/readback → recovery → session provenance | P1-04,P1-05,P1-07,P1-14 | no success before durable exact receipt/convergence；ambiguous stays unknown | `group-workspace-operation` 全 crash/readback/recovery matrix；`follow-real-worker.integration` 13/13；通过 |
| AC-07 | follow persist/overlap/restart | follow journal CAS → retire/persist/spawn/ready | P1-06 | immutable next + persist-before-publish + revision CAS | `group-workspace-session-follow` persist throw, overlap, each-phase recovery；通过 |
| AC-08 | `/cd` explicit 不自动 follow；legacy source 隔离 | provenance codec → follow eligibility/repair | P1-06,P1-14,AR-05 | explicit remains explicit；known group source 持久 quarantine，fresh authorized repair 才解除 | `group-workspace-e2e` `/cd`；`group-workspace-migration` quarantine/authorized repair；`group-workspace-repair-production`；通过 |
| AC-09 | ordinary existing/new local PTY | ordinary driver → admitted dispatch → follow/consume → permit → submit | P1-06,P1-12,AR-01 | proof before business side effect | `admitted-turn-dispatch`; `session-follow` claude/codex；`group-workspace-e2e` retire/spawn/deliver；通过 |
| AC-09 | `/queue` | command handler → submitQueuedMessage → central admitted driver | P1-17 | accepted only through valid permit/receipt | `admitted-turn-driver-structure`; permit failure/retry tests；通过 |
| AC-09 | principal lane / XPI | durable driver → admitted dispatch → acquire/attempting → submit/unknown settle | P1-16 | lease/attempting after permit；pre-IPC retry 与 post-IPC unknown 分离 | `principal-lane-live-acceptance`, `xpi-shared-cwd-daemon-callbacks`, `daemon-ordinary-ingress-failure-notice`, K3 guard；real SQLite busy/recovery/terminal matrix通过 |
| AC-09 | scheduler / listener / failed-turn | caller → ordinary/mutation-owned recovery → submit | P1-16 | same permit boundary；realtime/polled listener both enter `dispatchHumanMessageViaHandlers` ordinary path；mutation path does not nest shared gate | `event-dispatcher` actual listener call chain、scheduler suites、`failed-turn-recovery`；Task 8 通过 |
| AC-09 | Ask exact-turn reply | Ask answer → control permit → worker submission → exact ACK receipt | AR-02 | resume original wait only；frozen workspace/generation/authority；single durable receipt | `turn-admission`, `admitted-turn-dispatch`, `turn-permit-startup-order`, structure guard；Ask 通过。原需求 owner 已裁决：仓库无 approval producer/emitter，新增 approval 产品入口及端到端验收从 Task 9 移除；通用 control-wait API 不计 approval 通过 |
| AC-09 | Riff/Mojo output and effective context | worker ready/backend submit → authoritative effective-context proof；output listener independent | P1-01,P1-15 | Riff exact repo/remote branch/provider selector + host inode double-check；无 provider identity则 fail closed | `group-workspace-remote-backend`, `riff-backend`, `worker-riff-env.integration`; progress/final/error 均经 `onData`；Mojo/cloud unsupported 行为通过 |
| AC-10 | path/store/inode failure no fallback | resolver → consume at commit/spawn/ready/backend submit | P1-11,P1-14,P1-15 | discriminated fault; exact `{path,dev,ino}` | `resolver-contract` all consume points/inode replacement；`daemon-resolution` corrupt/locked；`e2e` inaccessible；通过（host path） |
| AC-10 | terminal WS stale group fence | daemon current fence → worker init/update → three WS byte gates | P1-16 | stale group session rejects bytes, not a business turn | `group-workspace-durable-ingress`, `terminal-write-frame`；worker tmux/zellij/shared handlers share exact revision+identity fence |
| AC-10 | output delivery exclusion | durable-send handler | — | output_delivery never enters business admission | `group-workspace-durable-ingress` + `turn-admission` output-delivery classification；no business permit accepted by durable output path |
| AC-11 | profile rewrite independent | bot profile publisher vs group store | P1-03,P1-08 | independent persistent stores | `group-workspace-e2e` profile rewrite case；通过 |
| AC-11 | group/operation local v1→v2 | store locked migration → identity-bearing v2 | P1-05,P1-14 | retryable locked migration; future schema fail closed | `schema-v2`, `operation-v2`; `6de89f7ca`,`bf9812b0d`,`efda0ff3a`; **局部 store 通过** |
| AC-11 | host-wide migration batch/rollback/version compatibility | migration manifest → all JSON/SQLite/admin stores → epoch barrier | AR-04,AR-05 | one fenced epoch, per-store publish points, resume/rollback/export | `group-workspace-migration` prepared/staged/verified/publish/complete、two-daemon fence、hash-preserving export；`schema-v2` future schema；通过 |
| AC-12 | command/repo card/thread/worktree/oncall regression | routers/handlers/card runtime | P1-02,P1-09 | recognized group route consumes denial；其它 route 保持旧语义 | command schema/router oracle/card/hygiene **81/81 passed**；focused group/daemon suites通过；full suite 非绿结果按 §2.1 原样记录，不作全仓绿色声明 |
| AC-12 | every business submit caller | production drivers → `dispatchAdmittedBusinessTurn` → typed callee | P1-12,P1-16,P1-17,AR-01 | callee requires permit and durable dispatch receipt | architecture E2E + K3 guard + ordinary/listener/trigger/Dashboard/scheduler/recovery/queue/principal/XPI/continuation focused suites；Task 9 ACK/Ask/terminal/raw-input latest **100/100 passed**；通过 |
| AC-12 | every worker creation caller | caller → `forkWorkerBlank` | AR-01 | only blank permit can zero-payload fork | Task 8 ingress ordering matrix与 Dashboard/scheduler/trigger regressions通过；Task 9 后续 creation callers 仍独立审查 |
| AC-12 | external provider effective context | remote-runner/Riff/Mojo provider | P1-15 | Riff 用 provider native repo/branch selector + parent lineage；其它 provider 无机械 proof → reject，绝不由 host path 推断 | Riff valid create/follow/ready/each-submit与 inode/branch/origin mutation通过；Mojo/cloud/remote-runner no-proof 明确 `unsupported_backend`；安全契约通过 |

## 5. R1–R3 最终复核结论

1. **R1（全量设计/覆盖）**：Tasks 1–11 与 AC-01…AC-12、P1-01…P1-17、AR-01…AR-05 已逐行复核。阻塞项包括真实 ingress、host-wide migration、Riff receipt/TOCTOU、本地/远端 proof 分层、Ask retained ACK/duplicate/active-thread、terminal/raw writer fence；均以行为 RED→GREEN 修复。Approval 产品入口按原需求 owner 裁决移除，不虚报通过。
2. **R2（只复核 blocker 与触达边界）**：多轮独立 exact-diff 复核最终对 Task 10/11 返回 `NO BLOCKERS`；Task 9 最新树亦返回 `NO BLOCKERS` 后又纳入 retained stale-worker durable ACK、steerable direct send、serialization-tail lifetime 与 raw writer text fence 的晚发现修复。相关 latest suites 见 §2.1。
3. **变异复验**：authority fresh/lock 复验、typed admission ordering、winner/lease token、identity compare、persist-before-publish/startup barrier、output listener/effective proof、Riff fetch receipt与同 repo inode swap、Ask wrong digest/unrelated ACK/duplicate、terminal fence/lifetime/raw text 等守卫均先以缺失/反转状态咬红，再修复转绿。
4. **剩余限制**：Mojo/cloud provider 没有可验证 execution mapping，因此是显式 unsupported，不是未审；完整 `bun run test` 在高负载宿主仍非绿，精确结果已记录，不能据 focused tests 宣称全仓绿色。
5. **R3 建议：GO（合并前验证）**。功能/迁移/安全 blocker 已关闭，focused gates、build、真实 PTY 矩阵均通过；Merge Danger 是 host-wide migration 与统一 ingress 的宿主级 blast radius。合并/部署仍须常规 CI/full-suite 环境确认，且本轮没有 push、merge、deploy、restart。
