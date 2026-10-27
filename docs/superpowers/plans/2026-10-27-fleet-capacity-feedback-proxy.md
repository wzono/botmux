# Fleet Capacity Feedback — Proxy and Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce privacy-minimized `capacity-wait.v3` events whose `owner_app_id` is derived from an authenticated per-bot Proxy credential, and make managed Trae Proxy wrappers select that credential without exposing signer secrets.

**Architecture:** CLIProxyAPI hashes the authenticated caller credential into existing `caller_scope`, maps that irreversible scope to one allowed owner app, and signs queue lifecycle events under an epoch-keyed Ed25519 key. Events are published into owner-specific directories. AIKit owns stable per-bot downstream keys, Proxy config rendering, helper/wrapper selection, and transactional binary/config rollout.

**Tech Stack:** Go, Ed25519, Gin request metadata, filesystem durability, Node.js AIKit, Bash wrappers, Node test runner.

---

## Repositories

- CLIProxyAPI implementation worktree: create `~/temp/cliproxy-capacity-fleet` on `feat/capacity-sideband-v3` from current `~/.aikit/cliproxy/src/main`.
- AIKit source of truth: `~/aikit/source` (not generated wrapper copies).
- Reference only: `~/temp/cliproxy-capacity-sideband@cafb196a` (v2 behavior; do not merge wholesale).

### Task 1: Freeze a shared v3 fixture contract

**Files:**
- Create in CLIProxyAPI: `internal/runtime/executor/helps/testdata/capacity_wait_v3.json`
- Create in Botmux topic: `test/fixtures/capacity-sideband/v3-waiting.json`
- Test in CLIProxyAPI: `internal/runtime/executor/helps/capacity_sideband_test.go`
- Test in Botmux: `test/capacity-sideband-consumer.test.ts`

- [ ] **Step 1: Generate a deterministic fixture keypair in tests**

Use the RFC8032 test seed only inside fixtures/tests. The fixture must contain the unsigned payload, expected JSON bytes, signature, public key, key ID, and epoch. Do not reuse it in runtime configuration.

- [ ] **Step 2: Write failing cross-language tests**

Go signs the canonical unsigned struct; TypeScript verifies the exact bytes. Both tests reject reordered/extra semantic fields by reserializing the typed unsigned event rather than trusting arbitrary JSON object order.

- [ ] **Step 3: Run RED**

```bash
go test ./internal/runtime/executor/helps -run CapacitySidebandV3 -count=1
bun run test -- test/capacity-sideband-consumer.test.ts
```

Expected: v3 fixtures/types are not implemented.

- [ ] **Step 4: Implement only fixture serialization and run GREEN**

Expected: the Go-generated expected bytes and TypeScript verifier agree exactly.

- [ ] **Step 5: Commit both fixture changes in their owning repos**

CLIProxyAPI commit: `test(traecli): 固定 fleet 排队事件协议`. Botmux fixture is committed with Botmux Task 6.

### Task 2: Carry authenticated caller scope to the executor

**Files:**
- Modify: `sdk/api/handlers/handlers.go`
- Modify: `sdk/api/handlers/handlers_metadata_test.go`
- Modify: `sdk/cliproxy/executor/types.go` only if a named metadata key is needed
- Modify: `internal/runtime/executor/traecli_executor.go`
- Modify: `internal/runtime/executor/traecli_executor_test.go`

- [ ] **Step 1: Write failing metadata tests**

Existing authentication stores raw principal as Gin `userApiKey`; `requestExecutionMetadata` already publishes irreversible `caller_scope = SHA256(domain || credential)`. Add tests that the Trae executor sees this scope in `opts.Metadata` on streaming and non-streaming paths and that no raw API key reaches sideband objects/logs.

- [ ] **Step 2: Run RED**

```bash
go test ./sdk/api/handlers ./internal/runtime/executor -run 'CallerScope|CapacitySideband' -count=1
```

Expected: executor owner resolution is absent.

- [ ] **Step 3: Add a named metadata accessor**

