# Fleet Capacity Feedback — Botmux Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete trusted per-turn feedback on the customized Botmux `dev` line while preserving the existing terminal lifecycle: feedback and reaction intents are restart-recoverable only after one successful SessionStore commit.

**Architecture:** Keep the accepted pure reducer and exact-turn admission unchanged. A small reaction-provider adapter returns total typed receipts; a pure convergence planner decides LIST/DELETE/CREATE and writes immutable SessionStore intents before provider mutations; a separate pure retention module bounds only settled rows. The existing live `turn_terminal` handler performs one best-effort feedback mutation and then continues its historical lifecycle regardless of feedback failure—there is no worker outbox, terminal ACK protocol, suspend handshake, or Web Terminal fence.

**User-approved Ask boundary (2026-10-29):** `needs_user` projection requires a source-bound turn/attempt/worker generation. Shared-service and adopt hooks that cannot provide that identity still publish and resolve Ask cards, but capacity feedback remains unchanged and must fail closed. Do not synthesize the generation from the current Session or replacement worker.

**Tech Stack:** TypeScript, Bun, Vitest, SessionStore, Lark reactions/cards, Dashboard React.

---

## Scope guard

This plan replaces the rejected Task 3 from commit `418dcf172`. It must not add or retain:

- worker terminal outbox files or IPC acknowledgements;
- opaque terminal attempt references or terminal effect receipts;
- two-phase suspend, worker quiescence, or Web Terminal write fences;
- new terminal ownership for ordinary, queued, Codex, VC, readonly, or recovery paths;
- any promise that a terminal crash before the first SessionStore commit is recoverable.

The implementation begins with a normal revert commit so the rejected experiment stays visible in history. Commits `92b354729` through `98b0c308d` are retained and regression-tested before new behavior is added.

## File map

| File | Responsibility |
|---|---|
| `src/im/lark/reaction-provider.ts` | One-shot Lark LIST/CREATE/DELETE calls with total typed receipts and no mutating auto-retry |
| `src/services/turn-feedback-reaction.ts` | Pure reaction convergence state, actions, retry class, and result reducer |
| `src/services/turn-feedback-reconciler.ts` | SessionStore commits, per-turn single-flight execution, restore scheduling, and live transition API |
| `src/services/turn-feedback-retention.ts` | Pure fail-closed retention for settled feedback and permanent diagnostics |
| `src/types.ts` | Persisted feedback reaction intent and diagnostic fields only |
| `src/daemon.ts` | Shared reconciler construction, exact-turn admission, and startup restore |
| `src/core/worker-pool.ts` | Preserves the existing terminal callback boundary; no feedback protocol or lifecycle ownership is added here |
| `test/turn-feedback-reaction.test.ts` | Pure convergence planner/reducer contract |
| `test/turn-feedback-recovery.test.ts` | Provider uncertainty, persisted-intent restart recovery, and retry schedules |
| `test/turn-feedback-retention.test.ts` | 10,000-row retention and input immutability |
| `test/turn-reactions.test.ts` | Daemon/worker-pool integration and terminal failure containment |

Existing later tasks may add the evidence, projection, sideband, rollout, and docs files already listed below. No task in this plan modifies `src/worker.ts` for feedback persistence.

### Task 0: Revert the rejected terminal-lifecycle experiment

**Files:**
- Delete via revert: `src/services/turn-feedback-terminal-outbox.ts`
- Delete via revert: `test/turn-feedback-terminal-outbox.test.ts`
- Restore via revert: `src/{daemon,worker,types}.ts`
- Restore via revert: `src/core/worker-pool.ts`
- Restore via revert: `src/im/lark/client.ts`
- Restore via revert: `src/services/turn-feedback-reconciler.ts`
- Delete via revert: `test/{turn-feedback-recovery,turn-feedback-retention}.test.ts`
- Restore via revert: `test/{session-preview-lifecycle,turn-reactions,worker-suspend}.test.ts`

- [ ] **Step 1: Confirm the rejected commit and a clean tree**

Run:

```bash
rtk git status --short
rtk git show --stat --oneline 418dcf172
rtk git merge-base --is-ancestor 418dcf172 HEAD
```

Expected: the tree is clean, the commit is the rejected `feat(feedback): 恢复一致的回合表情`, and `merge-base` exits 0.

- [ ] **Step 2: Revert without rewriting history**

Run:

```bash
rtk git revert --no-edit 418dcf172
```

Expected: one new revert commit; no `reset`, history edit, or cherry-pick.

