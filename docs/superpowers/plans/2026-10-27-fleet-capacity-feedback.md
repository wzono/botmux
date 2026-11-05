# Fleet Capacity Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship trustworthy capacity-wait feedback in the customized Botmux `dev` release for every fleet bot, with feedback-only restart recovery and no replacement of Botmux's terminal lifecycle.

**Architecture:** Work is split into three independently testable subplans: Botmux owns durable feedback rows and reaction intents after SessionStore commit; CLIProxyAPI + AIKit own authenticated per-bot request attribution and signed `capacity-wait.v3` events; host customization metadata owns composition, gates, staged rollout, and rollback. All bots receive one release, while rollout policy controls when each authoritative adapter becomes visible.

**Tech Stack:** TypeScript, Bun, Vitest, Go, Ed25519, filesystem durability, AIKit Node.js tooling, Botmux customization manifest, systemd, PM2.

---

## Scope boundary

The approved design guarantees restart recovery only after a feedback row or reaction intent successfully commits to SessionStore. The existing live terminal path may attempt one atomic feedback terminal-state + reaction-intent mutation; if that mutation fails, Botmux logs and skips the feedback reaction while the historical terminal lifecycle continues.

The project does not create a worker terminal outbox, terminal ACK/effect protocol, opaque attempt reference, two-phase suspend, Web Terminal fence, cross-entry terminal ownership, or recovery promise for a crash before the first terminal feedback commit. Commit `418dcf172` is rejected implementation evidence and must be reverted before new coding.

## Plan map

| Order | Plan | Deliverable | Production effect |
|---|---|---|---|
| 1 | [Botmux core](./2026-10-27-fleet-capacity-feedback-botmux.md) | Revert rejected Task 3; retain accepted Task 1/2; add feedback-only reactions, evidence, projections, v3 consumer, and policy | None |
| 2 | [Proxy and identity](./2026-10-27-fleet-capacity-feedback-proxy.md) | CLIProxyAPI v3 producer plus stable per-bot Proxy credentials and managed wrapper helpers | None until its release task |
| 3 | [Integration and rollout](./2026-10-27-fleet-capacity-feedback-rollout.md) | Manifest composition, full gates, Proxy-first deployment, staged Botmux enablement, final fleet readback | Staged, reversible |

The plans are sequential. Plan 1 freezes the exact v3 consumer schema before Plan 2. Neither Botmux topic nor Proxy producer enters the customization manifest or live runtime before both implementation ranges pass independent review.

### Task 1: Freeze immutable inputs and prove production is unchanged

**Files:**
- Read: `docs/superpowers/specs/2026-10-27-fleet-capacity-feedback-design.md`
- Read: `docs/superpowers/plans/2026-10-27-fleet-capacity-feedback-botmux.md`
- Read: `docs/superpowers/plans/2026-10-27-fleet-capacity-feedback-proxy.md`
- Read: `docs/superpowers/plans/2026-10-27-fleet-capacity-feedback-rollout.md`

- [ ] **Step 1: Record exact starting commits**

Run:

```bash
rtk git -C ~/temp/botmux-capacity-fleet-spec rev-parse HEAD
rtk git -C ~/.aikit/cliproxy/src rev-parse HEAD
rtk git -C ~/aikit/source rev-parse HEAD
rtk git -C ~/project/botmux-custom/wt rev-parse dev
```

Expected: four full SHAs recorded in the implementation handoff; branch names are not review boundaries.

- [ ] **Step 2: Confirm production still lacks this feature**

Run:

```bash
jq '{sha,phase,health}' ~/project/botmux-custom/current-release.json
botmux status --json
aikit cliproxy status --json
```

Expected: Botmux and Proxy are healthy; no capacity-v3 producer, feedback-only candidate, or rollout state is claimed active.

### Task 2: Execute and freeze the Botmux feedback-only subplan

**Files:**
- Follow: `docs/superpowers/plans/2026-10-27-fleet-capacity-feedback-botmux.md`

- [ ] **Step 1: Revert before implementation**

Run Task 0 of the Botmux subplan first. Expected: `418dcf172` is reverted in a new commit; no reset or history rewrite.

- [ ] **Step 2: Pass accepted Task 1/2 regression gates**

Run Task 1 of the Botmux subplan before any new production code. Expected: pure state and exact-turn admission/routing suites pass unchanged.

