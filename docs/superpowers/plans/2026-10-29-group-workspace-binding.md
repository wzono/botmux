# Group Workspace Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a host-local, cross-Bot group working-directory binding with stable cross-app authorization, durable two-phase `/repo` outcomes, monotonic history, and safe worker-level auto-follow.

**Architecture:** Separate group record/ACL/revision, historical operation receipts, and the session→group saga journal. Normalize humans to tenant-scoped union IDs using a fresh configuration-fingerprinted admin snapshot; route only authorized group `/repo` operations around the receiving Bot gate. Every cwd mutation carries provenance, and group auto-follow replaces the real worker before admitting the next business turn.

**Tech Stack:** TypeScript, Bun, Vitest, Botmux daemon/session store, Lark event/card handlers, atomic JSON storage and cross-process file locks.

---

## File map

- Create `src/services/group-workspace-store.ts`: monotonic record/tombstone, retained ACL, durable receipts, CAS, corruption fail-closed.
- Create `src/services/group-workspace-operation-store.ts`: durable session→group saga journal and recovery queries.
- Create `src/core/group-workspace-policy.ts`: precedence, stable actor authorization, narrow route eligibility, follow decisions.
- Create `src/core/path-usability.ts`: actual-identity stat + chdir/access probe used at write and consumption.
- Modify `src/services/bot-admin-unions-store.ts`: tenant-scoped identity snapshot freshness and config fingerprint contract.
- Modify `src/im/lark/event-dispatcher.ts`: stable actor extraction, narrow pre-gate dispatch, defaultOncall provenance.
- Modify `src/core/command-handler.ts`: text `/repo` saga, delayed success response, `/repo show`/`unbind`, `/cd` provenance.
- Modify `src/im/lark/card-handler.ts`: action-event identity/idempotency and the same saga.
- Modify `src/core/session-cwd.ts`, `src/services/session-store.ts`, `src/types.ts`: atomic cwd provenance and IPC/recovery schema.
- Modify `src/daemon.ts`: resolver, consumption probe, saga recovery, safe pre-turn worker replacement.
- Modify `src/i18n/zh.ts`, `src/i18n/en.ts`: conflict, partial, unknown, invalid path and follow results.
- Add focused behavior tests under `test/group-workspace-*.test.ts`; extend existing route/session suites where their real harness is required.

### Task 1: Stable cross-app actor and fresh administrator snapshot

**Files:**
- Modify: `src/services/bot-admin-unions-store.ts`
- Create: `src/core/group-workspace-policy.ts`
- Create: `test/group-workspace-identity-policy.test.ts`

- [ ] Write failing tests with two Bot configs whose app-scoped `ou_*` values map to one `{tenantKey, unionId}`. Assert `computeBotAdminUnions` deduplicates that human, `workspaceManagers` uses the same type, tenant mismatch/absent union rejects, and a snapshot whose `configFingerprint` differs from the current registered-Bot fingerprint is unusable until refreshed.
- [ ] Add negative cases for a removed administrator retained only in an old snapshot, an unresolved allowed-user entry, a Bot actor, and a non-empty `workspaceManagers` list that excludes an otherwise default administrator.
- [ ] Run `bunx vitest run test/group-workspace-identity-policy.test.ts`; expect failures at the missing stable identity/freshness API.
- [ ] Implement `TenantHumanId`, canonical equality by `(tenantKey, unionId)`, deterministic fingerprinting over every registered Bot’s identity-relevant configuration, and `loadFreshBotAdminUnionSnapshot`: reuse only an exact fingerprint match; otherwise recompute through each signing app; any inconclusive conversion makes group authorization unavailable rather than partially accepting a union.
- [ ] Implement pure `canManageGroupWorkspace({ actor, freshSnapshot, workspaceManagers })`; a non-empty manager list replaces the default union.
- [ ] Rerun the suite; mutate the fingerprint equality and tenant equality guards separately and confirm each mutation makes its negative test fail, then restore.
- [ ] Commit: `feat(workspace): 统一跨应用群管理员身份`.

### Task 2: Monotonic group state, retained ACL, and historical receipts

**Files:**
- Create: `src/services/group-workspace-store.ts`
- Create: `test/group-workspace-store.test.ts`

