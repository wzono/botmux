# Fleet Capacity Feedback — Botmux Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild trusted turn feedback on current customized `dev`: authoritative TraeX detection, durable projections, fleet rollout policy, and an owner-scoped `capacity-wait.v3` consumer.

**Architecture:** `TurnFeedbackRuntime` owns durable state and projection; evidence adapters only normalize authoritative observations. `FleetCapacitySideband` validates signed v3 events from one app namespace and resolves them through persisted exact native bindings. A shared rollout store controls shadow/staged/default-on behavior while app × adapter latches isolate failures.

**Tech Stack:** TypeScript, Bun, Vitest, SessionStore, Lark reactions/cards, Dashboard React.

---

## File map

Create `capacity-wait-evidence.ts`, `turn-feedback-state.ts`, `turn-feedback-reconciler.ts`, `worker-capacity-wait.ts`, `capacity-live-card-scheduler.ts`, `capacity-wait-reminder.ts`, `capacity-wait-card.ts`, `capacity-sideband-{consumer,runtime,disable-store}.ts`, `capacity-rollout-store.ts`, and `capacity-wait-audit.ts` under `src/services` or `src/im/lark` as named below. Modify `src/types.ts`, `src/{worker,daemon}.ts`, `src/core/worker-pool.ts`, registry/config, Dashboard, Lark client/card builder, command status, and their tests.

Do not bring over the old runtime-effort adjustment UI or the seven-day external-witness PASS reporter; both are outside the approved scope.

### Task 1: Normalized evidence and turn reducer

**Files:**
- Create: `src/services/capacity-wait-evidence.ts`
- Create: `src/services/turn-feedback-state.ts`
- Test: `test/capacity-wait-evidence.test.ts`
- Test: `test/turn-feedback-state.test.ts`

- [ ] **Step 1: Write failing evidence tests**

Use this public shape:

```ts
export type CapacityWaitEvidence = {
  kind: 'waiting'; position?: number; observedAtMs: number;
  source: 'pty' | 'structured-event';
};
export function reduceCapacityWaitPhase(
  phase: CapacityWaitPhase | undefined,
  event: CapacityWaitEvent,
): CapacityWaitPhase | undefined;
```

Assert newer positions retain the first `startedAtMs`, an exact observation becomes stale at 60 seconds and hides position, exact delayed replay is ignored, clear is monotonic, and inputs are not mutated.

- [ ] **Step 2: Run RED**

Run: `bun run test -- test/capacity-wait-evidence.test.ts`
Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement the minimal evidence reducer**

Implement only `waiting | stale | cleared`; silence is not an event. A stale timer must carry the exact observation timestamp it was armed for.

- [ ] **Step 4: Write failing phase-priority tests**

```ts
export type TurnFeedbackPhase =
  | 'processing' | 'capacity_waiting' | 'capacity_stale'
  | 'needs_user' | 'completed' | 'failed';
export function reactionForPhase(phase: TurnFeedbackPhase): string;
export function reduceTurnFeedback(state: TurnFeedbackState, event: TurnFeedbackEvent): TurnFeedbackState;
```

Prove terminal absorbs later events; needs-user outranks capacity; `user_resumed` reveals retained capacity; explicit progress clears capacity; reactions map to GoGoGo/Coffee/THINKING/DONE/ERROR.

- [ ] **Step 5: Run RED, implement, and run GREEN**

```bash
bun run test -- test/turn-feedback-state.test.ts
# implement the pure reducer
bun run test -- test/capacity-wait-evidence.test.ts test/turn-feedback-state.test.ts
```

Expected: first run fails on the absent module; final run passes.

- [ ] **Step 6: Commit**

```bash
git add src/services/capacity-wait-evidence.ts src/services/turn-feedback-state.ts test/capacity-wait-evidence.test.ts test/turn-feedback-state.test.ts
git commit -m "feat(feedback): 建立可信回合状态机"
```

### Task 2: Persist exact turn feedback at admission

**Files:**
- Modify: `src/types.ts`
- Create: `src/services/turn-feedback-reconciler.ts`
- Modify: `src/daemon.ts`
- Test: `test/turn-feedback-reconciler.test.ts`
- Modify: `test/turn-reactions.test.ts`

