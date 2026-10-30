# Group Workspace Unified Admission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Botmux business turn execute only after one unified admission proves the current session, immutable workspace identity, authorization, worker generation, and backend effective context.

**Architecture:** Four foundational contracts are implemented before production adapters: Turn Admission, async Workspace Resolver/Consumption, Workspace Identity schema v2, and Workspace Authority. Production ingress adapters then converge before lease/attempting/send/fork; startup recovery converges sagas and follow journals before ingress opens. Current code at `85fa2fdd9` remains NO-GO until all tasks and R1–R3 gates pass.

**Tech Stack:** TypeScript, Bun 1.4.3, Vitest, SQLite session store, atomic JSON stores, Lark event/card handlers, PTY/Riff/Mojo backends.

---

## Review and execution rules

- Do not merge or deploy on task completion. New architecture review budget is R1–R3; R3 is terminal. Arbiter is the original requirement decision owner.
- Implement foundational contracts (Tasks 1–5) before production ingress/migration adapters (Tasks 6–10).
- Every code task is TDD: add the named failing behavior test, run the exact focused command and observe FAIL, implement, rerun and observe PASS, then commit.
- Never run `bun install` in this worktree. Use the existing dependency link.
- Coverage IDs and all 17 P1s are normative in `docs/superpowers/specs/2026-10-30-group-workspace-architecture-coverage.md`.

## File structure

**Create**

- `src/core/turn-admission.ts` — management/business classification, admission result and proof token, ordering before leases/sends.
- `src/core/workspace-resolver.ts` — async precedence and discriminated outcomes.
- `src/core/workspace-consumption.ts` — path/inode/backend proof and proof-token issuance.
- `src/core/workspace-authority.ts` — verified tenant/actor authorization and commit revalidation.
- `src/services/workspace-schema-migrator.ts` — v1→v2 scan/migrate/manifest/rollback export.
- Focused tests listed per task.

**Modify**

- `src/services/group-workspace-store.ts`, `src/services/group-workspace-operation-store.ts`, `src/services/session-store.ts`, `src/types.ts` — v2 codecs and migrations.
- `src/core/group-workspace-operation.ts`, `src/core/session-cwd.ts` — identity-bearing saga/follow and boot recovery.
- `src/services/bot-admin-unions-store.ts`, `src/core/group-workspace-route-runtime.ts`, Lark handlers — trusted authority.
- `src/daemon.ts`, `src/core/trigger-session.ts`, `src/core/session-manager.ts`, `src/core/command-handler.ts`, `src/core/worker-pool.ts` — adapters and enforced proof boundary.
- `src/worker.ts`, Riff/Mojo backends — output and effective-context proof.

### Task 1: Turn Admission contract and proof-enforced send boundary (P1-12, P1-16, P1-17)

**Files:**
- Create: `src/core/turn-admission.ts`
- Create: `test/group-workspace-turn-admission.test.ts`
- Modify: `src/core/worker-pool.ts`

- [ ] Add tests for `classifyTurn` with ordinary/listener/trigger/Dashboard opening/queue/principal/XPI/scheduler/recovery as `business`; show/unbind-without-CLI as `management`; terminal bytes and durable output as their explicit classes.
- [ ] Add an ordering harness whose trace must be `bot_gate → workspace_resolve → follow → consume → admitted → resource_lease → attempting → send`. Inject each resolver/follow/consume outcome and assert no later trace event occurs.
- [ ] Add compile/runtime tests that `sendWorkerInput`, business `forkWorker`, and queued-activation dispatch reject an absent, stale-generation, wrong-session, wrong-turn or wrong-identity `WorkspaceConsumptionProof`; allow an explicitly typed management-only blank spawn.
- [ ] Run `bunx vitest run test/group-workspace-turn-admission.test.ts`; expect missing module/signature failures.
- [ ] Implement `TurnKind`, `TurnAdmissionRequest`, `TurnAdmissionResult`, opaque proof branding, `classifyTurn`, `admitTurn`, and `admitTurnUnderMutation`. Bind proof to session id, turn id, worker generation, workspace identity and expiration at the next generation change.
- [ ] Change the central worker-pool business APIs to require and validate the proof; preserve later remote-retirement, XPI and dedupe fences.
- [ ] Rerun the focused test; expect PASS. Mutate the proof check and ordering guard separately; each targeted case must fail.
- [ ] Commit `feat(workspace): 建立统一业务回合准入契约`.

### Task 2: Async resolver and consumption outcomes (P1-11, P1-13)