- [ ] Write failing tests for missing-file read, bound round-trip, canonical path, malformed store, interrupted atomic replacement, lock failure, and parallel writers.
- [ ] Add the concrete history sequence `M1:set X@r0 → M2:set Y@r1 → replay M1`; assert replay returns M1’s durable receipt, current directory remains Y, and revision remains 2. Repeat after store reload and from a second store instance sharing `dataDir`.
- [ ] Add `same sourceEventId + set + different payloadDigest`; assert protocol conflict and no mutation. For cards, use two distinct action event IDs with one `originMessageId`; assert they are independent operations.
- [ ] Add `set X@r0 → unbind@r1 → set Y@r2 → delayed set Z expected r1`; assert revisions are 1/2/3, delayed CAS conflicts with r3, unbind replay is idempotent, and revision never resets after tombstone/rebind.
- [ ] Configure `workspaceManagers=[U]`, unbind, reload, and assert tombstone still carries `[U]` and default administrator V still cannot set.
- [ ] Run `bunx vitest run test/group-workspace-store.test.ts`; expect missing module failure.
- [ ] Implement schema `{schemaVersion, records, receipts}`. Under one cross-process lock, validate the whole file, compare expected revision, write bound/tombstone plus a strictly incremented revision, preserve ACL unless a separately authorized ACL operation changes it, and atomically append the terminal receipt. Receipts are keyed by digest of source event, operation kind, and canonical payload; conflicting payload reuse is rejected.
- [ ] Return discriminated outcomes `committed | conflict | invalid_dir | unauthorized | store_unavailable | protocol_conflict`; expose no API that deletes a record/revision on unbind.
- [ ] Rerun; invert the revision guard and remove receipt lookup in isolated mutations, confirming the delayed-CAS and M1 replay tests fail, then restore.
- [ ] Commit: `feat(workspace): 持久化群目录版本与操作收据`.

### Task 3: Path usability probe at write and consumption

**Files:**
- Create: `src/core/path-usability.ts`
- Create: `test/group-workspace-path-usability.test.ts`
- Modify: `src/services/group-workspace-store.ts`

- [ ] Write failing tests for nonexistent path, regular file, traversable directory, directory that still passes `stat` but cannot be entered by the daemon identity, and a probe that succeeds at set then fails after permission removal/path replacement.
- [ ] Run `bunx vitest run test/group-workspace-path-usability.test.ts`; expect missing export.
- [ ] Implement normalization plus `stat` and an actual `chdir`/directory-open probe in an isolated controlled subprocess or fd-based helper running with daemon uid/gid. Restore cwd unconditionally; do not require write access. Return structured `missing | not_directory | inaccessible | changed | io_error`.
- [ ] Call the probe before store `set`; keep a separate consumption API so callers must re-probe before session creation, `/th`, recovery, auto-follow, and worker spawn.
- [ ] Rerun; replace the chdir probe with stat-only in a mutation and confirm the inaccessible-directory case fails, then restore.
- [ ] Commit: `feat(workspace): 严格校验群目录可进入性`.

### Task 4: Narrow receiving-Bot gate bypass for group `/repo`

**Files:**
- Modify: `src/im/lark/event-dispatcher.ts`
- Modify: `src/im/lark/card-handler.ts`
- Modify: `src/core/group-workspace-policy.ts`
- Create: `test/group-workspace-route-authorization.test.ts`

- [ ] Build a real route-harness test where U is administrator only through Bot A, sends top-level `/repo X` to Bot B using B’s `ou_*`, and maps to the same tenant union. Assert text reaches the group operation route despite B’s generic command gate. Add the equivalent repo-card action case.
- [ ] Assert the bypass does not admit U’s ordinary message, `/help`, `/cd`, thread `/repo X`, `/repo wt`, `/repo here`, a card from another chat, a stale/fabricated card, or a group `/repo` when stable identity/fresh snapshot is unavailable.
- [ ] Assert a user with group authority but without session-switch capability receives a clear denial and neither switch nor group write occurs; no fallback to an ordinary unauthorized repo switch.
- [ ] Run `bunx vitest run test/group-workspace-route-authorization.test.ts test/card-action-routes.test.ts test/command-router-oracle-diff.test.ts`; expect new route cases to fail.
- [ ] Add a pre-gate classifier that accepts only ordinary-group set/unbind text commands and matching original repo-card actions. Resolve the actor to `TenantHumanId`, load a fresh snapshot, authorize the exact chat, then dispatch through a dedicated group-workspace route. Leave all other traffic on existing gates.
- [ ] Rerun; broaden the classifier to accept one forbidden command in a mutation and confirm the negative test fails, then restore.
- [ ] Commit: `feat(repo): 收窄群目录管理命令授权入口`.

