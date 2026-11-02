# Trae Proxy Route Sync and Adaptive Probes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every routable TraeX catalog model available through Trae Proxy with guarded reconciliation, and collect explicitly separated adaptive probe samples for low-traffic models.

**Architecture:** The model-status plugin owns catalog intent and probe scheduling. AIKit owns deterministic structural merging of a machine-private managed catalog with version-controlled manual aliases. CLIProxyAPI carries an authenticated probe or validation marker into usage records without forwarding it upstream. Every production route change is candidate-tested on an isolated port and applied by a rollback-capable external service.

**Tech Stack:** JavaScript and Bun SQLite in the plugin; Node.js and node:test in AIKit; Go in CLIProxyAPI; structural YAML parsing; transient user systemd services for guarded activation.

---

## Repository map and ownership

- Plugin repository: /home/zhongweijie.x/dev/trae-model-status after read-only plan Task 1.
- AIKit implementation workspace: /home/zhongweijie.x/temp/aikit-trae-proxy-managed-models on branch feat/trae-proxy-managed-models, created from the then-current /home/zhongweijie.x/aikit dev commit after fetching. Preserve unrelated changes in the shared checkout.
- Proxy implementation workspace: /home/zhongweijie.x/temp/cliproxy-trae-proxy-catalog on branch feat/trae-proxy-catalog-sync, created from feat/trae-model-status-usage after committing or otherwise preserving that branch's already-reviewed usage work. Do not implement on the currently dirty worktree.
- Botmux is read-only in this plan except for consuming the already reviewed Dashboard bridge.
- Production starts with routeSyncMode=observe and probeMode=off.

## Task 1: Define a managed model catalog contract in AIKit

**Files:**
- Modify: /home/zhongweijie.x/aikit/lib/cliproxy.js
- Modify: /home/zhongweijie.x/aikit/test/cliproxy.test.js
- Modify: /home/zhongweijie.x/aikit/package.json
- Modify: /home/zhongweijie.x/aikit/package-lock.json
- Create: /home/zhongweijie.x/aikit/source/playbooks/cliproxy-managed-models.md

- [ ] **Step 1: Write the failing merge tests**

Add table-driven tests for these required pure functions:

~~~js
mergeTraeModels({ templateModels, managedModels, localModels })
readManagedCatalog(path)
~~~

Cover managed append, manual-alias priority, local override priority, duplicate aliases, malformed schema, invalid lifecycle, unsafe strings, non-0600 mode, absent managed file, and two consecutive idempotent compiles.

- [ ] **Step 2: Run RED**

Run: node --test test/cliproxy.test.js

Expected: FAIL because managed catalogs and structural model merging are absent.

- [ ] **Step 3: Add one pinned YAML dependency**

Use a maintained YAML parser in package.json and package-lock.json. Keep all YAML reads and writes inside lib/cliproxy.js. Do not extend parseSimpleYaml for nested arrays.

- [ ] **Step 4: Implement managed schema parsing**

The file ~/.aikit/cliproxy/managed/catalog-models.json has mode 0600 and this shape:

~~~json
{
  "schemaVersion": 1,
  "catalogHash": "64 lowercase hex",
  "generatedAt": "ISO-8601",
  "models": [
    {
      "id": "gpt-6-astra",
      "name": "GPT-6 Astra",
      "alias": "gpt-6-astra",
      "modelName": "gpt-6-astra__max",
      "contextWindow": 800000,
      "lifecycle": "available"
    }
  ]
}
~~~

Only available and new become active Proxy routes. Other lifecycle states remain persisted but unadvertised.

- [ ] **Step 5: Implement structural merge and atomic config output**

Extend cliproxyPaths with managedDir, managedCatalogPath, and managedCatalogPreviousPath. Parse template and local YAML structurally, merge template/manual aliases, managed direct routes, then explicit local model overrides. Manual alias wins on conflict. Write a 0600 temporary config, parse it again, then atomic rename.

