# Trae Proxy Dashboard Read-only Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the standalone 9362 web page with a pinned, auto-refreshing Trae Proxy plugin page inside Botmux Dashboard while keeping 9362 as a loopback-only read/control service.

**Architecture:** Botmux gains one generic, manifest-allowlisted same-origin bridge from an authenticated plugin Dashboard to its own loopback service. The Trae model-status plugin uses that bridge to render a full React Dashboard and to persist catalog lifecycle in observe-only mode. No Proxy routes, production processes, or Feishu cards change in this phase.

**Tech Stack:** TypeScript/React/Vitest/Bun in Botmux; JavaScript/Bun SQLite/Bun test in the plugin; Botmux plugin conventions and built-in plugin supervisor.

---

## Repository map and ownership

- Botmux topic branch: `feat/trae-proxy-dashboard` in `/home/zhongweijie.x/temp/botmux-trae-proxy-dashboard`.
- Plugin source of truth: create private repository `zhongweijie.x/trae-model-status` and local checkout `/home/zhongweijie.x/dev/trae-model-status` from the current temp plugin source.
- Existing runtime data remains under `~/.botmux/plugins/trae-model-status/`; do not copy `usage.sqlite*` into Git.
- This phase must not edit `~/.aikit/cliproxy/local.yaml`, the Proxy binary, or the Proxy worktree.

## Task 1: Establish the plugin repository without changing runtime

**Files:**
- Source: `/home/zhongweijie.x/temp/trae-load-discovery-20261021/botmux-plugin-trae-model-status/**`
- Create repository: `zhongweijie.x/trae-model-status`
- Create checkout: `/home/zhongweijie.x/dev/trae-model-status/**`
- Create: `.gitignore`

- [ ] **Step 1: Record the current plugin artifact and tests**

Run:

```bash
cd /home/zhongweijie.x/temp/trae-load-discovery-20261021/botmux-plugin-trae-model-status
sha256sum package.json src/**/*.js src/**/*.json | sort
bun test
node scripts/validate.mjs
```

Expected: 21 tests pass and 9 runtime files validate. Save the hash list under `~/temp/trae-model-status-repo-bootstrap/source.sha256`.

- [ ] **Step 2: Create the private Codebase repository after a dry-run**

Run `bytedcli codebase namespace list` or `repo list --query trae-model-status` first. If the repository is absent, dry-run `bytedcli codebase repo create --namespace zhongweijie.x --name trae-model-status --description "Botmux Trae Proxy model status plugin"`, inspect the target, then execute the same command with `--execute --confirm zhongweijie.x/trae-model-status`. Do not create a second repository if one already exists.

Expected: repository path `zhongweijie.x/trae-model-status` exists and is private/internal; obtain the deployment-specific URL from Codebase at runtime.

- [ ] **Step 3: Copy only source-controlled plugin files**

Create the checkout and copy `package.json`, `src/`, `test/`, `scripts/`, and `README.md`. Use structured edits for text; do not copy `dist/`, SQLite files, tokens, runtime state, or preview artifacts.

Add this exact ignore policy:

```gitignore
dist/
node_modules/
*.sqlite
*.sqlite-shm
*.sqlite-wal
*.token
card-preview*.png
```

- [ ] **Step 4: Verify the migrated source reproduces the baseline**

Run:

```bash
bun test
node scripts/build.mjs
node scripts/validate.mjs
```

Expected: 21 tests pass; build and validation pass; `git status --short` contains only intended source files.

- [ ] **Step 5: Commit and push the repository baseline**

```bash
git add .gitignore README.md package.json src test scripts
git commit -m "chore: 建立 Trae 模型状态插件正本"
git push -u origin main
```

## Task 2: Add a manifest-allowlisted plugin service bridge to Botmux

