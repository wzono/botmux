# Group Workspace Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a host-local, cross-Bot group working-directory binding whose `/repo` behavior follows chat/thread session scope and survives Bot configuration rewrites.

**Architecture:** A dedicated file-backed store owns `chatId → binding` with locking, atomic writes, CAS revisions, and message idempotency. New-session resolution consumes the binding between per-Bot oncall overrides and Bot defaults; text and card `/repo` paths share a post-session-commit hook that writes only for ordinary group chat-scope sessions.

**Tech Stack:** TypeScript, Bun, Vitest, Botmux daemon/session store, Lark command and card handlers, atomic JSON storage with cross-process file locks.

---

## File map

- Create `src/services/group-workspace-store.ts`: schema validation, read, CAS upsert/unbind, idempotency, path health, manager policy, test reset.
- Create `src/core/group-workspace-policy.ts`: pure precedence, command scope, authorization, and follow-on-next-turn decisions.
- Modify `src/core/command-handler.ts`: `/repo show`, `/repo unbind`, and successful text selection group commit.
- Modify `src/im/lark/card-handler.ts`: successful card selection group commit using the same helper contract.
- Modify `src/daemon.ts`: new-session and `/th` resolution, invalid-binding fail-closed, existing chat-scope follow at a safe boundary.
- Modify `src/i18n/zh.ts` and `src/i18n/en.ts`: status, conflict, invalid, permission, show and follow messages.
- Add focused tests under `test/group-workspace-*.test.ts`; extend existing route suites only where a real route harness is required.

### Task 1: Shared store contract

**Files:**
- Create: `src/services/group-workspace-store.ts`
- Create: `test/group-workspace-store.test.ts`

- [ ] Write failing tests for missing-file reads, valid round-trip, path normalization, CAS conflict, source-message replay, CAS unbind, malformed-store failure, interrupted atomic write, parallel writers, and manager-list round-trip.
- [ ] Run `bunx vitest run test/group-workspace-store.test.ts`; expect failure because the module is absent.
- [ ] Implement `readGroupWorkspace`, `writeGroupWorkspace`, `unbindGroupWorkspace`, `listGroupWorkspaces`, and `resetGroupWorkspaceStoreForTests`. Store `{ schemaVersion: 1, bindings }` under `<dataDir>/group-workspaces.json`; lock read-modify-write and replace with `atomicWriteFileSync`.
- [ ] Rerun the suite; invert the revision guard once and confirm the concurrent-CAS test fails, then restore it.
- [ ] Commit: `feat(workspace): 增加群级目录共享存储`.

Public write result:

```ts
type GroupWorkspaceWriteResult =
  | { ok: true; binding: GroupWorkspaceBinding; previous?: GroupWorkspaceBinding; replayed: boolean }
  | { ok: false; reason: 'conflict' | 'invalid_dir' | 'store_unavailable'; current?: GroupWorkspaceBinding };
```

### Task 2: Pure precedence and authorization policy

**Files:**
- Create: `src/core/group-workspace-policy.ts`
- Create: `test/group-workspace-policy.test.ts`

- [ ] Write failing tests for `explicit > oncall > group > botDefault > picker`, unhealthy group bindings, chat-scope-only writes, `/repo wt` and `/repo here` exclusion, manager union, `workspaceManagers` replacement, and Bot actors without verified human provenance.
- [ ] Run `bunx vitest run test/group-workspace-policy.test.ts`; expect missing exports.
- [ ] Implement `resolveWorkingDirLayers`, `repoSelectionMayUpdateGroup`, `canManageGroupWorkspace`, and `shouldFollowGroupWorkspace` as pure functions.
- [ ] Rerun and expect PASS.
- [ ] Commit: `feat(workspace): 定义群目录优先级与权限`.

### Task 3: New-session and `/th` resolution

**Files:**
- Modify: `src/daemon.ts` near `resolveBotDefaultWorkingDir`, `resolvePinnedWorkingDir`, `resolveForceTopicCurrentWorkingDir`
- Modify: `src/i18n/zh.ts`, `src/i18n/en.ts`
- Create: `test/group-workspace-daemon-resolution.test.ts`
- Modify: `test/daemon-rename-route.test.ts`

- [ ] Add failing tests proving oncall beats group, group beats Bot default, Bot B reads Bot A's shared binding, `/th` uses it without a peer, invalid/malformed bindings fail closed, and no binding preserves old fallback.
- [ ] Run `bunx vitest run test/group-workspace-daemon-resolution.test.ts test/daemon-rename-route.test.ts`; expect new cases to fail.
- [ ] Change the resolver to a discriminated result carrying `group_invalid` and `group_store_unavailable`; insert the group layer after oncall and before Bot default; make `/th` use it.
- [ ] Run `bunx vitest run test/group-workspace-daemon-resolution.test.ts test/daemon-rename-route.test.ts test/daemon-pinned-working-dir.test.ts test/inherit-peer.test.ts`; expect PASS.
- [ ] Commit: `feat(workspace): 新会话读取群级工作目录`.

### Task 4: Text `/repo` writes, show, and unbind