- [ ] **Step 6: Run GREEN and full AIKit gate**

Run:

~~~bash
node --test test/cliproxy.test.js
npm test
~~~

Expected: focused tests and AIKit doctor pass.

- [ ] **Step 7: Commit**

~~~bash
git add package.json package-lock.json lib/cliproxy.js test/cliproxy.test.js source/playbooks/cliproxy-managed-models.md
git commit -m "feat(cliproxy): 合并受管 Trae 模型目录"
~~~

## Task 2: Carry probe identity through CLIProxyAPI usage safely

**Files in a fresh Proxy worktree:**
- Modify: sdk/cliproxy/executor/types.go
- Modify: sdk/cliproxy/usage/manager.go
- Modify: internal/runtime/executor/helps/usage_helpers.go
- Modify: internal/api/server_routes.go
- Create: internal/api/probe_sample.go
- Create: internal/api/probe_sample_test.go
- Modify: sdk/api/handlers/handlers.go
- Modify: sdk/api/handlers/handlers_metadata_test.go
- Modify: sdk/cliproxy/auth/conductor_execution.go
- Modify: sdk/cliproxy/auth/conductor_usage_test.go
- Modify: examples/plugin/usage-http/go/main.go
- Modify: examples/plugin/usage-http/go/main_test.go
- Modify: internal/runtime/executor/helps/usage_helpers_test.go
- Add focused tests beside the common HTTP seam

- [ ] **Step 1: Write failing usage-record tests**

Define SampleSourceNatural, SampleSourceProbe, and SampleSourceValidation. Add SampleSource and ProbeRunID to usage.Record. Assert natural is default and existing Record.Source remains credential identity.

- [ ] **Step 2: Write failing authenticated marker tests**

Use these local-only headers:

~~~text
X-Botmux-Sample-Source: probe | validation
X-Botmux-Probe-Run-Id: 16-64 characters from A-Za-z0-9._-
~~~

Prove only a loopback POST /v1/chat/completions request that passed normal API-key authentication may set them. Invalid enum/id, remote source, or unauthenticated use fails before execution. Both headers are stripped before the OpenAI handler. Requests without markers in every protocol retain natural semantics.

- [ ] **Step 3: Run RED**

Run the new usage and HTTP metadata tests. Expected: FAIL because sample source context does not exist.

- [ ] **Step 4: Implement context helpers and reporter propagation**

Add SampleSourceMetadataKey and ProbeRunIDMetadataKey in sdk/cliproxy/executor/types.go. Implement probeSampleMiddleware in internal/api/probe_sample.go and attach it to the authenticated v1 group immediately after AuthMiddleware. It validates loopback and headers, strips both headers, and stores the values in Gin context. requestExecutionMetadata in sdk/api/handlers/handlers.go copies only validated values into executor Options.Metadata. contextWithRequestedModelAlias in sdk/cliproxy/auth/conductor_execution.go translates those metadata keys through new WithSampleSource, SampleSourceFromContext, WithProbeRunID, and ProbeRunIDFromContext helpers in the usage package. UsageReporter reads the independent context fields and publishes them.

- [ ] **Step 5: Extend the usage sink payload**

The only new payload keys are sampleSource and probeRunId. Normalize absent source to natural. Never send credential Source, APIKey, AuthID, raw headers, or prompts.

- [ ] **Step 6: Run GREEN and compile**

~~~bash
gofmt -w sdk/cliproxy internal/runtime/executor/helps examples/plugin/usage-http/go
go test ./sdk/cliproxy/usage -count=1
go test ./internal/runtime/executor/helps -count=1
go test ./examples/plugin/usage-http/go -count=1
go test ./internal/runtime/executor -run 'TestTraeCLIExecutor(PublishesNonStreamUsage|StreamingTTFTExcludesQueueStatus)$' -count=1
go build -o test-output ./cmd/server && rm test-output
~~~