**Files:**
- Modify: `src/core/plugins/types.ts`
- Modify: `src/core/plugins/convention-scanner.ts`
- Modify: `src/core/plugins/materializer.ts`
- Create: `src/core/plugins/dashboard-service-bridge.ts`
- Modify: `src/dashboard.ts`
- Modify: `src/dashboard/web/plugin-page.tsx`
- Modify: `test/plugin-manifest-store.test.ts`
- Create: `test/dashboard-plugin-service-bridge.test.ts`

- [ ] **Step 1: Write the failing contribution-scanner test**

Add a fixture file `service-http/index.json` with:

```json
{
  "schemaVersion": 1,
  "routes": [
    { "method": "GET", "path": "/api/snapshot" },
    { "method": "POST", "path": "/api/refresh" }
  ]
}
```

Assert `scanPluginContributions()` and `materializePlugin()` preserve the two routes. Add negative cases for a non-loopback URL field, `..`, query strings, duplicate routes, unsupported methods, missing service, and more than 16 routes.

Run:

```bash
bunx vitest run --project unit test/plugin-manifest-store.test.ts
```

Expected: FAIL because `serviceHttp` is absent.

- [ ] **Step 2: Implement the public contribution types and scanner**

Add these types:

```ts
export interface PluginServiceHttpRoute {
  method: 'GET' | 'POST';
  path: string;
}

export interface PluginServiceHttpContribution {
  schemaVersion: 1;
  routes: PluginServiceHttpRoute[];
}
```

Add optional `serviceHttp` to `PluginContributions` and `PluginMaterializedFile`. Scan only the fixed `service-http/index.json` path. Require a service contribution and validate relative absolute-path syntax with the same traversal discipline as card actions.

- [ ] **Step 3: Make the scanner test green and commit**

Run the test from Step 1. Expected: PASS.

```bash
git add src/core/plugins/types.ts src/core/plugins/convention-scanner.ts src/core/plugins/materializer.ts test/plugin-manifest-store.test.ts
git commit -m "feat(plugin): 声明 Dashboard 服务路由白名单"
```

- [ ] **Step 4: Write failing bridge behavior tests**

Test an exported `proxyPluginDashboardServiceRequest()` with a real local HTTP fixture. Required cases:

- authenticated GET to an allowlisted path returns parsed JSON;
- authenticated POST forwards JSON body and content-type;
- path not allowlisted returns `route_not_allowed` without opening a socket;
- redirect, non-JSON, response above 1 MiB, timeout above 3 seconds, and offline service fail closed;
- browser cookie, Authorization, forwarded headers, and arbitrary headers never reach the fixture;
- service state host must be loopback and port must be numeric;
- request path cannot contain query, fragment, backslash, encoded traversal, or a second origin.

Run:

```bash
bunx vitest run --project unit test/dashboard-plugin-service-bridge.test.ts
```

Expected: FAIL because the bridge module does not exist.

- [ ] **Step 5: Implement the bridge as a small isolated module**

Export:

```ts
export interface PluginDashboardServiceRequest {
  pluginId: string;
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

export async function proxyPluginDashboardServiceRequest(
  input: PluginDashboardServiceRequest,
  deps: {
    record: InstalledPluginRecord;
    state: PluginServiceState | undefined;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    maxBytes?: number;
  },
): Promise<unknown>;
```

Build the target from the supervisor-owned numeric port and `http://127.0.0.1`; never trust `openUrl`. Use `redirect: 'error'`, an AbortController timeout, a bounded reader, and `accept/application-json` only.

- [ ] **Step 6: Expose the authenticated Dashboard endpoint and browser API**

Add `POST /api/plugins/:id/service-request` inside the existing authenticated plugin management API. The request body is exactly:

```json
{ "method": "GET", "path": "/api/snapshot" }
```

Return `400` for bad JSON or shape, `404` for absent plugin, `409` for absent/offline service, `403` for route denial, `502` for upstream protocol failure, and `504` for timeout. Add `requestService()` to `pluginDashboardApi()`; it accepts only method/path/body, not URLs or headers.

- [ ] **Step 7: Run focused and regression tests, then commit**