- [ ] **Step 3: Prove the forbidden protocol is absent**

Run:

```bash
test ! -e src/services/turn-feedback-terminal-outbox.ts
test ! -e test/turn-feedback-terminal-outbox.test.ts
if rtk rg -n "turn_terminal_persisted|prepare_suspend|turn-feedback-terminal-outbox|terminalRequestId|TurnFeedbackTerminalRecord" src test; then exit 1; fi
```

Expected: both files are absent and `rg` returns no matches.

### Task 1: Re-run the accepted state and admission gates

**Files:**
- Verify: `src/services/{capacity-wait-evidence,turn-feedback-state,turn-feedback-reconciler}.ts`
- Verify: `src/{daemon,types}.ts`
- Verify: `test/{capacity-wait-evidence,turn-feedback-state,turn-feedback-reconciler,turn-reactions}.test.ts`

- [ ] **Step 1: Run the pure state-machine tests**

Run:

```bash
rtk bun run test -- test/capacity-wait-evidence.test.ts test/turn-feedback-state.test.ts
```

Expected: all tests pass; terminal remains absorbing, `needs_user` outranks capacity, and stale position is hidden.
The Ask coverage gate additionally requires ordinary, explicit, and managed RPC producers with source-bound generation to project/resume attention; shared/adopt producers without it must keep feedback unchanged while their Ask remains usable.

- [ ] **Step 2: Run exact-turn admission and routing tests**

Run:

```bash
rtk bun run test -- test/turn-feedback-reconciler.test.ts test/turn-reactions.test.ts
```

Expected: all tests pass, including duplicate admission, requester snapshot, concurrent type-ahead, quote ownership, current-reply target, and folded reply aliases.

- [ ] **Step 3: Record the retained implementation range**

Run:

```bash
rtk git log --oneline 92b354729^..98b0c308d
rtk git diff --check
rtk git status --short
```

Expected: the accepted Task 1/2 commits remain present; the tree is clean after the revert commit.

### Task 2: Add total one-shot reaction-provider receipts

**Files:**
- Create: `src/im/lark/reaction-provider.ts`
- Create: `test/turn-feedback-recovery.test.ts`

- [ ] **Step 1: Write failing receipt and pagination tests**

Define the exact public surface in the test:

```ts
export interface OwnReaction { id: string; type: string }

export type ReactionListReceipt =
  | { kind: 'listed'; reactions: OwnReaction[] }
  | { kind: 'message_gone' }
  | { kind: 'retryable'; reason: 'rate_limited' | 'request_processing' | 'transport_uncertain' }
  | { kind: 'blocked'; reason: 'permission_denied' | 'chat_unavailable' | 'operator_unavailable' }
  | { kind: 'permanent'; reason: 'invalid_request' | 'unsupported_message' | 'invalid_response' };

export type ReactionCreateReceipt =
  | { kind: 'created'; reaction: OwnReaction }
  | Exclude<ReactionListReceipt, { kind: 'listed' }>;

export type ReactionDeleteReceipt =
  | { kind: 'deleted' | 'already_absent' | 'message_gone' }
  | { kind: 'retryable'; reason: 'rate_limited' | 'request_processing' | 'transport_uncertain' }
  | { kind: 'blocked'; reason: 'permission_denied' | 'chat_unavailable' | 'operator_unavailable' }
  | { kind: 'permanent'; reason: 'invalid_request' | 'unsupported_message' | 'invalid_response' };
```

Cover these behaviors:

- LIST paginates until `has_more=false`, deduplicates IDs, filters to this app, and does not pass an emoji filter;
- malformed pages, cursor loops, conflicting IDs, and thrown transports return data instead of throwing;
- CREATE executes at most one POST per call and maps empty success IDs to `transport_uncertain`;
- DELETE executes at most one DELETE per call and distinguishes already-absent from message-gone;
- provider error codes map exhaustively to retryable, blocked, permanent, or message-gone.

- [ ] **Step 2: Run RED**

Run:

```bash
rtk bun run test -- test/turn-feedback-recovery.test.ts
```

Expected: import/type failures because `reaction-provider.ts` does not exist.

- [ ] **Step 3: Implement the provider adapter**

Implement only these functions:

```ts
export async function listOwnReactions(
  appId: string,
  messageId: string,
): Promise<ReactionListReceipt>;

export async function createReactionOnce(
  appId: string,
  messageId: string,
  type: string,
): Promise<ReactionCreateReceipt>;

export async function deleteReactionOnce(
  appId: string,
  messageId: string,
  reactionId: string,
): Promise<ReactionDeleteReceipt>;
```