Expected: focused tests pass. Record but do not absorb the existing platform-fingerprint failures and existing Trae stream-header failure.

- [ ] **Step 7: Commit**

~~~bash
git add sdk/cliproxy internal/api/probe_sample.go internal/api/probe_sample_test.go internal/api/server_routes.go sdk/api/handlers/handlers.go sdk/api/handlers/handlers_metadata_test.go internal/runtime/executor/helps examples/plugin/usage-http/go
git commit -m "feat(usage): 区分自然流量与模型探针"
~~~

## Task 3: Migrate observations and expose separated statistics

**Files in the plugin repository:**
- Modify: src/service/observations.js
- Modify: src/service/server.js
- Modify: test/observations.test.js
- Modify: test/server.test.js

- [ ] **Step 1: Write failing migration tests**

Open a legacy database and require atomic addition of sample_source TEXT NOT NULL DEFAULT natural and probe_run_id TEXT. Existing rows read as natural. Invalid enum, malformed run id, secret fields, and probe or validation without a run id are rejected.

- [ ] **Step 2: Write failing aggregation tests**

For 24h and 7d, assert separate natural, probe, and validation buckets with count, valid TTFT count, failures, failure rate, tokens, last success, P25, and P95. Assert confidence rules exactly match the approved spec.

- [ ] **Step 3: Run RED**

Run: bun test test/observations.test.js test/server.test.js

Expected: FAIL because schema and buckets are absent.

- [ ] **Step 4: Implement transactional migration and aggregation**

Use PRAGMA table_info in one transaction and add a schema-version table. Do not rewrite or delete old records. Extend /internal/usage allowlist only with sampleSource and probeRunId.

- [ ] **Step 5: Run GREEN and commit**

~~~bash
bun test test/observations.test.js test/server.test.js
bun test
git add src/service/observations.js src/service/server.js test
git commit -m "feat(samples): 分离自然与探针统计"
~~~

## Task 4: Build the adaptive probe scheduler

**Files in the plugin repository:**
- Create: src/service/probe-scheduler.js
- Create: src/service/probe-client.js
- Modify: src/service/server.js
- Create: test/probe-scheduler.test.js
- Create: test/probe-client.test.js
- Create: src/server/settings.js

- [ ] **Step 1: Write failing scheduler tests with a fake clock**

Prove global concurrency 1, 60-second global gap, 10-minute/60-minute/6-hour sample tiers, new-model priority, fair rotation, load threshold 120, degraded-state pauses, 15m/30m/1h/6h backoff, success reset, per-model daily cap 20, global daily cap 240, and persistence across restart.

- [ ] **Step 2: Write failing probe-client tests**

Against a fake Proxy, assert one minimal streaming /v1/chat/completions request, both marker headers, API key loaded from the existing 0600 file, no user context, no tools, no retry, bounded/redacted errors, first-semantic-content abort, and 60-second timeout.

- [ ] **Step 3: Run RED**

Run both new test files. Expected: FAIL because scheduler/client are absent.

- [ ] **Step 4: Implement scheduler and client**

Use fixed prompt requesting one token OK. Generate a random run id without user/model data. Store scheduler state in SQLite. Start with probeMode=off. Expose mode, budget used, paused reason, next eligible model/time, and recent outcomes in snapshot.

- [ ] **Step 5: Run GREEN and commit**

~~~bash
bun test test/probe-scheduler.test.js test/probe-client.test.js test/observations.test.js test/server.test.js
bun test
git add src/service src/server test
git commit -m "feat(probe): 自适应补齐低频模型样本"
~~~

## Task 5: Generate managed route intent from catalog state

**Files in the plugin repository:**
- Create: src/service/managed-routes.js
- Modify: src/service/catalog-reconciler.js
- Modify: src/service/server.js
- Create: test/managed-routes.test.js