Use existing `cliproxyexecutor.CallerScopeMetadataKey`; do not introduce an owner header and do not read Authorization inside the executor. Add a helper that accepts only a 64-character lowercase hex caller scope.

- [ ] **Step 4: Run GREEN and commit**

```bash
go test ./sdk/api/handlers ./internal/runtime/executor -run 'CallerScope|CapacitySideband' -count=1
git add sdk/api/handlers/handlers.go sdk/api/handlers/handlers_metadata_test.go sdk/cliproxy/executor/types.go internal/runtime/executor/traecli_executor.go internal/runtime/executor/traecli_executor_test.go
git commit -m "feat(traecli): 传递认证调用方作用域"
```

### Task 3: Map caller scope to exactly one owner app

**Files:**
- Modify: `internal/config/config_types.go`
- Modify: `config.example.yaml`
- Create: `internal/runtime/executor/helps/capacity_sideband_owner.go`
- Test: `internal/runtime/executor/helps/capacity_sideband_owner_test.go`
- Modify: `internal/runtime/executor/traecli_executor_test.go`

- [ ] **Step 1: Write failing config and resolver tests**

Add configuration entries with no raw credential:

```yaml
trae-cli:
  capacity-sideband:
    root: /var/lib/botmux-capacity
    key-file: /run/secrets/capacity-ed25519-seed
    signer-epoch: 1
    consumer-gid: 1234
    owners:
      - caller-scope: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
        owner-app-id: cli_example
```

Reject duplicate scope, duplicate app, malformed scope/app, empty mapping, caller-provided owner headers, and an authenticated key absent from the mapping.

- [ ] **Step 2: Run RED**

Run: `go test ./internal/runtime/executor/helps ./internal/runtime/executor -run 'CapacitySidebandOwner|CapacitySideband' -count=1`.

- [ ] **Step 3: Implement immutable lookup**

Normalize once at config load/executor creation. Resolution is `caller_scope -> owner_app_id`; a request body/header cannot override it. Missing mapping returns no writer and emits no event, without failing ordinary inference.

- [ ] **Step 4: Run GREEN and commit**

```bash
go test ./internal/runtime/executor/helps ./internal/runtime/executor -run 'CapacitySidebandOwner|CapacitySideband' -count=1
git add internal/config/config_types.go config.example.yaml internal/runtime/executor/helps/capacity_sideband_owner* internal/runtime/executor/traecli_executor_test.go
git commit -m "feat(traecli): 按认证调用方映射机器人"
```

### Task 4: Publish durable owner-scoped v3 events

**Files:**
- Create: `internal/runtime/executor/helps/capacity_sideband.go`
- Create: `internal/runtime/executor/helps/capacity_sideband_dir_unix.go`
- Create: `internal/runtime/executor/helps/capacity_sideband_dir_{windows,bsd}.go`
- Create: `internal/runtime/executor/helps/capacity_sideband_key_linux.go`
- Create: `internal/runtime/executor/helps/capacity_sideband_key_other.go`
- Modify: `internal/runtime/executor/traecli_executor.go`
- Modify: `internal/runtime/executor/traecli_executor_test.go`
- Test: `internal/runtime/executor/helps/capacity_sideband_test.go`

- [ ] **Step 1: Write failing durability/lifecycle tests**

Cover streaming/non-streaming `request_wait_in_queue`, clear on next non-queue event, terminal on done, privacy, owner subdirectory, mode/GID, atomic rename/fsync, process and cross-process sequence lock, one global signed sequence cursor per signer key + epoch across every owner, signer epoch, key ID, queue dedupe, and exact Codex/Claude native join. Two concurrent owners must receive distinct monotonically increasing sequence values.

- [ ] **Step 2: Run RED**

```bash
go test ./internal/runtime/executor/helps ./internal/runtime/executor -run CapacitySideband -count=1
```

- [ ] **Step 3: Implement v3 writer**

Publish to `capacityRoot/owners/owner_app_id/events`, where both values have already passed their strict validators. The filename contains time/sequence/random ID only. The signer cursor and its cross-process lock live at the trusted capacity root, not inside an owner directory, so `signer_key_id + signer_epoch + sequence` is globally monotonic. Event/cursor mode 0640; pinned directory/lock operations are no-follow. Unsupported platforms compile but fail closed when sideband is configured.