Use the existing Lark client and write guard, but do not call the old mutating helpers from inside this module: their outer retry gate can replay a POST/DELETE. LIST may use the read gate. CREATE/DELETE must make exactly one provider request and turn every response/throw into a typed receipt.

- [ ] **Step 4: Run GREEN and commit**

```bash
rtk bun run test -- test/turn-feedback-recovery.test.ts
rtk git add src/im/lark/reaction-provider.ts test/turn-feedback-recovery.test.ts
rtk git commit -m "feat(feedback): 分类飞书表情回执"
```

### Task 3: Build the pure reaction convergence planner

**Files:**
- Create: `src/services/turn-feedback-reaction.ts`
- Modify: `src/types.ts`
- Create: `test/turn-feedback-reaction.test.ts`

- [ ] **Step 1: Write failing pure planner tests**

Persist one immutable intent shape:

```ts
export interface PersistedReactionIntent {
  id: string;
  messageId: string;
  desiredType?: string;
  createdAt: string;
  stage: 'observe' | 'delete' | 'create' | 'cleanup' | 'blocked' | 'permanent';
  adopted?: OwnReaction;
  deleteIds: string[];
  retryClass?: 'transient' | 'blocked';
  diagnostic?:
    | 'invalid_request'
    | 'unsupported_message'
    | 'invalid_response'
    | 'permission_denied'
    | 'chat_unavailable'
    | 'operator_unavailable';
  retryExhausted?: true;
}
```

Exercise the exported pure functions:

```ts
export function desiredReaction(record: PersistedTurnFeedback, policy: TurnReactionPolicy): string | undefined;
export function planReactionStep(input: ReactionPlanInput): ReactionPlan;
export function reduceReactionReceipt(input: ReactionReceiptInput): ReactionPlanResult;
```

Required cases:

- no intent + mismatch returns `persist_intent`, never a provider mutation;
- every persisted intent returns LIST as its first provider action in a fresh process;
- a complete LIST adopts one desired reaction, journals all other own IDs for cleanup across emoji types, and never blindly CREATEs;
- zero desired matches deletes all old own reactions before CREATE; desired `undefined` only deletes;
- ambiguous/retryable LIST does not mutate; blocked/permanent responses persist diagnostics;
- a phase change replaces the desired target only after accounting for the old uncertain intent;
- duplicate receipts and stale intent IDs are no-ops; message-gone settles without recreation;
- non-Lark message IDs produce a settled no-provider plan.

- [ ] **Step 2: Run RED**

Run:

```bash
rtk bun run test -- test/turn-feedback-reaction.test.ts
```

Expected: import/type failures because the planner and persisted intent do not exist.

- [ ] **Step 3: Implement the minimal pure module**

Keep this file free of timers, SessionStore, Lark clients, bot registry, and daemon state. `planReactionStep` may return only:

```ts
export type ReactionPlan =
  | { action: 'settled' }
  | { action: 'persist_intent'; intent: PersistedReactionIntent }
  | { action: 'list'; intentId: string; messageId: string }
  | { action: 'delete'; intentId: string; messageId: string; reactionId: string }
  | { action: 'create'; intentId: string; messageId: string; type: string };
```

Provider receipts reduce to a replacement persisted intent plus optional adopted reaction. The runner must commit that result before asking the planner for the next action.

- [ ] **Step 4: Run GREEN and commit**

```bash
rtk bun run test -- test/turn-feedback-reaction.test.ts
rtk git add src/types.ts src/services/turn-feedback-reaction.ts test/turn-feedback-reaction.test.ts
rtk git commit -m "feat(feedback): 规划持久表情收敛"
```

### Task 4: Add safe feedback retention

**Files:**
- Create: `src/services/turn-feedback-retention.ts`
- Create: `test/turn-feedback-retention.test.ts`

- [ ] **Step 1: Write the failing 10,000-row retention suite**

Define:

```ts
export function pruneTurnFeedback(
  records: Readonly<Record<string, PersistedTurnFeedback>>,
  nowMs: number,
  policy: TurnReactionPolicy,
): Record<string, PersistedTurnFeedback>;
```

Assert exactly:

