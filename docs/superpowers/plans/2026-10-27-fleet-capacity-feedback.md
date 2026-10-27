# Fleet Capacity Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship trustworthy capacity-wait feedback in the customized Botmux `dev` release for every fleet bot, using authoritative TraeX observations or authenticated Proxy sideband without cross-bot attribution.

**Architecture:** Work is split into three independently testable subplans: Botmux owns the durable turn state and projections; CLIProxyAPI + AIKit own authenticated per-bot request attribution and signed `capacity-wait.v3` events; host customization metadata owns topic composition, regression gates, staged rollout, and rollback. All bots receive one release, while rollout policy controls when each authoritative adapter begins projecting user-visible waiting state.

**Tech Stack:** TypeScript, Bun, Vitest, Go, Ed25519, filesystem durability, AIKit Node.js tooling, Botmux customization manifest, systemd, PM2.

---

## Plan map

| Order | Plan | Deliverable | Production effect |
|---|---|---|---|
| 1 | [Botmux core](./2026-10-27-fleet-capacity-feedback-botmux.md) | Clean `topic/capacity-wait-feedback` with durable state, TraeX evidence, v3 consumer, projections, rollout policy | None |
| 2 | [Proxy and identity](./2026-10-27-fleet-capacity-feedback-proxy.md) | CLIProxyAPI v3 producer plus stable per-bot Proxy credentials and managed wrapper helpers | None until its release task |
| 3 | [Integration and rollout](./2026-10-27-fleet-capacity-feedback-rollout.md) | Manifest composition, full gates, Proxy-first deployment, staged Botmux enablement, final 29/29 readback | Staged, reversible |

The plans are sequential. Do not start Plan 2 before Plan 1 has frozen the exact v3 consumer schema. Do not add the Botmux topic to the customization manifest or mutate runtime configuration before Plans 1 and 2 both pass independent review.

### Task 1: Freeze immutable inputs

**Files:**
- Read: `docs/superpowers/specs/2026-10-27-fleet-capacity-feedback-design.md`
- Read: `docs/superpowers/plans/2026-10-27-fleet-capacity-feedback-botmux.md`
- Read: `docs/superpowers/plans/2026-10-27-fleet-capacity-feedback-proxy.md`
- Read: `docs/superpowers/plans/2026-10-27-fleet-capacity-feedback-rollout.md`

- [ ] **Step 1: Record exact starting commits**

Run:

```bash
git -C ~/temp/botmux-capacity-fleet-spec rev-parse HEAD
git -C ~/.aikit/cliproxy/src rev-parse HEAD
git -C ~/aikit/source rev-parse HEAD
git -C ~/project/botmux-custom/wt rev-parse dev
```

Expected: four full SHAs. Save them in the implementation handoff; do not substitute branch names for immutable review ranges.

- [ ] **Step 2: Confirm production is still on the pre-feature release**

Run:

```bash
jq '{sha,phase,health}' ~/project/botmux-custom/current-release.json
botmux status --json
aikit cliproxy status --json
```

Expected: Botmux and Proxy are healthy; no capacity-v3 producer or rollout state is claimed active.

### Task 2: Execute the Botmux subplan

**Files:**
- Follow: `docs/superpowers/plans/2026-10-27-fleet-capacity-feedback-botmux.md`

- [ ] **Step 1: Complete every RED/GREEN task in order**

Expected: each production behavior has a test that was observed failing for the intended reason before its implementation.

- [ ] **Step 2: Freeze the Botmux review range**

Run:

```bash
git -C ~/temp/botmux-capacity-fleet-spec status --short
git -C ~/temp/botmux-capacity-fleet-spec log --oneline dev..HEAD
```

Expected: clean tree; only capacity-feedback commits above `dev`.

### Task 3: Execute the Proxy and identity subplan

**Files:**
- Follow: `docs/superpowers/plans/2026-10-27-fleet-capacity-feedback-proxy.md`

- [ ] **Step 1: Complete CLIProxyAPI v3 producer tasks**

Expected: authenticated caller scope maps to one owner app, unsigned owner headers are rejected, and all emitted events validate against the Botmux v3 fixtures.

- [ ] **Step 2: Complete AIKit credential and wrapper tasks**

Expected: stable per-bot keys are generated with mode 0600, managed Proxy wrappers select by `BOTMUX_LARK_APP_ID`, and direct/Relay wrappers remain unchanged.

- [ ] **Step 3: Freeze both review ranges**

Run:

```bash
git -C ~/temp/cliproxy-capacity-fleet status --short
git -C ~/aikit/source status --short
```

Expected: clean trees and exact commits recorded.

### Task 4: Execute integration and staged rollout

**Files:**
- Follow: `docs/superpowers/plans/2026-10-27-fleet-capacity-feedback-rollout.md`

- [ ] **Step 1: Pass all pre-production gates**

Expected: Proxy, AIKit, Botmux topic, manifest composition, full customized candidate, and frozen-upstream comparison all pass without new failures.

- [ ] **Step 2: Deploy in the approved order**

Expected order: Proxy producer ready → Botmux shadow release to full fleet → TraeX projection → Proxy-backed Codex/Claude projection → remaining supported paths → final default-on policy.

- [ ] **Step 3: Stop on the first failed gate**

If a batch fails, use the smallest rollback defined in the rollout plan. Do not advance later batches, and do not reinterpret an unsupported provider as a successful waiting-path test.

### Task 5: Final acceptance

**Files:**
- Create: `~/temp/botmux-capacity-feedback-20261027/VERIFICATION.md`

- [ ] **Step 1: Record exact evidence**

The verification file must include:

```markdown
- Botmux topic/base/final SHAs
- Proxy base/final SHAs
- AIKit base/final SHAs
- customized dev SHA and release build ID
- focused/full test counts and baseline-equivalent failures
- Proxy signer key ID and epoch (never the private key)
- rollout phase transitions and per-batch bot lists
- explicit waiting, update, clear, terminal, restart, wrong-owner and wrong-attempt evidence
- final fleet process/release/health readback
- rollback artifacts and any disabled app × adapter cells
```

- [ ] **Step 2: Verify final acceptance criteria**

Run the exact commands from the rollout subplan. Expected:

- every live Botmux process resolves into the same verified release;
- Dashboard and all configured bot daemons are healthy for 15 seconds;
- supported adapters default on with no pilot allowlist;
- unsupported providers explicitly report unsupported and never synthesize waiting;
- zero confirmed cross-app/session/turn/attempt projections;
- no prompt, answer, raw queue prose, or credential appears in sideband/audit records.

- [ ] **Step 3: Commit documentation-only verification references**

Do not commit secrets or host-specific raw logs. Commit only safe source/docs changes required by the subplans; deliver `VERIFICATION.md` as a Lark attachment.
