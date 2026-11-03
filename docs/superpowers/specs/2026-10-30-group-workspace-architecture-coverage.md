# 群级工作目录统一准入：实现覆盖与独立复核提交矩阵

## 1. 冻结审查口径

- **提交基线**：实现范围为 `09940cecc5ce403f694900b335d39dbd2aeffa61..HEAD`（R2 历史 blocker 修复起点 `2affe4c87a259f2115356ad1c102439853a762f2`）；本矩阵只陈述该范围内代码和测试已经证明的结果。
- **目标**：同一宿主机内按 `chatId` 共享群工作目录；所有已迁移的离散业务 turn 在实际派发前证明冻结目录身份、群修订、worker generation 与派发许可；群目录管理操作使用可信 tenant/真人身份、提交前复验、持久 journal/receipt 与启动恢复。
- **本轮范围**：Tasks 1–9 已提交/本次实现的基础契约、Task 7 authority/saga 收敛，以及 ordinary/trigger/listener/Dashboard/scheduler/failed-turn/durable queue/terminal/continuation ingress 适配证据。
- **本轮非目标 / 未声称完成**：Task 10 remote provider proof、Task 11 全量 suite 与用户文档；宿主机级 migration manifest/整批 rollback。下表中的 `unknown/leftover` 是未完成审查项，不是通过。
- **评审结论边界**：这是供独立实现复核的 submitter evidence，不是 GO、merge 或部署批准。当前实现**未部署、未重启 daemon、未 push**。
- **结果审查预算**：下一轮仅做有针对性的 R2（复核下列已修基础 blocker 及直接触达边界）；随后由原始需求决策 owner 在 R3 给终态 GO/NO-GO，不开启 R4，也不由提交者自行扩大或改写验收目标。

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

结果：**27 test files passed；1703 tests passed、3 skipped（1706 total）**。该数字只是 implementation-touched focused suites，不是 `bun run test`，也不证明 Tasks 7–11 或全仓 suite。

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

