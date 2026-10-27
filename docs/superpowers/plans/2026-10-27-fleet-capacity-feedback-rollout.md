# Fleet Capacity Feedback — Integration and Rollout Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the reviewed Botmux/Proxy/AIKit changes into maintained branches, pass frozen-baseline gates, then deploy one Botmux release to the whole fleet and advance capacity feedback through approved staged phases to final full policy.

**Architecture:** Proxy is deployed first while old Botmux ignores v3. Botmux ships next to every daemon in shadow phase. A shared rollout store then advances TraeX, Proxy-backed Codex/Claude, and full capability in place without version splits. Host customization metadata is checksum-attested because that maintenance root is intentionally not a Git repository. Every phase has an explicit readback and the smallest rollback target.

**Tech Stack:** Git, Botmux customization manifest, Bun/Vitest, Python release tools, systemd user service, AIKit CLIProxy transaction, PM2, Lark/Dashboard readback.

---

## Safety rules

- Do not mutate any existing directory directly under `~/project/botmux-custom/releases/` or the frozen live checkout.
- Do not expose raw per-bot keys, signer seed, prompt/output, or private authorization links in logs or Lark.
- A test/build/review failure stops the rollout. A natural queue not occurring is “not yet observed”, not a pass or failure.
- All 29 bots receive one release at Batch 0. Later batches change only shared rollout policy; they do not install per-bot binaries.
- Use the actual fleet count at execution time. “29/29” is the current expectation, not a hard-coded invariant.

### Task 1: Prepare a clean standalone Botmux topic

**Files:**
- Branch: `topic/capacity-wait-feedback`
- Modify on conflict: the exact capacity files/tests named by `git status --short` during the rebase

- [ ] **Step 1: Freeze the reviewed implementation head**

```bash
git -C ~/temp/botmux-capacity-fleet-spec status --short
git -C ~/temp/botmux-capacity-fleet-spec rev-parse dev HEAD origin/master
git -C ~/temp/botmux-capacity-fleet-spec branch topic/capacity-wait-feedback-pre-rebase HEAD
```

Expected: clean tree; backup branch points to the reviewed head.

- [ ] **Step 2: Rebase only feature commits onto current upstream**

```bash
git -C ~/temp/botmux-capacity-fleet-spec fetch origin master
git -C ~/temp/botmux-capacity-fleet-spec rebase --onto origin/master dev topic/capacity-wait-feedback
```

Resolve conflicts with `apply_patch`; preserve upstream and feature behavior. Never accept an entire side for shared files.

- [ ] **Step 3: Verify standalone topic**

Run the Botmux focused suite, TypeScript, and build from the Botmux subplan. Then:

```bash
git diff --check origin/master...HEAD
git status --short
git log --oneline origin/master..HEAD
```

Expected: only feature commits; clean tree.

- [ ] **Step 4: Re-review rewritten immutable range**

Record `BASE=$(git rev-parse origin/master)` and `HEAD=$(git rev-parse HEAD)`, then review `$BASE..$HEAD` for spec and correctness/security. A previously approved pre-rebase range is not evidence for rewritten conflict resolutions.

### Task 2: Register and compose the customization topic

**Files:**
- Modify: `~/project/botmux-custom/manifest.json`
- Modify: `~/project/botmux-custom/tools/assemble_test.py`

- [ ] **Step 1: Write the failing manifest composition test**

Extend `assemble_test.py` with a feature topic after a prior topic and a newer upstream base. Assert the capacity topic's files survive, published dev history remains an ancestor, and unrelated topics remain byte-identical.

- [ ] **Step 2: Run RED**

Run: `python3 ~/project/botmux-custom/tools/assemble_test.py`.
Expected: FAIL until the manifest entry/dependency order is added.

- [ ] **Step 3: Add manifest entry using apply_patch**

```json
{
  "branch": "topic/capacity-wait-feedback",
  "enabled": true,
  "upstream": "local-only",
  "pr": null,
  "note": "可信容量反馈：统一逐 turn 状态、TraeX 权威观测、fleet sideband v3 与分批开关"
}
```

Place it after any explicit dependency discovered by the standalone rebase. Do not edit `dev` directly.

- [ ] **Step 4: Run GREEN and rebuild**

```bash
python3 ~/project/botmux-custom/tools/assemble_test.py
~/project/botmux-custom/tools/rebuild-dev.sh
jq '{ok,stage,base,dev,last_good,tsc,tests,topics}' ~/project/botmux-custom/results/dev-rebuild-latest.json
```

Expected: `ok=true`, capacity topic merged, typecheck/tests pass.

- [ ] **Step 5: Save and attest host-maintenance metadata**