- [ ] **Step 4: Race/repetition GREEN**

```bash
go test -race ./internal/runtime/executor/helps ./internal/runtime/executor -run CapacitySideband -count=1
go test ./internal/runtime/executor/helps ./internal/runtime/executor -run CapacitySideband -count=5
```

- [ ] **Step 5: Commit**

```bash
git add internal/runtime/executor/helps/capacity_sideband* internal/runtime/executor/traecli_executor.go internal/runtime/executor/traecli_executor_test.go
git commit -m "feat(traecli): 发布 fleet 签名排队事件"
```

### Task 5: Verify CLIProxyAPI

**Files:**
- Verify: `sdk/api/handlers/handlers_metadata_test.go`
- Verify: `internal/runtime/executor/helps/capacity_sideband_test.go`
- Verify: `internal/runtime/executor/traecli_executor_test.go`

- [ ] **Step 1: Run focused and race gates**

```bash
go test ./sdk/api/handlers ./internal/runtime/executor/helps ./internal/runtime/executor -run 'CallerScope|CapacitySideband' -count=1
go test -race ./internal/runtime/executor/helps ./internal/runtime/executor -run CapacitySideband -count=1
go vet ./...
go build ./cmd/server
```

- [ ] **Step 2: Compile supported targets**

```bash
GOOS=linux GOARCH=amd64 go build ./cmd/server
GOOS=darwin GOARCH=arm64 go test ./internal/runtime/executor/helps -run '^$'
GOOS=freebsd GOARCH=amd64 go test ./internal/runtime/executor/helps -run '^$'
GOOS=windows GOARCH=amd64 go test ./internal/runtime/executor/helps -run '^$'
```

Expected: all exit 0; sideband remains explicitly unsupported outside the pinned Unix implementation where required.

- [ ] **Step 3: Independent security review**

Review base..HEAD for caller spoofing, path traversal/symlink races, private-key ownership, replay/rotation, prompt/output leakage, and non-sideband inference regressions. Fix blockers with new tests.

### Task 6: Generate stable per-bot Proxy credentials in AIKit

**Files:**
- Modify: `~/aikit/source/lib/cliproxy.js`
- Modify: `~/aikit/source/manifests/cliproxy/config.template.yaml`
- Modify: `~/aikit/source/test/cliproxy.test.js`

- [ ] **Step 1: Write failing credential rendering tests**

Given a fleet app list, generate one 0600 file per Proxy-backed app at `join(stateDir, "bot-keys", validatedAppId)`. Re-running preserves existing keys. Removed bots stay as disabled/grace entries until explicit cleanup. Render API keys plus only SHA256 caller scopes and app IDs into Proxy owner mapping; never render raw keys into owner mapping/logs/results.

- [ ] **Step 2: Run RED**

Run: `node --test test/cliproxy.test.js` in `~/aikit/source`.

- [ ] **Step 3: Implement helpers**

Export pure `callerScope(key)`, `reconcileBotProxyKeys(paths, appIds)`, and config rendering. Use domain exactly `cli-proxy-api:caller-scope:v1\0` to match Go. Regenerate `claude-api-key-helper.sh` so a Botmux process with `BOTMUX_LARK_APP_ID` selects its per-bot key; a non-Botmux interactive Claude session may retain the legacy shared-key fallback.

- [ ] **Step 4: Run GREEN and commit**

```bash
node --test test/cliproxy.test.js
git add lib/cliproxy.js manifests/cliproxy/config.template.yaml test/cliproxy.test.js
git commit -m "feat(cliproxy): 生成机器人独立访问凭证"
```

### Task 7: Select per-bot keys in managed wrappers