- [ ] **Step 1: Write failing deterministic projection tests**

Cover max-before-standard selection, unmapped backend, manual collision, inactive lifecycles, stable ordering/hash, optional context window, and manual-alias snapshot hash.

- [ ] **Step 2: Run RED**

Run: bun test test/managed-routes.test.js

Expected: FAIL because route intent is absent.

- [ ] **Step 3: Implement observe-only atomic intent output**

Write only ~/.aikit/cliproxy/managed/catalog-models.next.json. Include schema, catalog hash, manual alias hash, generation time, active routes, inactive entries, and conflicts. The plugin must not replace catalog-models.json in observe mode.

- [ ] **Step 4: Run GREEN and commit**

~~~bash
bun test test/managed-routes.test.js test/catalog-reconciler.test.js
bun test
git add src/service test
git commit -m "feat(routes): 生成受管模型候选"
~~~

## Task 6: Implement the isolated route-apply guardian

**Files in AIKit:**
- Create: lib/cliproxy-managed-apply.js
- Modify: lib/aikit.js
- Modify: test/cliproxy.test.js
- Create: test/cliproxy-managed-apply.test.js
- Modify: source/playbooks/cliproxy-managed-models.md

- [ ] **Step 1: Write failing phase-injection tests**

Use fake file/process/HTTP/service adapters. Cover lock, intent hash validation, candidate render, isolated-port start, health/models/new-call validation, rollback snapshot, managed-file replace, single Proxy restart, production validation, disarm, and result record. Inject failure at every phase and assert restoration.

- [ ] **Step 2: Run RED**

Run: node --test test/cliproxy-managed-apply.test.js

Expected: FAIL because the apply engine is absent.

- [ ] **Step 3: Implement the dependency-injected engine**

Core logic may not shell directly. Persist JSON journal before each mutation. Refuse stale catalog/manual hashes, concurrent lock, missing rollback snapshot, or stale intent.

- [ ] **Step 4: Add explicit CLI commands**

Expose read-only managed plan and managed status; require --yes for managed apply and managed rollback. Apply and rollback run in a transient independent user systemd service so caller shutdown cannot interrupt rollback.

- [ ] **Step 5: Verify a real plan without applying**

Run managed plan on ~/.aikit/cliproxy/managed/catalog-models.next.json. Expected: candidate config, model diff, aliases, hashes, and validation commands; Proxy PID/config unchanged.

- [ ] **Step 6: Run GREEN and commit**

~~~bash
node --test test/cliproxy.test.js test/cliproxy-managed-apply.test.js
npm test
git add lib test source/playbooks
git commit -m "feat(cliproxy): 守护受管模型切换"
~~~

## Task 7: Apply in two gated checkpoints

**Files:**
- Plugin private settings and next intent
- AIKit journal and rollback snapshots
- Verification record: ~/temp/trae-proxy-route-sync-20261026/VERIFICATION.md

- [ ] **Step 1: Independent pre-apply comparison**

Compare TraeX catalog, current Proxy routes, manual aliases, and candidate managed routes. Require zero unexplained diff.

- [ ] **Step 2: Checkpoint A — enable route apply with probes off**

Run managed apply through the independent service. Verify health, exact direct-route coverage, manual aliases, usage sink, plugin health, PID transition, and rollback journal. probeMode remains off.

- [ ] **Step 3: Observe two catalog cycles and real new-route calls**

Require two successful 30-second catalogs and one real call to every newly opened route. Catalog errors cannot increment missing counts.

- [ ] **Step 4: Checkpoint B — enable adaptive probes**

Set probeMode=adaptive through private settings. Verify one probe record end-to-end and one natural request remains natural. Verify concurrency, budget, load pause, and Dashboard counters.

- [ ] **Step 5: Independent review and immutable record**

Record exact commits, binary/config/catalog hashes, route diff, settings, tests, service logs, and rollback command. No Critical/Important finding may remain.