The customization root is intentionally not a Git repository. Compute SHA-256 for `manifest.json` and `tools/assemble_test.py`, copy both into the deployment evidence directory, and record their before/after hashes in `VERIFICATION.md`. The feature source itself remains committed on `topic/capacity-wait-feedback`; never pretend host-maintenance metadata was committed.

### Task 3: Build and gate the Botmux release candidate

**Files:** generated release and gate artifacts only.

- [ ] **Step 1: Prepare isolated candidate**

```bash
python3 ~/project/botmux-custom/tools/release.py prepare split/dev-check
```

Expected: a new immutable release directory whose basename is the first 12 characters of the candidate SHA; no reuse of a verified/live release.

- [ ] **Step 2: Build frozen upstream baseline**

Create a standalone clone under `~/temp` at the exact full base SHA recorded by rebuild. Install the same lock and run `bun run build`; do not borrow candidate dist/node_modules.

- [ ] **Step 3: Run the full comparison gate**

```bash
CANDIDATE_RELEASE=/absolute/path/from-release-prepare
FULL_BASE_SHA=$(jq -r .base ~/project/botmux-custom/results/dev-rebuild-latest.json)
BASELINE_CLONE=/home/zhongweijie.x/temp/botmux-upstream-baseline-$FULL_BASE_SHA
CANDIDATE_SHA=$(git -C "$CANDIDATE_RELEASE" rev-parse HEAD)
GATE_DIR=/home/zhongweijie.x/temp/botmux-capacity-gate-$CANDIDATE_SHA
python3 ~/project/botmux-custom/tools/test-gate.py "$CANDIDATE_RELEASE" "$BASELINE_CLONE" "$FULL_BASE_SHA" "$GATE_DIR"
jq . "$GATE_DIR/gate.json"
```

Expected: `ok=true`; any failures are individually baseline-equivalent. No collection/hook/report error.

- [ ] **Step 4: Review candidate artifact invariants**

Verify source SHA, dist hash, dependency hash, and focused/full outputs did not change after review. Do not activate yet.

### Task 4: Prepare and activate Proxy v3 producer

**Files:** generated AIKit candidate/deployment artifacts only.

- [ ] **Step 1: Snapshot production**

Record Proxy PID, binary/config hashes, 8317 listener owner, model list, PM2 state, existing shared key hash (not value), and absence/presence of capacity root/key files.

- [ ] **Step 2: Prepare candidate**

```bash
aikit cliproxy prepare --source ~/temp/cliproxy-capacity-fleet --json
```

Expected: candidate binary/config/per-bot-key manifest plus hashes; live PID/files unchanged.

- [ ] **Step 3: Verify sideband before activation**

Use synthetic test keys and test owner directories inside the candidate root. Verify signed waiting→clear→terminal for Codex and Claude fixtures; unknown credential emits no event. Remove exact synthetic files after verification.

- [ ] **Step 4: Activate transactionally**

```bash
CANDIDATE_DIR=/absolute/path/from-cliproxy-prepare
aikit cliproxy activate "$CANDIDATE_DIR" --json
```

Expected: one PM2 restart, health/models pass, live config/binary match candidate, signer private key mode/owner valid, owner mapping hash matches fleet input. Failure must auto-restore the old binary/config/PID service.

- [ ] **Step 5: Post-activation readback**

Run `aikit cliproxy status --json`, health, models, listener/PID/hash checks, and a signed lifecycle smoke. Old Botmux release should remain unaffected because it ignores v3.

### Task 5: Activate Botmux Batch 0 (shadow everywhere)

**Files:** shared rollout state created by the candidate CLI.

- [ ] **Step 1: Initialize shadow before restart**

```bash
"$CANDIDATE_RELEASE/dist/cli.js" capacity phase shadow --json
"$CANDIDATE_RELEASE/dist/cli.js" capacity status --json
```

Expected: phase shadow persisted; no user-visible capacity projection.

- [ ] **Step 2: Dry-run release activation**

```bash
python3 ~/project/botmux-custom/tools/release.py activate "$CANDIDATE_RELEASE" "$GATE_DIR/gate.json"
```

Check unit diff and exact candidate/gate match.

- [ ] **Step 3: Activate via independent service**

```bash
python3 ~/project/botmux-custom/tools/release.py activate "$CANDIDATE_RELEASE" "$GATE_DIR/gate.json" --apply
```

If output says scheduled, poll the named systemd unit; do not launch a second activation.

- [ ] **Step 4: Verify whole-fleet shadow health**

Read `current-release.json`, systemd, fleet state, actual process executable/dist paths, Dashboard HTTP health, ports, and 15-second stability. Expected actual configured bot count + Dashboard all online on one release. Verify ordinary turns, Ask, completion/failure, cards, and reactions show no new capacity UI while shadow.

### Task 6: Batch 1 — TraeX projection