**Files:**
- Create: `src/core/workspace-resolver.ts`
- Create: `src/core/workspace-consumption.ts`
- Create: `test/group-workspace-resolver-contract.test.ts`
- Modify: `src/core/group-workspace-policy.ts`
- Modify: `src/core/path-usability.ts`

- [ ] Add a table test for `explicit > oncall-explicit > group > oncall-default-auto/bot-default > picker`, including legacy oncall as explicit and legacy session as `legacy-unknown`.
- [ ] Add discriminated cases `resolved`, `needs_picker`, `unbound`, `store_unavailable`, `invalid_dir`, `inaccessible`, `identity_changed`; assert only `unbound` may advance to lower precedence and all error outcomes prohibit fallback.
- [ ] Add consumption tests that probe under daemon uid/gid, compare canonical path plus string `dev/ino`, and revalidate at session commit, spawn, ready and backend submit.
- [ ] Run `bunx vitest run test/group-workspace-resolver-contract.test.ts test/group-workspace-path-usability.test.ts`; expect missing APIs.
- [ ] Implement async `resolveWorkspace` and `consumeWorkspace`; make `path-usability` return canonical `WorkspaceIdentity` and use `path.isAbsolute` for platform correctness.
- [ ] Remove the overloaded synchronous resolver from the shared contract; adapters are migrated in Tasks 8–9, so keep a temporary internal compatibility wrapper that cannot collapse error outcomes.
- [ ] Rerun focused suites; mutate `store_unavailable` into `unbound` and verify the test fails.
- [ ] Commit `feat(workspace): 统一异步目录解析与消费结果`.

### Task 3: Workspace Identity schema v2 codecs (P1-06, P1-14; P2-04, P2-06)

**Files:**
- Modify: `src/types.ts`
- Modify: `src/services/group-workspace-store.ts`
- Modify: `src/services/group-workspace-operation-store.ts`
- Modify: `src/services/session-store.ts`
- Modify: `src/core/session-cwd.ts`
- Create: `test/group-workspace-schema-v2.test.ts`

- [ ] Add codec tests requiring identity on v2 bound records, committed set receipts, set journals, group session rows and follow journals; unbind carries no fake `/` identity.
- [ ] Add impossible-pair tests: group source without revision/identity; non-group with group identity; path equal but dev/ino different; unsafe JSON numeric inode; unsupported future version.
- [ ] Add follow phase tests where persist throws after next state construction. Assert the live object and durable row remain old; same-process retry performs the omitted step exactly once.
- [ ] Run `bunx vitest run test/group-workspace-schema-v2.test.ts test/group-workspace-provenance.test.ts test/group-workspace-session-follow.test.ts`; expect v2 failures.
- [ ] Define `WorkspaceIdentity`, `workspaceSchemaVersion`, v2 registry/journal/follow codecs, one provenance normalizer and immutable `nextJournal` transitions with row CAS.
- [ ] Keep v1 readers read-only and discriminated for Task 6 migration; unknown future versions return unavailable without rewrite.
- [ ] Rerun and mutation-test persist-before-publish and identity equality.
- [ ] Commit `feat(workspace): 冻结目录实体并升级持久模型`.

### Task 4: Verified Workspace Authority (P1-02, P1-03, P1-04, P1-08, P1-09)

**Files:**
- Create: `src/core/workspace-authority.ts`
- Modify: `src/services/bot-admin-unions-store.ts`
- Modify: `src/core/group-workspace-route-runtime.ts`
- Create: `test/group-workspace-authority-v2.test.ts`

- [ ] Add two-app/two-tenant fixtures where each app tenant comes from its own verified source. Assert equal union strings across tenants never merge and request tenant cannot relabel candidates.
- [ ] Add authentic Lark card callback fixture using verified callback header/app mapping and no synthetic `data.tenant_key`; assert text/card produce the same `TenantHumanId`.
- [ ] Add config-race tests that change allowed users during conversion, before publish, before session switch and before CAS. Assert stale proof is discarded and removed actor receives `unauthorized`.
- [ ] Add classifier tests: unrelated route=`not_applicable`; recognized top-level group operation with missing/stale/unauthorized identity=`recognized_denied`; only authorized result reaches saga. Assert denial never enters legacy `/repo`.
- [ ] Run `bunx vitest run test/group-workspace-authority-v2.test.ts test/group-workspace-route-authorization.test.ts`; expect failures.
- [ ] Implement verified app-tenant records, live config fingerprint supplier, `authorizeWorkspaceOperation`, `revalidateWorkspaceCommit`, and three-state route result.
- [ ] Rerun; invert tenant/fingerprint/recognized-denial guards one at a time and confirm red tests.
- [ ] Commit `fix(workspace): 核验跨应用租户与提交权限`.