### Task 5: Durable session-to-group operation journal

**Files:**
- Create: `src/services/group-workspace-operation-store.ts`
- Create: `src/core/group-workspace-operation.ts`
- Create: `test/group-workspace-operation.test.ts`

- [ ] Write state-machine tests for legal transitions `prepared → session_committed → group_committed`, `session_committed → conflict/store_unavailable`, and any unresolved I/O → `unknown`; reject skipped or backward transitions.
- [ ] Before any fake session side effect, assert the durable journal contains operation key, actor, target, expected group revision, session id and expected generation.
- [ ] Inject crashes at four exact boundaries: after `prepared` before switch; after persisted session switch before journal advance; after group atomic commit before journal convergence; after terminal receipt before response. On recovery/replay assert session switch count, worker start count and group revision each remain one.
- [ ] Inject CAS conflict, definite ENOSPC/lock failure, and ambiguous atomic-write result. Assert conflict/definite failure retain the switched session as explicit and produce terminal receipts; ambiguous result stays unknown and first reads receipt/current record under lock instead of retrying CAS or session switch.
- [ ] Run `bunx vitest run test/group-workspace-operation.test.ts`; expect missing modules.
- [ ] Implement journal persistence and a coordinator that never holds the group file lock while waiting for a worker. Recovery reads journal + session generation/cwd + group receipt: prove not switched then switch once; prove switched then advance; terminal receipt converges immediately; irreducibly ambiguous remains unknown and blocks replay.
- [ ] Ensure the group record and terminal group receipt are one atomic group-store update. CAS conflict never rebases. A failed group phase leaves session provenance explicit and clears group revision.
- [ ] Rerun; mutate recovery to repeat session switch and confirm crash-boundary tests catch extra generation/worker, then restore.
- [ ] Commit: `feat(workspace): 增加选仓两阶段操作日志`.

### Task 6: Text and card `/repo` share the saga and response boundary

**Files:**
- Modify: `src/core/command-handler.ts`
- Modify: `src/im/lark/card-handler.ts`
- Modify: `src/im/lark/card-builder.ts`
- Modify: `src/i18n/zh.ts`, `src/i18n/en.ts`
- Create: `test/group-workspace-repo-entrypoints.test.ts`

- [ ] Add failing text/card parity tests for chat set, thread isolation, `/repo wt`, `/repo here`, stale revision, unauthorized actor, replay, source-event payload conflict, aborted session commit, and `/repo unbind` without a session phase.
- [ ] Capture emitted messages in `session committed → group pending`, conflict, store unavailable, unknown, committed, and `committed then crash before reply` sequences. Assert no “群目录更新成功” response appears until a readable `group_committed` receipt exists; replay after reply crash emits the receipt-derived success without switch/write.
- [ ] Assert card idempotency uses action event ID and records originating request/card ID only as audit correlation.
- [ ] Run `bunx vitest run test/group-workspace-repo-entrypoints.test.ts test/command-handler.test.ts test/card-handler-repo-select.test.ts`; expect failures.
- [ ] Route text and card through the Task 5 coordinator. Delay/replace existing early success messages. Implement show output for all provenance layers and group state/revision; implement unbind as journal→CAS tombstone+receipt→success.
- [ ] Rerun with `test/command-schema.test.ts test/command-router-oracle-diff.test.ts test/card-action-routes.test.ts`; expect PASS.
- [ ] Commit: `feat(repo): 统一群选仓持久操作与回执`.

### Task 7: defaultOncall provenance without authorization regression

**Files:**
- Modify: `src/im/lark/event-dispatcher.ts`
- Modify: `src/core/group-workspace-policy.ts`
- Modify: `src/services/session-store.ts`
- Create: `test/group-workspace-default-oncall.test.ts`