**Files:** shared rollout state and verification artifact only.

- [ ] **Step 1: Advance policy**

```bash
botmux capacity phase traex --json
botmux capacity status --json
```

Expected: all TraeX apps enabled; Proxy adapters remain shadow; no pilot allowlist.

- [ ] **Step 2: Verify deterministic behavior**

Run the installed release's TraeX focused fixtures. Verify all TraeX bots report supported/enabled, other bots do not. Confirm normal processing/Ask/completion still converge.

- [ ] **Step 3: Observe an explicit native queue episode**

Use the first naturally occurring authoritative TraeX queue in the approved observation window. Record external first-visible latency, position update, stale/clear/terminal, and exact app/session/turn ownership. If none occurs, keep the batch open and report “not observed”; do not synthesize a pass by injecting text into a live session.

- [ ] **Step 4: Batch gate**

Advance after installed-release deterministic tests prove <=5-second external projection, no cross-bot projection exists, and all negative fixtures remain quiet. Record a natural episode when available; its absence is an explicit evidence qualifier, not a rollout blocker. One confirmed false positive runs `botmux capacity disable --app-id "$AFFECTED_APP_ID" --adapter traex --reason false-positive --json` and pauses the rollout for repair.

### Task 7: Batch 2 — Proxy-backed Codex and Claude

**Files:** shared rollout state and verification artifact only.

- [ ] **Step 1: Verify credential/source inventory**

Compare Proxy owner mapping to the live bot list. Proxy-backed Codex/Claude must have distinct managed key files and supported capability; direct subscription/Relay paths must report unsupported, not enabled.

- [ ] **Step 2: Advance policy**

```bash
botmux capacity phase proxy --json
botmux capacity status --json
```

- [ ] **Step 3: Run isolation tests on the installed release**

Use signed synthetic v3 events bound to test SessionStore fixtures, not live user turns, to verify wrong owner/session/turn/attempt/generation, replay, sequence rollback, and key rotation never project.

- [ ] **Step 4: Observe real Codex and Claude episodes**

For the first natural explicit Proxy queue from each adapter, record <=5-second external visibility, updates, clear/terminal, signer key/epoch, and exact ownership. Missing natural evidence is recorded as a qualifier; deterministic signed lifecycle tests on the installed release remain the rollout gate.

- [ ] **Step 5: Batch gate**

One confirmed false positive disables only that `app × adapter`, pauses expansion for the affected adapter, and preserves other apps/adapters.

### Task 8: Batch 3 — Full policy and remaining bots

**Files:** shared rollout state and verification artifact only.

- [ ] **Step 1: Advance to full**

After TraeX and both Proxy adapters have passed their deterministic gates, advance to full even if a provider has not naturally queued during this run. Natural episodes improve rollout evidence but are not required to finish rollout; any later confirmed false positive still trips the same app × adapter latch immediately.

```bash
botmux capacity phase full --json
botmux capacity status --json
```

Expected: supported adapters default enabled for current/new bots; no pilot list. Direct/Relay/other paths without authoritative evidence remain explicit unsupported.

- [ ] **Step 2: Verify every bot's resolved state**

For each configured app, record CLI/runtime path and resolved `enabled|unsupported|disabled`. Every app runs the same release and feedback framework. Unsupported must not be counted as an observed queue path.

- [ ] **Step 3: Final health/readback**

Verify all configured bots + Dashboard online, one release SHA/build, 15-second stability, Proxy health/models/signer, rollout full, no unexpected latches, and zero cross-app/session/turn/attempt events.

### Task 9: Rollback drills and handoff

**Files:**
- Create: `~/temp/botmux-capacity-feedback-20261027/VERIFICATION.md`

- [ ] **Step 1: Drill app × adapter rollback without user-visible live traffic**

Disable/re-enable a synthetic test app cell and verify only its state clears. Never use a live app for a drill unless there is an actual incident.

- [ ] **Step 2: Verify fleet-level switches**

In test fixtures, verify `off` clears capacity projections while preserving ordinary processing/terminal state; returning to the prior phase does not clear durable local latches.

- [ ] **Step 3: Record executable recovery commands**

The verification file must identify:

- app × adapter disable command;
- fleet adapter/global off command;
- previous Botmux release + exact gate and release activation rollback path;
- previous Proxy deployment + `aikit cliproxy rollback "$PREVIOUS_PROXY_DEPLOYMENT"`;
- evidence that rollback does not replay user tasks.

- [ ] **Step 4: Deliver verification**

Attach `VERIFICATION.md` in Lark and verify `attachmentMessageIds` is present with no failed attachments. State actual enabled/unsupported/disabled cells and any adapter with “natural episode not yet observed”; this is an evidence qualifier, not a partially enabled rollout phase.