- [ ] **Step 1: Write failing admission tests**

Define `PersistedTurnFeedback.version = 1` with exact `turnId`, Lark `messageId`, requester snapshot, phase/timestamps, optional capacity, attention tuple, reaction operation, reminder, v3 cursor, and native binding.

```ts
await noteTurnReceived(ds, 'om_trigger', undefined, undefined, 'turn-1');
expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.['turn-1'])
  .toMatchObject({ version: 1, turnId: 'turn-1', messageId: 'om_trigger', phase: 'processing' });
```

Cover card-on turns, doc comments, duplicate admission, type-ahead distinct turns, and restart.

- [ ] **Step 2: Run RED**

Run: `bun run test -- test/turn-feedback-reconciler.test.ts test/turn-reactions.test.ts`
Expected: new durable-row assertions fail while pre-feature reaction tests still pass.

- [ ] **Step 3: Implement the reconciler interface**

```ts
export interface TurnFeedbackTarget { session: Session; larkAppId: string }
export function createTurnFeedbackReconciler(deps: TurnFeedbackDeps) {
  return { admit, observeCapacity, observeAttention, terminal, disableCapacity, restore };
}
```

`noteTurnReceived` calls `admit` before optional card/reaction early returns. Persist first, reconcile side effects second.

- [ ] **Step 4: Run GREEN and commit**

```bash
bun run test -- test/turn-feedback-reconciler.test.ts test/turn-reactions.test.ts
git add src/types.ts src/services/turn-feedback-reconciler.ts src/daemon.ts test/turn-feedback-reconciler.test.ts test/turn-reactions.test.ts
git commit -m "feat(feedback): 持久化逐回合反馈归属"
```

### Task 3: Crash-recoverable phase reactions

**Files:**
- Modify: `src/types.ts`
- Modify: `src/daemon.ts`
- Modify: `src/im/lark/client.ts`
- Modify: `src/services/turn-feedback-reconciler.ts`
- Modify: `src/core/worker-pool.ts`
- Test: `test/turn-reactions.test.ts`
- Test: `test/turn-feedback-recovery.test.ts`
- Test: `test/turn-feedback-retention.test.ts`

- [ ] **Step 1: Write failing convergence tests**

Cover GoGoGo→Coffee→THINKING→Coffee→DONE, create ACK then persistence failure, duplicate own reactions, delete ambiguity, other-app/user reactions ignored, terminal startup repair, message gone, and disable cleanup. Exercise a typed own-list result:

```ts
type OwnReactionListResult =
  | { status: 'ok'; items: Array<{ id: string; type: string }> }
  | { status: 'gone' | 'ambiguous' | 'failed' };
```

Add retention tests before implementation:

- nonterminal rows are never pruned;
- terminal rows with `reactionReconcilePending`, a reaction operation, attention residue, capacity residue, an unclosed reminder, or a saved reaction not matching terminal policy are never pruned;
- only settled terminal rows are bounded to 7 days and the newest 512 rows;
- pruning 10,000 settled rows returns the exact retained set without mutating input.

- [ ] **Step 2: Run RED**

Run: `bun run test -- test/turn-reactions.test.ts test/turn-feedback-recovery.test.ts test/turn-feedback-retention.test.ts`
Expected: recovery cases fail before the operation journal exists.

- [ ] **Step 3: Implement minimal operation journal**

Persist immutable desired emoji/message/op ID before DELETE/CREATE. On ambiguous replay, list own reactions, adopt desired, then persist duplicate cleanup IDs before deleting.
Implement `pruneTurnFeedback` only after terminal and pending-obligation fields exist. Apply it inside the owned Session mutation on terminal/recovery cleanup; never prune unresolved or uncertain operations. This retention gate must pass before any candidate build or deployment.

- [ ] **Step 4: Run GREEN and commit**

