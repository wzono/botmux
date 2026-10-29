# Turn Reaction Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent `/th` startup idle from producing premature DONE and project DONE/ERROR only from the exact turn terminal.

**Architecture:** Keep persisted real sessions on the existing turn-feedback reconciler. Narrow the legacy in-memory reaction list to unowned compatibility ingress, bind each entry to a `turnId`, remove screen-idle settlement, and settle one matching entry after the worker-pool's existing terminal ownership checks.

**Tech Stack:** TypeScript, Bun, Vitest, SessionStore, Lark message reactions.

---

### Task 1: Pin the terminal-only behavior

**Files:**
- Modify: `test/turn-reactions.test.ts`

- [ ] **Step 1: Change the screen-idle regression to require no DONE**

Use an in-memory compatibility reaction with `turnId: 'om_a'`, emit
`working -> idle`, and assert the entry remains pending with no remove/create calls.

- [ ] **Step 2: Add exact completed, failed, and type-ahead terminal tests**

Emit real `turn_terminal` worker messages after configuring the worker-pool callback.
Assert completed creates DONE, failed creates ERROR, and terminal A leaves B pending.

- [ ] **Step 3: Run the test and verify RED**

Run: `rtk bun run test -- test/turn-reactions.test.ts`

Expected: the idle test fails because current code adds DONE; terminal tests fail because
the compatibility list is not settled from `turn_terminal`.

### Task 2: Implement exact compatibility settlement

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/daemon.ts`
- Modify: `src/core/worker-pool.ts`

- [ ] **Step 1: Bind compatibility reaction entries to turnId**

Change the entry type to `{ turnId, messageId, reactionId? }`. In the unowned
compatibility admission branch, append the receipt only after CREATE succeeds and dedupe
by exact turn/message.

- [ ] **Step 2: Replace batch idle settlement with exact terminal settlement**

Remove the `finishTurnReactions` call from the screen-update idle edge. Replace it with
`finishTurnReaction(ds, turnId, status)`, which removes only matching entries and creates
DONE for completed or ERROR for non-completed terminal status.

- [ ] **Step 3: Invoke settlement inside the owned worker terminal path**

Call the helper after the existing stale-worker and session identity checks and before the
terminal callback. Duplicate terminals remain no-op because the matching list entry has
already been removed.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `rtk bun run test -- test/turn-reactions.test.ts test/rate-limit-notify.test.ts test/turn-feedback-state.test.ts test/turn-feedback-reconciler.test.ts`

Expected: all tests pass.

### Task 3: Verify and freeze

**Files:**
- Verify all touched files

- [ ] **Step 1: Run affected lifecycle tests**

Run the turn-reaction, worker terminal, failed-turn, capacity feedback, recovery and
retention test files selected from the diff.

- [ ] **Step 2: Build and check the patch**

Run: `rtk bun run build`

Run: `rtk git diff --check`

Expected: both exit 0.

- [ ] **Step 3: Commit the bugfix**

Commit message: `fix(feedback): 按真实回合终态结算表情`

- [ ] **Step 4: Request non-author review**

Freeze the new SHA and ask the reviewer to verify the `/th` startup race, exact success/failure
mapping, type-ahead isolation, focused tests and clean build. Do not integrate or deploy.