**Files:**
- Create: `~/aikit/source/assets/botmux/bin/trae-proxy-api-key`
- Modify: `~/aikit/source/assets/botmux/bin/codex-trae-{max,xhigh,ultra}`
- Modify: `~/aikit/source/assets/botmux/bin/claude-trae-max`
- Modify: `~/aikit/source/lib/botmux-wrappers.js`
- Modify: `~/aikit/source/test/botmux-wrappers.test.js`
- Modify: `~/aikit/source/test/botmux-wrapper-sync.test.js`

- [ ] **Step 1: Write failing wrapper tests**

With `BOTMUX_LARK_APP_ID=cli_a`, helpers read only `state/bot-keys/cli_a`; invalid app IDs fail; missing managed key fails closed for Trae Proxy wrappers; direct Codex/Claude/Relay wrappers remain unchanged. `claude-trae-max` sets `BOTMUX_PROXY_KEY_REQUIRED=1`; the generated global Claude helper sees the inherited app ID and calls the managed selector. A non-Botmux Claude process without that required flag keeps the legacy shared-key fallback.

- [ ] **Step 2: Run RED**

```bash
node --test test/botmux-wrappers.test.js test/botmux-wrapper-sync.test.js
```

- [ ] **Step 3: Implement selector and wrapper changes**

The selector prints only the key to stdout; diagnostics contain app ID/path but never key bytes. Wrapper sync remains transactional with backup and rollback.

- [ ] **Step 4: Run GREEN and commit**

```bash
node --test test/botmux-wrappers.test.js test/botmux-wrapper-sync.test.js
git add assets/botmux/bin lib/botmux-wrappers.js test/botmux-wrappers.test.js test/botmux-wrapper-sync.test.js
git commit -m "feat(botmux): 按机器人选择代理凭证"
```

### Task 8: Add transactional Proxy prepare/activate/rollback

**Files:**
- Modify: `~/aikit/source/lib/cliproxy.js`
- Modify: `~/aikit/source/test/cliproxy.test.js`
- Modify: `~/aikit/source/bin/aikit.js` only if command routing is not data-driven

- [ ] **Step 1: Write failing transaction tests**

Prepare must build candidate binary/config/keys without touching live files. Activate snapshots binary/config/key manifest/PM2 state, validates candidate health and signed v3 smoke, performs one Proxy restart, then verifies health/models. Any failure restores exact prior files/modes and restarts old binary. Crash journal remains recoverable.

- [ ] **Step 2: Run RED**

Run: `node --test test/cliproxy.test.js`.

- [ ] **Step 3: Implement prepare/activate/rollback**

Expose `aikit cliproxy prepare`, `activate /absolute/candidate-dir`, and `rollback /absolute/deployment-dir`. Do not replace the live binary in place before candidate validation.

- [ ] **Step 4: Run GREEN and commit**

```bash
node --test test/cliproxy.test.js
git add lib/cliproxy.js test/cliproxy.test.js bin/aikit.js
git commit -m "feat(cliproxy): 增加事务式发布回滚"
```

### Task 9: Final Proxy/AIKit verification

**Files:**
- Verify: `~/aikit/source/test/cliproxy.test.js`
- Verify: `~/aikit/source/test/botmux-wrappers.test.js`
- Verify: `~/aikit/source/test/botmux-wrapper-sync.test.js`

- [ ] **Step 1: Run AIKit gates**

```bash
node --test test/cliproxy.test.js test/botmux-wrappers.test.js test/botmux-wrapper-sync.test.js
aikit doctor
npm audit --omit=dev
```

- [ ] **Step 2: Build candidate without activating**

Run `aikit cliproxy prepare --source ~/temp/cliproxy-capacity-fleet`.
Expected: candidate path + hashes; live binary/config/PM2 PID and port 8317 unchanged.

- [ ] **Step 3: Cross-language smoke**

Feed candidate Proxy a synthetic queue lifecycle under two distinct test keys. Verify events land only in the matching owner dirs and Botmux fixture verifier accepts both; unknown/shared key emits no event. Delete synthetic events afterward using exact test paths.

- [ ] **Step 4: Freeze commits and independent review**

Record clean CLIProxyAPI and AIKit SHAs. Do not activate Proxy in this subplan; activation belongs to the rollout plan.