```bash
bun run test -- test/turn-reactions.test.ts test/turn-feedback-recovery.test.ts test/turn-feedback-retention.test.ts
git add src/types.ts src/daemon.ts src/im/lark/client.ts src/services/turn-feedback-reconciler.ts src/core/worker-pool.ts test/turn-reactions.test.ts test/turn-feedback-recovery.test.ts test/turn-feedback-retention.test.ts
git commit -m "feat(feedback): 恢复一致的回合表情"
```

### Task 4: Authoritative TraeX viewport adapter

**Files:**
- Create: `src/services/worker-capacity-wait.ts`
- Modify: `src/worker.ts`
- Modify: `src/types.ts`
- Test: `test/worker-capacity-wait.test.ts`
- Test: `test/worker-capacity-wait.integration.test.ts`
- Create: `test/fixtures/capacity-wait/{traex-current,negative}.txt`

- [ ] **Step 1: Write failing geometry/identity tests**

```ts
export interface CapacityCaptureIdentity {
  sessionId: string; turnId: string; dispatchAttempt?: number; revision: number;
}
export function extractTraexLiveCapacityStatus(screen: string):
  { state: 'waiting'; position?: number } | null;
```

Positive: current queue glyph/footer adjacent to latest composer. Negative: quoted prose, tool output, old scrollback, queued-next-turn, wrong capture revision, non-TraeX, and silence.

- [ ] **Step 2: Run RED**

Run: `bun run test -- test/worker-capacity-wait.test.ts test/worker-capacity-wait.integration.test.ts`.

- [ ] **Step 3: Implement tracker and exact IPC**

Emit `capacity_wait` only when current/captured identity tuples match. Clear only on authoritative progress/composer return; silence never clears.

- [ ] **Step 4: Run GREEN and commit**

```bash
bun run test -- test/worker-capacity-wait.test.ts test/worker-capacity-wait.integration.test.ts
git add src/services/worker-capacity-wait.ts src/worker.ts src/types.ts test/worker-capacity-wait* test/fixtures/capacity-wait
git commit -m "feat(traex): 识别当前容量排队状态"
```

### Task 5: Dashboard, work-card, and reminder projection

**Files:**
- Modify: `src/core/dashboard-rows.ts`
- Modify: `src/dashboard/session-card-model.ts`
- Modify: `src/dashboard/web/{sessions-kanban.tsx,i18n.ts,style.css}`
- Create: `src/im/lark/capacity-wait-card.ts`
- Create: `src/services/capacity-live-card-scheduler.ts`
- Create: `src/services/capacity-wait-reminder.ts`
- Modify: `src/im/lark/{card-builder.ts,md-card.ts}`
- Test: `test/{dashboard-capacity-wait,session-card-model,capacity-wait-reminder}.test.ts`
- Modify: `test/turn-reactions.test.ts`

- [ ] **Step 1: Write failing projection tests**

Assert Dashboard exposes `waiting|stale|unsupported`, known position, and age. Work card has one `capacity_wait_status` element. Position-only updates are trailing-throttled 15 seconds; state edges render immediately.

- [ ] **Step 2: Write failing reminder tests**

Cover interactive 120 seconds, scheduled/workflow/HTTP 600 seconds, one create per episode, ambiguous create not blindly replayed, clear patches the same card, restart restores pending intent, and bot/silent requesters never receive reminders.

- [ ] **Step 3: Run RED**

```bash
bun run test -- test/dashboard-capacity-wait.test.ts test/session-card-model.test.ts test/capacity-wait-reminder.test.ts test/turn-reactions.test.ts
```

- [ ] **Step 4: Implement projections and timers**

Overlay capacity without replacing main process status. Timers hold only app/session/turn and reread SessionStore before side effects. Unsupported is capability state, never a waiting episode.

- [ ] **Step 5: Run GREEN and commit**

```bash
bun run test -- test/dashboard-capacity-wait.test.ts test/session-card-model.test.ts test/capacity-wait-reminder.test.ts test/turn-reactions.test.ts
git add src/core/dashboard-rows.ts src/dashboard src/im/lark src/services/capacity-live-card-scheduler.ts src/services/capacity-wait-reminder.ts test/dashboard-capacity-wait.test.ts test/session-card-model.test.ts test/capacity-wait-reminder.test.ts test/turn-reactions.test.ts
git commit -m "feat(capacity): 投影等待状态与提醒"
```