状态含义：`fixed` 只表示当前基础 review 范围内已有代码与行为证据；`deferred`/`unknown` 均不是通过；`wontfix` 只用于经冻结非目标明确排除的行为。本实现没有把任何 P1/AR 记为 wontfix。

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
| P1-15 | unknown / fail-closed | host contract 可校验；remote-runner 无 provider proof 时拒绝。Riff primary repo、Mojo isolation/cloud provider identity 尚未证明 | `ef0e7f86e`; `admitted-worker-workspace-identity`; Task 10/provider proof leftover |
| P1-16 | fixed（已迁移 drivers） | principal/XPI 在 permit 后 acquire/attempting；结构护栏禁止直调 send/fork | `64b247fe6`, `a4d468559`; `admitted-turn-driver-structure`, `admitted-turn-dispatch`; scheduler/failed-turn/terminal 仍见矩阵 leftover |
| P1-17 | fixed | `/queue` 通过中央 admitted driver；拒绝/异常不留下已接收终态，派发 receipt 可恢复 | `64b247fe6`, `0b23e7d20`; `admitted-turn-driver-structure`, `admitted-turn-dispatch`, `turn-admission` |
| AR-01 | fixed | durable blank bootstrap → zero-payload fork → exact ready proof → durable business permit → ACK receipt；过期/失败须证明孤儿 generation 已退役才可重发 | `27707e61b`, `1bfa3ae3d`, `f4024d6a0`, `dcd64f119`, `3d0252289`; `turn-admission`, `admitted-turn-dispatch` |
| AR-02 | fixed（Ask path） | exact original turn/wait/generation/frozen identity/authority 的 control permit；worker ACK 后终态；拒绝、迟到 ACK、restart/ambiguous 有持久语义 | `1bfa3ae3d`, `582ba46e2`, `451a72cff`, `247f417bd`; `turn-admission`, `admitted-turn-dispatch`, `turn-permit-startup-order` |
| AR-03 | fixed（operation effects） | observer 只返回 observing/receipt；markUnauthorized 的 SQLite provenance effect 与 transition、markUnknown transition 都要求当前 lease/fence，租约被 steal 后不写 session/journal | `dana-r2-closure-regressions` fake-clock unauthorized/unknown takeover 两例；`group-workspace-operation` observer zero-mutation；`operation-v2` real two-process expiry/late-old-owner fence |
| AR-04 | deferred | 当前只实现 touched store 的 durable v1→v2 migration/retry；**未实现**冻结设计要求的 host-wide manifest、全 store epoch/publish points、整批 rollback/export | `6de89f7ca`, `bf9812b0d`, `efda0ff3a` 仅为局部证据；Task 6 host-wide coordinator leftover |
| AR-05 | deferred | legacy 与已知 group source 已隔离，不会静默当普通 legacy 执行；但完整持久 `known_group_identity_unprovable` quarantine + authorized repair/superseding receipt 尚无端到端证明 | `85cf4cfa9`; `schema-v2`, `provenance`; Task 6 repair matrix leftover |
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
| AC-07 | saga crash/readback/startup convergence | operation journal → exact receipt/readback → recovery → session provenance | P1-04,P1-05,P1-07,P1-14 | no success before durable exact receipt/convergence；ambiguous stays unknown | `group-workspace-operation` crash/readback/recovery matrix；`follow-real-worker.integration`; 通过（基础 saga） |
| AC-07 | follow persist/overlap/restart | follow journal CAS → retire/persist/spawn/ready | P1-06 | immutable next + persist-before-publish + revision CAS | `group-workspace-session-follow` persist throw, overlap, each-phase recovery；通过 |
| AC-08 | `/cd` explicit 不自动 follow；legacy source 隔离 | provenance codec → follow eligibility | P1-06,P1-14,AR-05 | explicit remains explicit；known group source must not become executable legacy | `group-workspace-e2e` `/cd` case；`85cf4cfa9`；**基本隔离通过，完整 quarantine/repair deferred** |
| AC-09 | ordinary existing/new local PTY | ordinary driver → admitted dispatch → follow/consume → permit → submit | P1-06,P1-12,AR-01 | proof before business side effect | `admitted-turn-dispatch`; `session-follow` claude/codex；`group-workspace-e2e` retire/spawn/deliver；通过 |
| AC-09 | `/queue` | command handler → submitQueuedMessage → central admitted driver | P1-17 | accepted only through valid permit/receipt | `admitted-turn-driver-structure`; permit failure/retry tests；通过 |
| AC-09 | principal lane / XPI | durable driver → admitted dispatch → acquire/attempting → submit | P1-16 | lease/attempting after permit | `admitted-turn-driver-structure` production guard + `admitted-turn-dispatch` ordering；**当前 drivers 通过，Task 9 完整 durable fault matrix leftover** |
| AC-09 | scheduler / listener / failed-turn | caller → ordinary/mutation-owned recovery → submit | P1-16 | same permit boundary；realtime/polled listener both enter `dispatchHumanMessageViaHandlers` ordinary path；mutation path does not nest shared gate | `event-dispatcher` actual listener call chain、scheduler suites、`failed-turn-recovery`；Task 8 通过 |
| AC-09 | Ask exact-turn reply | Ask answer → control permit → worker submission → exact ACK receipt | AR-02 | resume original wait only；frozen workspace/generation/authority；single durable receipt | `turn-admission`, `admitted-turn-dispatch`, `turn-permit-startup-order`, structure guard；Ask 通过。原需求 owner 已裁决：仓库无 approval producer/emitter，新增 approval 产品入口及端到端验收从 Task 9 移除；通用 control-wait API 不计 approval 通过 |
| AC-09 | Riff/Mojo output and effective context | worker ready/backend submit → authoritative effective-context proof；output listener independent | P1-01,P1-15 | host contract可验证；无 provider identity则 fail closed | `ef0e7f86e`; `daemon-resolution` host ready；`admitted-worker-workspace-identity` remote fail-closed；**provider-level Riff/Mojo proof unknown/leftover** |
| AC-10 | path/store/inode failure no fallback | resolver → consume at commit/spawn/ready/backend submit | P1-11,P1-14,P1-15 | discriminated fault; exact `{path,dev,ino}` | `resolver-contract` all consume points/inode replacement；`daemon-resolution` corrupt/locked；`e2e` inaccessible；通过（host path） |
| AC-10 | terminal WS stale group fence | daemon current fence → worker init/update → three WS byte gates | P1-16 | stale group session rejects bytes, not a business turn | `group-workspace-durable-ingress`, `terminal-write-frame`；worker tmux/zellij/shared handlers share exact revision+identity fence |
| AC-10 | output delivery exclusion | durable-send handler | — | output_delivery never enters business admission | `group-workspace-durable-ingress` + `turn-admission` output-delivery classification；no business permit accepted by durable output path |
| AC-11 | profile rewrite independent | bot profile publisher vs group store | P1-03,P1-08 | independent persistent stores | `group-workspace-e2e` profile rewrite case；通过 |
| AC-11 | group/operation local v1→v2 | store locked migration → identity-bearing v2 | P1-05,P1-14 | retryable locked migration; future schema fail closed | `schema-v2`, `operation-v2`; `6de89f7ca`,`bf9812b0d`,`efda0ff3a`; **局部 store 通过** |
| AC-11 | host-wide migration batch/rollback/version compatibility | migration manifest → all JSON/SQLite/admin stores → epoch barrier | AR-04,AR-05 | one fenced epoch, per-store publish points, resume/rollback/export | **deferred/leftover Task 6**；仓库无 `workspace-schema-migrator.ts`/manifest 全矩阵，不能记 pass |
| AC-12 | command/repo card/thread/worktree/oncall regression | routers/handlers/card runtime | P1-02,P1-09 | recognized group route consumes denial；其它 route 保持旧语义 | touched focused suites 27 files/1703 pass，含 card/event/rename/dashboard regressions；**未运行 command oracle/full suite，不作全回归声明** |
| AC-12 | every business submit caller | production drivers → `dispatchAdmittedBusinessTurn` → typed callee | P1-12,P1-16,P1-17,AR-01 | callee requires permit and durable dispatch receipt | Task 8 ingress matrix + 既有 structure guard覆盖 ordinary/listener/trigger/Dashboard/scheduler/recovery；**Task 9 durable/terminal/continuation inventory 仍 leftover** |
| AC-12 | every worker creation caller | caller → `forkWorkerBlank` | AR-01 | only blank permit can zero-payload fork | Task 8 ingress ordering matrix与 Dashboard/scheduler/trigger regressions通过；Task 9 后续 creation callers 仍独立审查 |
| AC-12 | unknown external provider cwd | remote-runner/Riff/Mojo provider | P1-15 | proof unavailable → reject, never infer from host path | remote-runner/Riff no-host-proof negative test通过；provider proof仍 **unknown**，所以 group turn只能 fail closed |

## 5. 独立 reviewer 应重点复核的边界

1. R2 只复核：AR-01/02/03、P1-04/05/10/14/16/17，以及这些修复直接触达的 startup ordering、exact ACK、lease fencing、frozen identity；不得把未实现 Tasks 7+ 静默算作通过。
2. `admitted-turn-driver-structure` 是仓库允许的 K3 结构护栏；它只能证明列出的 production functions 没有直调 send/fork，不能替代尚未建立的 Dashboard/scheduler/failed-turn/terminal 行为测试。
3. 当前 v1→v2 是 group/operation 等 touched store 的局部迁移，不等于 AR-04 的 host-wide migration coordinator；R3 前若范围仍要求 AR-04/05，必须保持 NO-GO。
4. Riff/Mojo/remote-runner 的 host cwd testimony 不等于 provider effective repository identity。当前安全结果是 fail closed；没有 provider proof 时不能把 AC-09/10 的远端路径记为 pass。
5. 本轮 focused suite 没有运行 `bun run test`、Task 11 architecture E2E、command-router oracle 或 build；R3 不能从 1703 focused tests 推导全仓绿色。