### Task 5: Same-source winner adoption and identity-bearing saga (P1-07, P1-10, P1-14; P2-01)

**Files:**
- Modify: `src/services/group-workspace-operation-store.ts`
- Modify: `src/core/group-workspace-operation.ts`
- Modify: `src/services/group-workspace-store.ts`
- Create: `test/group-workspace-operation-v2.test.ts`

- [ ] Add barrier-controlled concurrent first-delivery test: both miss, resolve different transient generation/revision values, one prepares; loser with same source/kind/request-intent adopts exact winner target/revision/generation/identity and joins one terminal receipt. Assert one switch, worker and group revision.
- [ ] Add changed semantic intent and opposite kind cases; assert protocol conflict without adoption.
- [ ] Replace path inode between prepared, switch, spawn, ready and CAS in separate tests. Assert identity_changed, no old-operation re-resolution, no group success.
- [ ] Add in-place `DaemonSession` update test proving switch by durable session id/owner/generation/cwd/identity, not object inequality.
- [ ] Add outcome parity for `unauthorized`, `invalid_dir`, `store_unavailable`, `conflict`, `unknown`.
- [ ] Run `bunx vitest run test/group-workspace-operation-v2.test.ts test/group-workspace-operation.test.ts`; expect failures.
- [ ] Implement `prepareOrAdopt`, keyed single-flight, frozen `WorkspaceIdentity`, durable session proof and commit-time authority/identity validation. Keep group lock free while awaiting worker.
- [ ] Rerun; remove adoption and durable proof guards in isolated mutations and confirm red.
- [ ] Commit `fix(workspace): 收敛同源并发与目录实体事务`.

### Task 6: Schema migration, rollback, and startup convergence (P1-05, P1-06, P1-14)

**Files:**
- Create: `src/services/workspace-schema-migrator.ts`
- Create: `test/group-workspace-migration.test.ts`
- Modify: `src/core/group-workspace-operation.ts`
- Modify: `src/core/session-cwd.ts`
- Modify: `src/daemon.ts`

- [ ] Create fixtures for group store, operation journal/receipt, follow journal and SQLite session rows in v1, v2, malformed and future-version forms.
- [ ] Test v1 bound record probe→v2, terminal receipt exact adoption, unresolved set without identity quarantine, prepared follow safe upgrade, post-retirement follow quarantine, and provable/unprovable group session migration.
- [ ] Test interrupted temp write/rename/SQLite transaction: original bytes remain; `.v1.rollback` and manifest hash are preserved; rerun is idempotent.
- [ ] Test forward rollback: a v1 reader refuses v2 and does not rewrite; explicit downgrade export writes a separate compatibility file and leaves v2/journals/receipts/session snapshot untouched.
- [ ] Add boot test without event redelivery: migrate → restore sessions → recover unresolved plus `group_committed` pending convergence → recover follow → prove worker cardinality → drive durable queues → open ingress.
- [ ] Run `bunx vitest run test/group-workspace-migration.test.ts test/group-workspace-follow-real-worker.integration.test.ts`; expect failures.
- [ ] Implement scan manifest, atomic migrator, quarantine records, rollback exporter, `listRecoverable`, saga/follow recovery and daemon startup barrier in the tested order.
- [ ] Rerun; inject failure at each publish boundary and expect PASS with preserved originals.
- [ ] Commit `feat(workspace): 迁移并恢复群目录持久状态`.

### Task 7: `/repo` text/card saga adapters and response boundary (P1-04, P1-07, P1-14)

**Files:**
- Modify: `src/daemon.ts`
- Modify: `src/core/command-handler.ts`
- Modify: `src/im/lark/card-handler.ts`
- Modify: `src/im/lark/event-dispatcher.ts`
- Modify: `src/core/group-workspace-route-runtime.ts`
- Modify: `src/i18n/zh.ts`
- Modify: `src/i18n/en.ts`
- Create: `test/group-workspace-entrypoints-v2.test.ts`