**Files:**
- Modify: `src/core/command-handler.ts`, `src/core/command-schema.ts`
- Modify: `src/i18n/zh.ts`, `src/i18n/en.ts`
- Create: `test/group-workspace-repo-command.test.ts`
- Modify: `test/command-handler.test.ts`

- [ ] Add failing tests: successful chat-scope selection writes after session commit; failed/remote/protected switches do not; thread, `/repo wt`, and `/repo here` do not; unauthorized users only switch the session; show reports all layers; unbind is authorized/chat-scope/CAS-safe; duplicate message is idempotent.
- [ ] Run `bunx vitest run test/group-workspace-repo-command.test.ts test/command-handler.test.ts`; expect new failures.
- [ ] Add a dependency-injected `commitGroupWorkspaceAfterRepoSwitch`. Capture expected revision before the awaited session switch; write only after success. Parse exact `show` and `unbind` tokens without reserving explicit paths with those basenames.
- [ ] Run `bunx vitest run test/group-workspace-repo-command.test.ts test/command-handler.test.ts test/command-schema.test.ts test/command-router-oracle-diff.test.ts`; expect PASS.
- [ ] Commit: `feat(repo): 群顶层选仓更新共享目录`.

### Task 5: Repo card parity

**Files:**
- Modify: `src/im/lark/card-handler.ts`
- Modify: `src/im/lark/card-builder.ts` if metadata needs the originating revision
- Create: `test/group-workspace-repo-card.test.ts`
- Modify: `test/card-handler-repo-select.test.ts`

- [ ] Add failing tests for chat-scope writes, thread isolation, stale/replayed cards, unauthorized operators, revision conflicts during awaits, worktree exclusion, and aborted session commits.
- [ ] Run `bunx vitest run test/group-workspace-repo-card.test.ts test/card-handler-repo-select.test.ts`; expect new failures.
- [ ] Extend `RepoCommitContext` with verified operator identity, source message ID, and expected revision. Invoke the same post-commit helper only after `commitRepoSelection` returns true. Pending-repo owner exceptions must not grant group-write authority.
- [ ] Run `bunx vitest run test/group-workspace-repo-card.test.ts test/card-handler-repo-select.test.ts test/card-action-routes.test.ts`; expect PASS.
- [ ] Commit: `feat(repo): 选仓卡同步群级工作目录`.

### Task 6: Existing chat-scope sessions follow safely

**Files:**
- Modify: `src/daemon.ts`, `src/core/session-cwd.ts`, `src/types.ts`
- Create: `test/group-workspace-session-follow.test.ts`

- [ ] Add failing tests: idle stale group-sourced chat sessions follow before the next business turn; busy sessions defer; thread, explicit and oncall sessions never follow; invalid new group paths block; one notice is emitted; restart preserves provenance.
- [ ] Run `bunx vitest run test/group-workspace-session-follow.test.ts`; expect failure.
- [ ] Persist `workingDirSource: 'explicit' | 'oncall' | 'group' | 'bot-default'` and `groupWorkspaceRevision`. At ordinary chat-scope admission, safely repin stale group-sourced sessions using existing session-cwd primitives.
- [ ] Run `bunx vitest run test/group-workspace-session-follow.test.ts test/session-cwd.test.ts test/daemon-rename-route.test.ts`; expect PASS.
- [ ] Commit: `feat(workspace): 群顶层会话安全跟随目录更新`.

### Task 7: Integration, docs, and gates

**Files:**
- Modify: `docs-site/docs/zh/slash-commands.md`, `docs-site/docs/en/slash-commands.md`
- Create: `test/group-workspace-e2e.test.ts`

- [ ] Add a two-Bot shared-dataDir restart test: Bot A writes, reload, Bot B resolves `/th`; include invalid-directory and manager-override negatives.
- [ ] Run all `test/group-workspace-*.test.ts` suites; expect PASS.
- [ ] Document chat-scope persistence, thread isolation, precedence, show/unbind, managers, host-local scope, invalid behavior, and `/repo wt` exclusion.
- [ ] Run `bun run build`, command/doc-sync tests, then `bun run test`; record exact baseline-only failures if any.
- [ ] Commit: `docs(repo): 说明群级工作目录语义`.

### Task 8: Independent adversarial review and Draft PR evidence

- [ ] Freeze review to the design acceptance criteria and necessary call chain. Use R1 full review, R2 blocker verification, R3 terminal decision; no Dashboard editor or cross-host mapping.
- [ ] Probe real components with controlled waits/fake clock for human intervention during switch, either half of session/store partial completion, concurrent commands crossing a long switch, restart between read/CAS, and path invalidation after validation.
- [ ] Resolve every P0/P1 as fixed/wontfix/deferred with evidence; mutate each new guard and confirm its test fails before restoration.
- [ ] Update the Draft PR using `Summary`, `Evidence`, and `Merge Danger`, including before/after tests, full gates, review ledger, two-way rollback, and blast radius `会话路由`.
- [ ] Push `topic/group-workspace-binding` to `fork`; do not merge or deploy.