- [ ] Through the real dispatcher, configure group X and `defaultOncall.workingDir=Z`. Trigger `ensureDefaultOncallBound`; assert oncall authorization still succeeds but cwd resolution chooses X and records `oncall-default-auto` rather than `oncall-explicit`.
- [ ] Assert a manually configured oncall Z chooses Z over X. Load a historical oncall entry without provenance and assert conservative legacy behavior still chooses Z; do not auto-reclassify it.
- [ ] Run `bunx vitest run test/group-workspace-default-oncall.test.ts`; expect resolver/source failures.
- [ ] Persist provenance on newly auto-created defaultOncall entries. Make cwd resolution ignore that entry as an explicit layer while leaving the existing authorization lookup intact; treat missing legacy provenance as explicit for compatibility.
- [ ] Rerun relevant oncall tests plus the new suite; mutate resolver to let auto Z shadow X and confirm the real-entry regression test fails, then restore.
- [ ] Commit: `fix(workspace): 区分自动与显式值班目录`.

### Task 8: Complete cwd provenance across every mutation path

**Files:**
- Modify: `src/types.ts`
- Modify: `src/core/session-cwd.ts`
- Modify: `src/services/session-store.ts`
- Modify: `src/core/command-handler.ts`
- Modify: `src/daemon.ts`
- Create: `test/group-workspace-provenance.test.ts`

- [ ] Add table-driven tests for group resolver, `/repo`, `/cd`, worktree, explicit IPC repin, oncall explicit, defaultOncall auto, Bot default, resume, recovery and session-store reload. Assert each atomically writes the expected source and sets/clears `groupWorkspaceRevision`.
- [ ] Add `group X/r1 → /cd Y → group r2 → next turn`; assert Y remains explicit before and after restart. Repeat for explicit IPC. Assert resume/recovery preserves persisted source rather than deriving it from path equality.
- [ ] Load a legacy session with no provenance whose path equals group X; assert migration yields `legacy-unknown`, never `group`, and does not auto-follow.
- [ ] Run `bunx vitest run test/group-workspace-provenance.test.ts test/session-cwd.test.ts`; expect missing schema/source behavior.
- [ ] Replace path-only cwd mutation with one API requiring `{workingDir, source, groupWorkspaceRevision}`; update every enumerated caller and IPC payload. Validate impossible pairs (`group` without revision; non-group with revision). Migrate absent fields to `legacy-unknown`.
- [ ] Rerun; deliberately omit `/cd` source update in a mutation and confirm the group→cd test fails, then restore.
- [ ] Commit: `feat(workspace): 完整记录会话目录来源`.

### Task 9: Resolution and consumption fail closed

**Files:**
- Modify: `src/daemon.ts`
- Modify: `src/core/group-workspace-policy.ts`
- Create: `test/group-workspace-daemon-resolution.test.ts`

- [ ] Test `explicit > oncall-explicit > group > oncall-default-auto/bot-default > picker`, Bot B reading Bot A’s binding, `/th` without peer, tombstone fallback, and group-store corruption/lock failure.
- [ ] At each consumption point—new chat session, `/th`, resume/recovery, pre-spawn—make X pass initial validation then replace/revoke/unmount it. Assert the turn/session stops with a repair message and does not use home/default/picker.
- [ ] Make worker launch report a cwd different from requested X; assert readiness is rejected as TOCTOU failure.
- [ ] Run `bunx vitest run test/group-workspace-daemon-resolution.test.ts test/daemon-pinned-working-dir.test.ts test/inherit-peer.test.ts`; expect failures.
- [ ] Return a discriminated resolver result including invalid/inaccessible/store-unavailable. Re-probe immediately before spawn and require ready cwd confirmation; preserve invalid binding for administrator repair.
- [ ] Rerun and expect PASS.
- [ ] Commit: `feat(workspace): 新会话安全消费群级目录`.

### Task 10: Real worker replacement before auto-follow turn

**Files:**
- Modify: `src/daemon.ts`
- Modify: `src/core/session-cwd.ts`
- Create: `test/group-workspace-session-follow.test.ts`