- [ ] Add text/card parity tests for authorized set, recognized denial, revoke at each boundary, inode replacement, in-place switch success, conflict, unknown, replay and unbind.
- [ ] Assert no success response before readable committed receipt plus session provenance convergence; replay after reply crash emits receipt-derived terminal response without worker/CAS repeat.
- [ ] Run `bunx vitest run test/group-workspace-entrypoints-v2.test.ts test/group-workspace-repo-entrypoints.test.ts`; expect failures.
- [ ] Wire authority v2, saga v2 and discriminated outcomes; remove legacy fallthrough for recognized denial; derive show data from resolver outcomes.
- [ ] Rerun with `test/command-schema.test.ts test/command-router-oracle-diff.test.ts test/card-action-routes.test.ts`; expect PASS.
- [ ] Commit `fix(repo): 接入目录实体事务与终态回执`.

### Task 8: Ordinary, trigger, Dashboard, listener and scheduler adapters (P1-11, P1-12, P1-13; P2-07, P2-08)

**Files:**
- Modify: `src/daemon.ts`
- Modify: `src/core/trigger-session.ts`
- Modify: `src/core/session-manager.ts`
- Modify: `src/core/dashboard-ipc-server.ts`
- Modify: `src/core/scheduler.ts`
- Modify: `src/im/lark/event-dispatcher.ts`
- Create: `test/group-workspace-ingress-adapters.test.ts`

- [ ] Build one parameterized real adapter harness for ordinary new/existing, realtime listener, polled listener, trigger new/existing, Dashboard create/start/board/resume, scheduler tick/manual and failed-turn retry/fresh.
- [ ] For each row assert resolver parity, proof before lease/attempting/send/fork, no fallback on store/path/identity error, and no business delivery before successful follow.
- [ ] Add leading `@Bot /repo` parity and Dashboard show provenance cases.
- [ ] Run `bunx vitest run test/group-workspace-ingress-adapters.test.ts test/trigger-session-root-message.test.ts`; expect failures.
- [ ] Replace `trigger-session.resolveWorkingDir` and `resolveDashboardSpawnWorkingDir` with shared async adapters; route failed-turn recovery through `admitTurnUnderMutation`; listeners keep ordinary adapter origin.
- [ ] Rerun `bunx vitest run test/dashboard-managed-spawn.test.ts test/scheduler-authority-integration.test.ts test/scheduler-execution-context.test.ts test/scheduler.test.ts`; expect PASS.
- [ ] Commit `feat(workspace): 统一消息触发与面板目录准入`.

### Task 9: `/queue`, principal lane, XPI, terminal and continuation adapters (P1-16, P1-17; P2-02)

**Files:**
- Modify: `src/core/command-handler.ts`
- Modify: `src/daemon.ts`
- Modify: `src/core/xpi-shared-cwd-admission.ts`
- Modify: `src/core/worker-pool.ts`
- Modify: `src/worker.ts`
- Create: `test/group-workspace-durable-ingress.test.ts`

- [ ] Add `/queue` test at stale r1: deferred/failure leaves unaccepted; success follows then returns accepted and sends once.
- [ ] Add principal/XPI durable FIFO tests proving admission precedes head attempting and exact lease. On rejection, retain head, do not consume retry budget as dispatched, and retry only by bounded policy.
- [ ] Add continuation test: same logical turn can reuse proof only while generation/identity match; stale proof re-enters admission or quarantines ambiguous dispatch.
- [ ] Add terminal WS test: current group identity allows authorized bytes; stale revision/identity rejects bytes without treating each key as a new business turn. Assert `/durable-send` never invokes turn admission.
- [ ] Run `bunx vitest run test/group-workspace-durable-ingress.test.ts`; expect failures.
- [ ] Wire proof-aware queue, lane, XPI, continuation and terminal fences; add per-session+generation admission single-flight.
- [ ] Rerun `bunx vitest run test/principal-lane-live-acceptance.test.ts test/principal-lane-recovery.test.ts test/xpi-shared-cwd-admission.test.ts test/xpi-shared-cwd-daemon-callbacks.test.ts test/message-queue.test.ts test/terminal-write-frame.test.ts`; expect PASS.
- [ ] Commit `fix(workspace): 封闭持久队列与终端输入旁路`.

### Task 10: Riff/Mojo effective-context and output proof (P1-01, P1-15; P2-05)

**Files:**
- Modify: `src/worker.ts`
- Modify: `src/adapters/backend/riff-backend.ts`
- Modify: `src/adapters/backend/mojo-backend.ts`
- Modify: `src/adapters/backend/mojo-isolated-workspace.ts`
- Create: `test/group-workspace-remote-backend.test.ts`