- [ ] **Step 3: Complete every remaining RED/GREEN task in order**

Expected: each provider, convergence, retention, terminal-integration, evidence, projection, sideband, and policy behavior has a test observed failing for the intended reason before implementation.

- [ ] **Step 4: Freeze the Botmux review range**

Run:

```bash
rtk git -C ~/temp/botmux-capacity-fleet-spec status --short
rtk git -C ~/temp/botmux-capacity-fleet-spec log --oneline dev..HEAD
if rtk rg -n "turn_terminal_persisted|prepare_suspend|turn-feedback-terminal-outbox|terminalRequestId|TurnFeedbackTerminalRecord" \
  ~/temp/botmux-capacity-fleet-spec/src ~/temp/botmux-capacity-fleet-spec/test; then exit 1; fi
```

Expected: clean tree, the revert is visible, accepted Task 1/2 remain, and the forbidden-protocol scan has no matches.

### Task 3: Execute and freeze the Proxy and identity subplan

**Files:**
- Follow: `docs/superpowers/plans/2026-10-27-fleet-capacity-feedback-proxy.md`

- [ ] **Step 1: Complete CLIProxyAPI v3 producer tasks**

Expected: authenticated caller scope maps to one owner app, unsigned owner headers are rejected, and all emitted events validate against the frozen Botmux v3 fixtures.

- [ ] **Step 2: Complete AIKit credential and wrapper tasks**

Expected: stable per-bot keys are mode 0600, managed Proxy wrappers select by `BOTMUX_LARK_APP_ID`, and direct/Relay wrappers remain unchanged.

- [ ] **Step 3: Freeze both review ranges**

Run:

```bash
rtk git -C ~/temp/cliproxy-capacity-fleet status --short
rtk git -C ~/aikit/source status --short
```

Expected: clean trees and exact commits recorded.

### Task 4: Execute integration and staged rollout

**Files:**
- Follow: `docs/superpowers/plans/2026-10-27-fleet-capacity-feedback-rollout.md`

- [ ] **Step 1: Pass all pre-production gates**

Expected: Proxy, AIKit, Botmux topic, manifest composition, full customized candidate, and frozen-upstream comparison pass without new failures. The gate explicitly checks that live terminal commit failure leaves existing lifecycle behavior intact.

- [ ] **Step 2: Deploy in the approved order**

Expected order: Proxy producer ready → Botmux shadow release to full fleet → TraeX projection → Proxy-backed Codex/Claude projection → remaining supported paths → final default-on policy.

- [ ] **Step 3: Stop on the first failed gate**

Use the smallest rollback in the rollout subplan. Do not advance later batches and do not reinterpret an unsupported provider as a successful waiting-path test.

### Task 5: Record final acceptance

**Files:**
- Create: `~/temp/botmux-capacity-feedback-20261027/VERIFICATION.md`

- [ ] **Step 1: Record exact evidence**

The verification file must contain:

```markdown
- Botmux topic/base/final SHAs, including the revert commit
- Proxy base/final SHAs
- AIKit base/final SHAs
- customized dev SHA and release build ID
- focused/full test counts and baseline-equivalent failures
- feedback-only terminal commit failure containment result
- reaction LIST-before-mutate and restart-from-persisted-intent evidence
- 10,000-row retention result
- Proxy signer key ID and epoch (never the private key)
- rollout phase transitions and per-batch bot lists
- waiting, update, clear, terminal, restart, wrong-owner and wrong-attempt evidence
- final fleet process/release/health readback
- rollback artifacts and disabled app × adapter cells
```

- [ ] **Step 2: Verify final acceptance criteria**

Run the exact commands from the rollout subplan. Expected:

- every live Botmux process resolves into the same verified release;
- Dashboard and all configured bot daemons are healthy for 15 seconds;
- supported adapters default on with no pilot allowlist;
- unsupported providers explicitly report unsupported and never synthesize waiting;
- zero confirmed cross-app/session/turn/attempt projections;
- no prompt, answer, raw queue prose, credential, terminal outbox, or terminal effect receipt appears in feedback artifacts;
- restart-recovery evidence starts only after a successful SessionStore feedback or reaction-intent commit.

- [ ] **Step 3: Deliver safe verification evidence**

Do not commit secrets or host-specific raw logs. Commit only safe source/docs references and deliver `VERIFICATION.md` as a Lark attachment.