- every nonterminal row is retained regardless of age;
- every row with an intent, pending reaction mismatch, capacity/attention/reminder/binding/cursor obligation, invalid timestamp, or future timestamp is retained;
- settled terminal rows retain only entries newer than 7 days and then only the newest 512;
- permanent or retry-exhausted diagnostics use a separate newer-than-7-days/newest-128 bucket;
- message-gone with no other obligation is settled and eligible for normal pruning;
- a mixed 10,000-row fixture returns the exact expected keys and does not mutate input.

- [ ] **Step 2: Run RED**

Run:

```bash
rtk bun run test -- test/turn-feedback-retention.test.ts
```

Expected: import failure because the retention module does not exist.

- [ ] **Step 3: Implement pure fail-closed retention**

Parse timestamps once, classify unresolved before applying either bucket, sort newest-first with a stable turn-ID tie-break, and return cloned map structure without mutating records. Do not prune inside admission; prune after terminal commit and recovery settlement so admission latency stays bounded.

- [ ] **Step 4: Run GREEN and commit**

```bash
rtk bun run test -- test/turn-feedback-retention.test.ts
rtk git add src/services/turn-feedback-retention.ts test/turn-feedback-retention.test.ts
rtk git commit -m "feat(feedback): 限制已收敛反馈留存"
```

### Task 5: Run persisted-intent convergence and restore

**Files:**
- Modify: `src/services/turn-feedback-reconciler.ts`
- Modify: `src/daemon.ts`
- Modify: `test/turn-feedback-recovery.test.ts`
- Modify: `test/turn-feedback-reconciler.test.ts`

- [ ] **Step 1: Write failing journal-order and restart tests**

Inject `commit`, `read`, provider calls, timers, UUID, and policy. Add behavioral tests proving:

- `reconcile()` commits `PersistedReactionIntent` before any LIST/DELETE/CREATE call;
- each provider result is committed before the next provider call;
- restart recovery scans only rows that already contain a persisted intent or pending settled-row repair;
- provider uncertainty always re-enters at LIST and does not repeat CREATE/DELETE blindly;
- complete own-reaction cleanup spans all emoji types and leaves at most one desired reaction;
- per-turn single-flight plus intent ID fencing makes concurrent restore/live reconcile idempotent;
- transient recovery attempts are immediate, then 1s, 5s, 15s; unresolved intent remains durable after exhaustion;
- blocked recovery attempts are immediate, then 5m, 30m, 2h; exhaustion becomes a durable diagnostic;
- permanent diagnostics receive one LIST probe per daemon process and never mutate blindly;
- desired phase changes cancel old timers, `dispose()` clears memory, and SessionStore failures make no provider call;
- legacy sessions without `turnFeedback` restore inertly.

- [ ] **Step 2: Run RED**

Run:

```bash
rtk bun run test -- test/turn-feedback-recovery.test.ts test/turn-feedback-reconciler.test.ts
```

Expected: planner tests may pass, but orchestration/restart tests fail because no runner exists.

- [ ] **Step 3: Implement the orchestration loop**

Expose only:

```ts
reconcile(target: TurnFeedbackTarget, turnId: string): Promise<void>;
restore(targets: Iterable<TurnFeedbackTarget>): Promise<void>;
scheduleReactionRepair(target: TurnFeedbackTarget, turnId: string): Promise<void>;
dispose(target?: TurnFeedbackTarget): void;
```

For each step: read the fresh row, ask the pure planner, commit any intent/result, then issue at most one provider call. Timers store only app/session/turn/intent ID and re-read SessionStore before acting. Startup restore runs after owned sessions are loaded and before later capacity consumers start.

- [ ] **Step 4: Run GREEN and commit**

```bash
rtk bun run test -- test/turn-feedback-recovery.test.ts test/turn-feedback-reconciler.test.ts test/turn-feedback-reaction.test.ts test/turn-feedback-retention.test.ts
rtk git add src/services/turn-feedback-reconciler.ts src/daemon.ts test/turn-feedback-recovery.test.ts test/turn-feedback-reconciler.test.ts
rtk git commit -m "feat(feedback): 恢复持久表情意图"
```

### Task 6: Integrate live terminal feedback without owning terminal lifecycle

**Files:**
- Modify: `src/services/turn-feedback-reconciler.ts`
- Modify: `src/daemon.ts`
- Modify: `test/turn-reactions.test.ts`

- [ ] **Step 1: Write failing atomic-terminal and containment tests**

Add one transition API:

```ts
prepareTerminalMutation(
  record: PersistedTurnFeedback,
  phase: 'completed' | 'failed',
  observedAtMs: number,
  policy: TurnReactionPolicy,
): PersistedTurnFeedback;
```