- [ ] Add real backend harness assertions that group-bound Riff and Mojo always deliver progress/final/error through `onData` while cwd validation is enabled.
- [ ] For Riff, test primary repo derived from target identity, explicit repo override mismatch rejection, non-git target rejection, and proof attached to `createTask/followUp` input.
- [ ] For Mojo, test `mojo.cwd` override rejection for group provenance, isolation repository mapping proof, and cloud/provider-no-proof=`unsupported_backend`; prompt guidance alone must fail.
- [ ] Run `bunx vitest run test/group-workspace-remote-backend.test.ts test/riff-backend.test.ts test/mojo-backend.test.ts`; expect the new suite to fail at missing effective-context/output guarantees while existing suites retain their baseline.
- [ ] Separate output listener ownership from cwd guard; implement backend `effectiveWorkspaceProof()` and validate it at ready plus every business submit.
- [ ] Rerun; remove output binding/effective proof in mutations and confirm targeted failures.
- [ ] Commit `fix(workspace): 证明远程后端有效目录并恢复输出`.

### Task 11: Full migration and ingress E2E gates (all P1, AC-01–AC-12)

**Files:**
- Modify: `test/group-workspace-e2e.test.ts`
- Modify: `test/group-workspace-follow-real-worker.integration.test.ts`
- Create: `test/group-workspace-architecture-e2e.test.ts`
- Modify: `docs-site/docs/zh/slash-commands.md`
- Modify: `docs-site/docs/en/slash-commands.md`

- [ ] Add shared-dataDir, two-Bot, authentic identity E2E covering ordinary, `/th`, trigger, Dashboard, listener, scheduler, queue, principal and XPI with one group revision update.
- [ ] Restart at each saga/follow/migration phase without source redelivery; assert one worker, one business delivery, exact v2 identity and terminal receipt.
- [ ] Add backward/forward rollback matrix and verify original files/hashes remain; future schema fails closed.
- [ ] Add path permission/inode/unmount/store corruption/config revoke and same-source concurrency fault matrix.
- [ ] Run `bunx vitest run 'test/group-workspace-*.test.ts'`; expect all PASS and record counts.
- [ ] Run `bun run build`; expect PASS.
- [ ] Run `bunx vitest run test/command-schema.test.ts test/command-router-oracle-diff.test.ts test/card-action-routes.test.ts test/test-hygiene.test.ts`; expect PASS.
- [ ] Run `bun run test`; record exact baseline-only failures. Do not label a retry-only pass stable; eliminate the prompt-ready flake or document it as blocking.
- [ ] Update user docs with host-local scope, unified admission, fail-closed outcomes, v2 migration/rollback and unsupported remote proof behavior.
- [ ] Commit `test(workspace): 覆盖统一准入迁移与恢复矩阵`.

### Task 12: Self-review, independent adversarial review, and R1–R3 evidence

- [ ] Cross-reference every AC row and P1-01…P1-17 to at least one passing behavior test; no source-text assertions except repository-approved structural K-gates.
- [ ] Run adversarial probes for config removal mid-refresh/after prepared, two simultaneous first deliveries, crash at every saga/follow/migration publish boundary, queue tick overlap, permission loss, Riff/Mojo output and effective-context mismatch.
- [ ] Mutate authority, admission ordering, proof token, winner adoption, identity compare, persist-before-publish, startup barrier, output listener and backend effective proof; each targeted suite must turn red.
- [ ] R1: full design/spec/coverage review. Resolve every blocker as fixed/wontfix/deferred with arbiter evidence.
- [ ] R2: only R1 blockers and touched boundaries. No new unrelated expansion.
- [ ] R3: terminal GO/NO-GO. Do not request R4.
- [ ] Run `git diff --check`, `git status --short`, and `git diff --name-only <implementation-base>...HEAD`; verify no generated dist, dependency or deployment files.
- [ ] Update Draft PR with neutral Summary/Evidence/Merge Danger, migration rollback and blast radius. Do not push, merge, deploy or restart unless separately authorized.

## Plan self-review result

- Spec coverage: AC-01–AC-12 and P1-01–P1-17 each map to tasks and matrix rows.
- Type consistency: `WorkspaceIdentity`, `WorkspaceConsumptionProof`, `AuthorityRouteResult`, `prepareOrAdopt` and v2 version names are stable across tasks.
- Completeness scan: every implementation step names its concrete behavior, file and command. Provider-controlled cwd remains explicitly `unknown`, with fail-closed behavior and a named verification task.
- Sequence: contracts → v2 persistence/authority/saga → migration/recovery → production adapters → remote backends → E2E/review.