```bash
bunx vitest run --project unit \
  test/plugin-manifest-store.test.ts \
  test/dashboard-plugin-service-bridge.test.ts \
  test/dashboard-plugin-settings.test.ts \
  test/plugin-service-link-watch.test.ts \
  test/global-config.test.ts
bun run build
```

Expected: all focused tests and build pass.

```bash
git add src/core/plugins src/dashboard.ts src/dashboard/web/plugin-page.tsx test
git commit -m "feat(dashboard): 代理插件本机服务数据"
```

## Task 3: Convert the plugin service to loopback-only internal APIs

**Files (plugin repository):**
- Modify: `src/service/index.js`
- Modify: `src/service/server.js`
- Modify: `scripts/build.mjs`
- Modify: `scripts/validate.mjs`
- Create: `src/service-http/index.json`
- Delete: `src/web/index.html`
- Delete: `src/web/app.js`
- Delete: `src/web/styles.css`
- Modify: `test/server.test.js`
- Modify: `test/ui-cli.test.js`

- [ ] **Step 1: Write failing loopback-only tests**

Assert that the default service definition uses `HOST=127.0.0.1`, advertises `healthUrl` only, and has no `openUrl` or external web URL. Assert `GET /` and all former static assets return 404 while `/health` and `/api/snapshot` remain available.

Run `bun test test/server.test.js test/ui-cli.test.js`. Expected: FAIL under the current public web service.

- [ ] **Step 2: Apply the minimal service changes**

The service definition must become:

```js
export default {
  mode: 'auto',
  port: 9362,
  pm2: {
    script: './service/server.js',
    env: {
      HOST: '127.0.0.1',
      PORT: '9362',
      TRAE_PROXY_CONFIG: '/home/zhongweijie.x/.aikit/cliproxy/state/config.yaml',
    },
    autorestart: true,
  },
  urls({ port }) {
    return { healthUrl: `http://127.0.0.1:` + port + '/health' };
  },
};
```

Remove static-file serving from `server.js`, remove `web` from the build copy list, and replace static runtime requirements with `dist/service-http/index.json`.

- [ ] **Step 3: Declare the Dashboard service allowlist**

Create:

```json
{
  "schemaVersion": 1,
  "routes": [
    { "method": "GET", "path": "/api/snapshot" },
    { "method": "POST", "path": "/api/refresh" }
  ]
}
```

- [ ] **Step 4: Verify and commit**

```bash
bun test
node scripts/build.mjs
node scripts/validate.mjs
```

Expected: all tests pass and no `dist/web` output exists.

```bash
git add -A
git commit -m "refactor(service): 收敛为本机状态 API"
```

## Task 4: Add observe-only catalog lifecycle and snapshot fields

**Files (plugin repository):**
- Create: `src/service/catalog-store.js`
- Create: `src/service/catalog-reconciler.js`
- Modify: `src/service/server.js`
- Modify: `src/core/status.js`
- Create: `test/catalog-reconciler.test.js`
- Modify: `test/server.test.js`

- [ ] **Step 1: Write failing state-machine tests**

Use a temp SQLite database and a fake clock. Cover:

- first successful catalog creates `new` entries;
- unchanged catalog keeps `firstSeenAt` stable;
- one or two successful absences increment `missingSuccessCount` but stay active;
- third absence enters `pending_removal` and stores `pendingRemovalAt`;
- reappearance before 24 hours restores the route;
- absence after 24 hours enters `removed`;
- removed history is purged after 7 days;
- timeout, empty catalog, malformed catalog, and client error do not increment missing counts;
- entries without backend metadata become `unmapped`;
- manual aliases supplied by current Proxy config are preserved in the display model and marked `manualAlias`.

Run `bun test test/catalog-reconciler.test.js`. Expected: FAIL because the modules do not exist.

- [ ] **Step 2: Implement the store and pure reconciler**

Expose a pure function and persistence wrapper:

```js
export function reconcileCatalog(previous, catalog, now) {
  return { entries, catalogHash, changes };
}