The returned row must contain both terminal feedback state and a new immutable reaction intent whenever the desired reaction changes. Test the existing `onTurnTerminal` callback, invoked by the live `turn_terminal` branch after its existing stale-worker/session guards, with spies proving:

- exact current worker/session/generation gates remain unchanged;
- one `mutateOwnedSessionsAtomically` call commits phase plus reaction intent;
- only after that commit succeeds does asynchronous reaction convergence start;
- if the commit throws, there is no reaction provider call, one stable error is logged, and the handler still performs its existing LinkRef, notices, cards, hooks, async-trigger, final-output, and lifecycle work;
- duplicate live terminal delivery does not create a second intent or provider mutation;
- a crash before this first commit has no restore assertion and no synthetic outbox record;
- no `DaemonToWorker`/`WorkerToDaemon` type, worker emission, suspend path, or Web Terminal path changes.

- [ ] **Step 2: Run RED**

Run:

```bash
rtk bun run test -- test/turn-reactions.test.ts
```

Expected: atomic terminal feedback and failure-containment tests fail.

- [ ] **Step 3: Add the minimal live-terminal hook**

In the existing daemon `onTurnTerminal` callback, synchronously attempt one feedback mutation when the exact feedback row exists. The worker-pool already calls this callback after stale-worker and session-ID guards and already catches callback failure; keep that boundary unchanged. On mutation failure log `feedback_terminal_commit_failed`, return from the feedback callback, and let worker-pool continue its historical terminal branch. On success, queue `reconcile()` without awaiting it. Do not ACK the worker, retry the terminal, block suspend, or defer any lifecycle effect.

- [ ] **Step 4: Run GREEN and commit**

```bash
rtk bun run test -- test/turn-reactions.test.ts test/turn-feedback-recovery.test.ts test/turn-feedback-retention.test.ts
rtk git add src/services/turn-feedback-reconciler.ts src/daemon.ts test/turn-reactions.test.ts
rtk git commit -m "feat(feedback): 接入实时终态表情"
```

### Task 7: Authoritative TraeX viewport adapter

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

Emit `capacity_wait` only when current/captured identity tuples match. Clear only on authoritative progress/composer return; silence never clears. This evidence-only IPC does not carry terminal delivery or acknowledgements.

- [ ] **Step 4: Run GREEN and commit**

```bash
rtk bun run test -- test/worker-capacity-wait.test.ts test/worker-capacity-wait.integration.test.ts
rtk git add src/services/worker-capacity-wait.ts src/worker.ts src/types.ts test/worker-capacity-wait* test/fixtures/capacity-wait
rtk git commit -m "feat(traex): 识别当前容量排队状态"
```

### Task 8: Dashboard, work-card, and reminder projection

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
rtk bun run test -- test/dashboard-capacity-wait.test.ts test/session-card-model.test.ts test/capacity-wait-reminder.test.ts test/turn-reactions.test.ts
```

- [ ] **Step 4: Implement projections and timers**

Overlay capacity without replacing main process status. Timers hold only app/session/turn and reread SessionStore before side effects. Unsupported is capability state, never a waiting episode.

- [ ] **Step 5: Run GREEN and commit**

```bash
rtk bun run test -- test/dashboard-capacity-wait.test.ts test/session-card-model.test.ts test/capacity-wait-reminder.test.ts test/turn-reactions.test.ts
rtk git add src/core/dashboard-rows.ts src/dashboard src/im/lark src/services/capacity-live-card-scheduler.ts src/services/capacity-wait-reminder.ts test/dashboard-capacity-wait.test.ts test/session-card-model.test.ts test/capacity-wait-reminder.test.ts test/turn-reactions.test.ts
rtk git commit -m "feat(capacity): 投影等待状态与提醒"
```

### Task 9: Define and verify capacity-wait.v3

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
rtk git add src/services/capacity-sideband-consumer.ts test/capacity-sideband-consumer.test.ts test/fixtures/capacity-sideband
rtk git commit -m "feat(capacity): 定义 fleet 签名事件协议"
```