- [ ] Build fake-clock/real worker-harness sequences for an idle group-sourced chat session at r1 receiving a business message after group r2. Assert order: acquire admission/FIFO → suspend → kill → await old exit → persist cwd/source/revision/new generation → spawn at X2 → ready cwd X2 → deliver message. Assert one old exit, one new worker and one message delivery.
- [ ] Run the same behavior for two different local PTY-family CLI adapters. Assert the business message observes X2, not only the session record.
- [ ] Add busy, streaming, FIFO-active and needs_user cases; assert no force switch and no message delivered until a later safe boundary. Add thread, explicit, both oncall sources, bot-default and legacy-unknown cases; assert no auto-follow.
- [ ] Inject suspend, kill timeout, persist, spawn, ready and cwd-mismatch failures. Assert the turn fails closed with one notice, never delivers to old/new worker ambiguously, and never starts a new worker before confirmed old exit.
- [ ] Add remote and adopt sessions; assert they fail closed and retain old state because reliable lifecycle replacement is unsupported.
- [ ] Simulate crash after old exit and after new spawn; recover by generation/journal and assert at most one worker before any business delivery.
- [ ] Run `bunx vitest run test/group-workspace-session-follow.test.ts test/session-cwd.test.ts test/daemon-rename-route.test.ts`; expect failures.
- [ ] Implement pre-turn follow using existing suspend/kill/spawn primitives and generation checks, not path-only repin. Emit the one-time notice only after confirmed migration or a fail-closed result.
- [ ] Rerun; mutate away `await old exit` and confirm the worker-count/order test fails, then restore.
- [ ] Commit: `feat(workspace): 安全重启会话跟随群目录`.

### Task 11: Cross-Bot restart integration and regression gates

**Files:**
- Create: `test/group-workspace-e2e.test.ts`
- Modify: `docs-site/docs/zh/slash-commands.md`
- Modify: `docs-site/docs/en/slash-commands.md`

- [ ] Add a two-Bot shared-dataDir sequence: A receives U through app A and commits X; restart stores/daemon harness; B sees U through app B and resolves `/th` to X. Include fresh fingerprint, manager override, inaccessible X, and profile rewrite negatives.
- [ ] Add one end-to-end crash matrix covering prepared, session committed, group unknown and reply pending; assert actual session cwd, group value/revision, journal/receipt phase, worker count and emitted terminal result after replay.
- [ ] Add end-to-end `M1→M2→M1`, `set→unbind→set→old CAS`, ACL-after-unbind, defaultOncall auto versus group, `/cd` provenance, and local-worker follow sequences.
- [ ] Run `bunx vitest run 'test/group-workspace-*.test.ts'`; expect PASS.
- [ ] Document host-local scope, precedence and defaultOncall distinction, tenant-union managers, show/unbind, receipt/replay behavior, invalid-path fail closed, thread/worktree isolation and safe follow.
- [ ] Run `bun run build`, `bunx vitest run test/command-schema.test.ts test/command-router-oracle-diff.test.ts test/card-action-routes.test.ts`, then `bun run test`; record exact baseline-only failures, if any.
- [ ] Commit: `docs(repo): 说明群级工作目录协议`.

### Task 12: Independent adversarial review and Draft PR evidence

- [ ] Freeze review to this design and execute real-component probes with controlled waits/fake clock for: administrator removed during prepared operation; session commit followed by group failure/unknown; delayed pre-unbind CAS; repeated tick/business arrival during worker replacement; permission loss between probe and spawn.
- [ ] For each probe record actual session cwd/source/generation, group record/revision/ACL, journal/receipt, worker PID/count and emitted response. A read-code-only conclusion is insufficient.
- [ ] Mutate each new identity, CAS, receipt, provenance, response-boundary, chdir and old-worker-exit guard; confirm its targeted test fails before restoring.
- [ ] Resolve every P0/P1 as fixed/wontfix/deferred with evidence. Update Draft PR sections `Summary`, `Evidence`, and `Merge Danger`, including two-way rollback and blast radius `会话路由`; do not name internal collaborators.
- [ ] Run `git diff --check`, confirm only intended files changed, push `topic/group-workspace-binding` to `fork`; do not merge, deploy, install dependencies or restart daemons.