### Task 6: Define and verify capacity-wait.v3

**Files:**
- Create: `src/services/capacity-sideband-consumer.ts`
- Test: `test/capacity-sideband-consumer.test.ts`
- Create: `test/fixtures/capacity-sideband/v3-{waiting,clear,terminal}.json`

- [ ] **Step 1: Write failing schema/signature tests**

```ts
interface CapacitySidebandEventV3 {
  schema_version: 'capacity-wait.v3'; adapter: 'codex' | 'claude-code';
  owner_app_id: string; signer_key_id: string; signer_epoch: number;
  native_session_id?: string; native_turn_id: string; request_id: string;
  queue_id?: string; state: 'waiting' | 'clear' | 'terminal';
  position?: number; observed_at: string; sequence: number; signature: string;
}
```

Assert Ed25519 verification, owner mismatch, epoch ceiling, unknown fields, 16 KiB cap, forbidden content, clock skew, and v2 rejection.

- [ ] **Step 2: Run RED**

Run: `bun run test -- test/capacity-sideband-consumer.test.ts`.

- [ ] **Step 3: Implement pure verification, then GREEN**

Export `verifyCapacitySidebandEventV3(raw, keyring, nowMs)`; keyring entries have key ID and min/max epoch.

- [ ] **Step 4: Commit**

```bash
git add src/services/capacity-sideband-consumer.ts test/capacity-sideband-consumer.test.ts test/fixtures/capacity-sideband
git commit -m "feat(capacity): 定义 fleet 签名事件协议"
```

### Task 7: Bind native identities and consume one owner directory

**Files:**
- Create: `src/services/capacity-sideband-{runtime,disable-store}.ts`
- Modify: `src/services/capacity-sideband-consumer.ts`
- Modify: `src/services/{codex-bridge-queue,bridge-turn-queue,turn-feedback-reconciler}.ts`
- Modify: `src/{worker,types,daemon}.ts`
- Modify: `src/core/worker-pool.ts`
- Test: `test/capacity-sideband-{consumer,runtime}.test.ts`
- Modify: `test/worker-pool-native-input-receipt.test.ts`

- [ ] **Step 1: Write failing binding/filesystem tests**

Codex uses `sourceTurnId`; Claude uses `promptId + native session`; bindings include logical session/turn/attempt/generation. Test the validated owner directory `owners/cli_test/events`, independent checkpoints, claim recovery, pending, wrong-owner never claimed, replay/order/epoch, checkpoint rollback, symlink/mode/GID, quarantine, and PID-generation claims.

- [ ] **Step 2: Run RED**

```bash
bun run test -- test/capacity-sideband-consumer.test.ts test/capacity-sideband-runtime.test.ts test/worker-pool-native-input-receipt.test.ts
```

- [ ] **Step 3: Implement daemon-only consumer**

Workers publish only native-binding IPC and receive no sideband paths/keys. Poll after restore. Require exact persisted current binding before projection.

- [ ] **Step 4: Run GREEN and commit**

```bash
bun run test -- test/capacity-sideband-consumer.test.ts test/capacity-sideband-runtime.test.ts test/worker-pool-native-input-receipt.test.ts
git add src/services/capacity-sideband* src/services/codex-bridge-queue.ts src/services/bridge-turn-queue.ts src/services/turn-feedback-reconciler.ts src/worker.ts src/types.ts src/daemon.ts src/core/worker-pool.ts test/capacity-sideband* test/worker-pool-native-input-receipt.test.ts
git commit -m "feat(capacity): 按机器人消费签名事件"
```

### Task 8: Fleet rollout policy, status, and privacy ledger

**Files:**
- Create: `src/services/capacity-rollout-store.ts`
- Create: `src/services/capacity-wait-audit.ts`
- Create: `src/cli/capacity-command.ts`
- Modify: `src/cli.ts`
- Modify: `src/services/capacity-sideband-disable-store.ts`
- Modify: `src/{bot-registry.ts,types.ts}`
- Modify: `src/services/bot-config-store.ts`
- Modify: `src/core/{command-schema,command-handler,worker-pool}.ts`
- Modify: `src/i18n/{zh,en}.ts`
- Test: `test/{capacity-rollout-store,capacity-wait-audit,capacity-wait-config,command-handler}.test.ts`
- Test: `test/capacity-cli.test.ts`