### Task 10: Bind native identities and consume one owner directory

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
rtk bun run test -- test/capacity-sideband-consumer.test.ts test/capacity-sideband-runtime.test.ts test/worker-pool-native-input-receipt.test.ts
```

- [ ] **Step 3: Implement daemon-only consumer**

Workers publish only native-binding IPC and receive no sideband paths/keys. Poll after feedback restore. Require exact persisted current binding before projection. Sideband `terminal` is evidence that clears capacity state; it does not become a Botmux terminal lifecycle source.

- [ ] **Step 4: Run GREEN and commit**

```bash
rtk bun run test -- test/capacity-sideband-consumer.test.ts test/capacity-sideband-runtime.test.ts test/worker-pool-native-input-receipt.test.ts
rtk git add src/services/capacity-sideband* src/services/codex-bridge-queue.ts src/services/bridge-turn-queue.ts src/services/turn-feedback-reconciler.ts src/worker.ts src/types.ts src/daemon.ts src/core/worker-pool.ts test/capacity-sideband* test/worker-pool-native-input-receipt.test.ts
rtk git commit -m "feat(capacity): 按机器人消费签名事件"
```

### Task 11: Fleet rollout policy, status, and privacy ledger

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
rtk bun run test -- test/capacity-rollout-store.test.ts test/capacity-wait-audit.test.ts test/capacity-wait-config.test.ts test/capacity-cli.test.ts test/command-handler.test.ts
```

- [ ] **Step 4: Implement stores and status**

Final `full` defaults supported adapters on; no pilot allowlist. Keep emoji/reminder tuning. IM `/capacity status` and host CLI `botmux capacity status --json` show phase, source support, latch, signer key/epoch without secrets/raw identifiers. Host CLI phase/disable/enable mutations call the same locked rollout and disable stores.

- [ ] **Step 5: Run GREEN and commit**

```bash
rtk bun run test -- test/capacity-rollout-store.test.ts test/capacity-wait-audit.test.ts test/capacity-wait-config.test.ts test/capacity-cli.test.ts test/command-handler.test.ts
rtk git add src/services/capacity-rollout-store.ts src/services/capacity-wait-audit.ts src/services/capacity-sideband-disable-store.ts src/cli/capacity-command.ts src/cli.ts src/bot-registry.ts src/types.ts src/services/bot-config-store.ts src/core/command-schema.ts src/core/command-handler.ts src/core/worker-pool.ts src/i18n test/capacity-rollout-store.test.ts test/capacity-wait-audit.test.ts test/capacity-wait-config.test.ts test/capacity-cli.test.ts test/command-handler.test.ts
rtk git commit -m "feat(capacity): 增加 fleet 策略与证据"
```

### Task 12: Verify the Botmux topic

**Files:**
- Modify: `docs-site/docs/zh/slash-commands.md`
- Modify: `docs-site/docs/en/slash-commands.md`

- [ ] **Step 1: Run focused suites**

```bash
rtk bun run test -- test/capacity-wait-evidence.test.ts test/turn-feedback-state.test.ts test/turn-feedback-reconciler.test.ts test/turn-feedback-reaction.test.ts test/turn-feedback-recovery.test.ts test/turn-feedback-retention.test.ts test/worker-capacity-wait.test.ts test/worker-capacity-wait.integration.test.ts test/dashboard-capacity-wait.test.ts test/session-card-model.test.ts test/capacity-wait-reminder.test.ts test/capacity-sideband-consumer.test.ts test/capacity-sideband-runtime.test.ts test/capacity-rollout-store.test.ts test/capacity-wait-audit.test.ts test/capacity-cli.test.ts test/turn-reactions.test.ts test/worker-pool-native-input-receipt.test.ts test/command-handler.test.ts
```

Expected: all pass with zero unhandled errors. There is no terminal-outbox test because that protocol is outside this feature.

- [ ] **Step 2: Typecheck/build/scope**

```bash
rtk npx tsc -p tsconfig.json --noEmit
rtk bun run build
rtk git diff --check
rtk git status --short
rtk git diff --stat dev...HEAD
rtk git log --oneline dev..HEAD
if rtk rg -n "turn_terminal_persisted|prepare_suspend|turn-feedback-terminal-outbox|terminalRequestId|TurnFeedbackTerminalRecord" src test; then exit 1; fi
```

Expected: tests, typecheck, and build pass; tree is clean; forbidden-protocol scan returns no matches; only capacity feature/docs differ.

- [ ] **Step 3: Independent immutable-range review**

Record `BASE=$(git rev-parse dev)` and `HEAD=$(git rev-parse HEAD)`, then review immutable `$BASE..$HEAD` for spec and correctness/security. Required reviewer evidence includes the terminal-commit failure containment test and a direct scan of `src/worker.ts`, suspend paths, and IPC unions showing no feedback lifecycle protocol. Fix blockers with new tests and freeze a new head.