export class CatalogStore {
  constructor(path) {}
  load() {}
  replace(state) {}
  purgeRemovedBefore(isoTime) {}
}
```

The state holds id, displayName, backend variants, lifecycle, first/last seen, missing count, removal timestamps, and last error. Hash a canonical sorted projection, never raw JSON ordering.

- [ ] **Step 3: Wire observe mode into refresh**

Every successful 30-second `model/list` read reconciles catalog state. Add these public snapshot fields:

```json
{
  "catalog": {
    "status": "ok",
    "lastSuccessAt": "ISO-8601",
    "hash": "sha256",
    "counts": { "available": 0, "new": 0, "pendingRemoval": 0, "removed": 0, "unmapped": 0, "abnormal": 0 },
    "changes": []
  },
  "routeSync": { "mode": "observe", "status": "idle" }
}
```

Catalog failure preserves the previous snapshot and sets a degraded status. Do not write Proxy config in this phase.

- [ ] **Step 4: Run plugin tests and commit**

```bash
bun test
node scripts/build.mjs
node scripts/validate.mjs
git add src test scripts
git commit -m "feat(catalog): 观察 TraeX 模型生命周期"
```

## Task 5: Build the native Botmux plugin Dashboard

**Files (plugin repository):**
- Replace: `src/dashboard/index.js`
- Create: `src/dashboard/view-model.js`
- Create: `test/dashboard.test.js`
- Modify: `scripts/build.mjs`
- Modify: `scripts/validate.mjs`

- [ ] **Step 1: Write failing view-model and timer tests**

Test pure grouping/search functions and a component mounted with a fake `api.react` plus fake `api.requestService`. Assert:

- sort order is abnormal/high-load, new, favorite, other;
- search matches display name, id, alias, and backend;
- natural/probe counts, confidence, last sample, catalog freshness, and lifecycle render;
- visible page polls at 5 seconds, hidden page at 30 seconds, visibility restoration refreshes immediately;
- failed fetch retains the last good snapshot and renders an explicit degraded banner;
- component cleanup cancels both timers and ignores late responses.

Run `bun test test/dashboard.test.js`. Expected: FAIL under the current open-page button.

- [ ] **Step 2: Implement the component using host React only**

Export `TraeModelStatusDashboard({ api })` without bundling React. Use `api.react.createElement` and hooks. Fetch only through:

```js
api.requestService({ method: 'GET', path: '/api/snapshot' })
```

Provide summary cards, status filters, search, grouped model rows, and an accessible detail panel. Do not call 9362 from browser JavaScript and do not include an external open button.

- [ ] **Step 3: Verify behavior and commit**

```bash
bun test
node scripts/build.mjs
node scripts/validate.mjs
git add src/dashboard test/dashboard.test.js scripts
git commit -m "feat(dashboard): 展示 Trae Proxy 实时状态"
```

## Task 6: Package the read-only checkpoint for review

**Files:**
- Botmux plan branch and plugin main branch commits from Tasks 1–5
- Create verification record: `~/temp/trae-proxy-dashboard-readonly/VERIFICATION.md`

- [ ] **Step 1: Run complete focused gates**

Botmux:

```bash
bunx vitest run --project unit \
  test/plugin-manifest-store.test.ts \
  test/dashboard-plugin-service-bridge.test.ts \
  test/dashboard-plugin-settings.test.ts \
  test/plugin-service-link-watch.test.ts \
  test/global-config.test.ts
bun run build
```

Plugin:

```bash
bun test
node scripts/build.mjs
node scripts/validate.mjs
```

- [ ] **Step 2: Verify no production mutation**

Capture and compare before/after values for Proxy PID, Proxy binary hash, Proxy config hash, 9362 PID, Botmux current release, and control-center pins. Expected: unchanged.

- [ ] **Step 3: Record checkpoint commits and request independent review**

The record must list exact commits, test counts, known baseline failures, and prove `routeSync.mode=observe` and `probeMode=off`. Do not deploy until independent review reports no Critical/Important findings.