- [ ] **Step 1: Write failing policy tests**

Phases are `shadow | traex | proxy | full | off`. Policy returns `enabled | shadow | unsupported | disabled` for app+adapter+capability. Persist under cross-process lock with atomic 0600 write. App × adapter latches survive global phase changes. CLI tests cover `botmux capacity status|phase|disable|enable --json`, strict app/adapter validation, and nonzero exits for malformed input.

- [ ] **Step 2: Write failing privacy tests**

Audit only opaque episode hash, adapter/version, enum, time, position-known, visibility channel/latency, signer key/epoch, and verdict. Assert prompts, output, raw prose, raw app/chat/session/turn/message IDs, paths, and credentials never serialize.

- [ ] **Step 3: Run RED**

```bash
bun run test -- test/capacity-rollout-store.test.ts test/capacity-wait-audit.test.ts test/capacity-wait-config.test.ts test/capacity-cli.test.ts test/command-handler.test.ts
```

- [ ] **Step 4: Implement stores and status**

Final `full` defaults supported adapters on; no pilot allowlist. Keep emoji/reminder tuning. IM `/capacity status` and host CLI `botmux capacity status --json` show phase, source support, latch, signer key/epoch without secrets/raw identifiers. Host CLI phase/disable/enable mutations call the same locked rollout and disable stores.

- [ ] **Step 5: Run GREEN and commit**

```bash
bun run test -- test/capacity-rollout-store.test.ts test/capacity-wait-audit.test.ts test/capacity-wait-config.test.ts test/capacity-cli.test.ts test/command-handler.test.ts
git add src/services/capacity-rollout-store.ts src/services/capacity-wait-audit.ts src/services/capacity-sideband-disable-store.ts src/cli/capacity-command.ts src/cli.ts src/bot-registry.ts src/types.ts src/services/bot-config-store.ts src/core/command-schema.ts src/core/command-handler.ts src/core/worker-pool.ts src/i18n test/capacity-rollout-store.test.ts test/capacity-wait-audit.test.ts test/capacity-wait-config.test.ts test/capacity-cli.test.ts test/command-handler.test.ts
git commit -m "feat(capacity): 增加 fleet 策略与证据"
```

### Task 9: Verify the Botmux topic

**Files:**
- Modify: `docs-site/docs/zh/slash-commands.md`
- Modify: `docs-site/docs/en/slash-commands.md`

- [ ] **Step 1: Run focused suites**

```bash
bun run test -- test/capacity-wait-evidence.test.ts test/turn-feedback-state.test.ts test/turn-feedback-reconciler.test.ts test/turn-feedback-recovery.test.ts test/turn-feedback-retention.test.ts test/worker-capacity-wait.test.ts test/worker-capacity-wait.integration.test.ts test/dashboard-capacity-wait.test.ts test/session-card-model.test.ts test/capacity-wait-reminder.test.ts test/capacity-sideband-consumer.test.ts test/capacity-sideband-runtime.test.ts test/capacity-rollout-store.test.ts test/capacity-wait-audit.test.ts test/capacity-cli.test.ts test/turn-reactions.test.ts test/worker-pool-native-input-receipt.test.ts test/command-handler.test.ts
```

Expected: all pass with zero unhandled errors.

- [ ] **Step 2: Typecheck/build/scope**

```bash
npx tsc -p tsconfig.json --noEmit
bun run build
git diff --check
git status --short
git diff --stat dev...HEAD
git log --oneline dev..HEAD
```

Expected: clean tree; only capacity feature/docs. No v2 release files, runtime-effort UI, unrelated history, or production config.

- [ ] **Step 3: Independent immutable-range review**

Record `BASE=$(git rev-parse dev)` and `HEAD=$(git rev-parse HEAD)`, then review the immutable `$BASE..$HEAD` range for spec and correctness/security. Fix blockers with new tests and re-run the focused suite/build before freezing a new head.
