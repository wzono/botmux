# Trae Proxy Control-center Pinned Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Maintain exactly one automatically refreshed and pinned Trae Proxy Card 2.0 in the Botmux control-center chat without coupling card failure to Proxy health.

**Architecture:** Botmux adds a generic plugin status-card contribution and one durable publisher per plugin. The publisher requests card JSON from the plugin loopback service, sends or patches one top-level interactive message using a configured publisher bot, and converges the chat top notice to that message. All target identity lives in plugin-private settings; the plugin renders content but never receives Lark credentials.

**Tech Stack:** TypeScript/Vitest/Bun in Botmux; Lark Card 2.0; existing Botmux send/update/top-notice client APIs; JavaScript/Bun tests and create-lark-card validation in the plugin.

---

## Task 1: Add the generic plugin status-card contribution

**Files (Botmux topic branch):**
- Modify: src/core/plugins/types.ts
- Modify: src/core/plugins/convention-scanner.ts
- Modify: src/core/plugins/materializer.ts
- Modify: src/core/plugins/paths.ts
- Modify: src/core/plugins/service-manager.ts
- Modify: test/plugin-manifest-store.test.ts
- Modify: test/plugin-service-link-watch.test.ts

- [ ] **Step 1: Write the failing scanner tests**

Add fixed convention file status-card/index.json:

~~~json
{
  "schemaVersion": 1,
  "endpoint": "/botmux/status-card/v1",
  "refreshIntervalSeconds": 60,
  "pin": true
}
~~~

Assert scanning and materialization. Reject missing service, non-relative path, query/fragment/traversal, interval below 30 or above 3600, non-boolean pin, unknown keys, and multiple status-card declarations. Assert the service manager creates a separate 0600 status-card token, overrides any plugin-forged value, injects BOTMUX_PLUGIN_STATUS_CARD_TOKEN and BOTMUX_PLUGIN_STATUS_CARD_ENDPOINT, and never exposes either value in the public registry/materialized files.

- [ ] **Step 2: Run RED**

Run: bunx vitest run --project unit test/plugin-manifest-store.test.ts

Expected: FAIL because statusCard is absent.

- [ ] **Step 3: Implement the type and scanner**

Add PluginStatusCardContribution with schemaVersion, endpoint, refreshIntervalSeconds, and pin. Add pluginStatusCardTokenPath beside pluginCardActionTokenPath. Persist no chat, bot, message, token, or card content in the public registry/materialized files.

- [ ] **Step 4: Run GREEN and commit**

~~~bash
bunx vitest run --project unit test/plugin-manifest-store.test.ts test/plugin-service-link-watch.test.ts
git add src/core/plugins test/plugin-manifest-store.test.ts test/plugin-service-link-watch.test.ts
git commit -m "feat(plugin): 声明自动状态卡能力"
~~~

## Task 2: Implement a durable generic publisher

**Files (Botmux topic branch):**
- Create: src/core/plugins/status-card/publisher.ts
- Create: src/core/plugins/status-card/store.ts
- Create: src/core/plugins/status-card/runtime.ts
- Modify: src/daemon.ts
- Create: test/plugin-status-card-publisher.test.ts
- Create: test/plugin-status-card-runtime.test.ts

- [ ] **Step 1: Write failing publisher state-machine tests**

Inject render, send, patch, message lookup, top-notice, clock, and store dependencies. The render dependency reads pluginStatusCardTokenPath and POSTs to the declared loopback endpoint with Authorization Bearer and a host-computed token-free Dashboard URL. Cover:

- disabled/missing private settings performs no Lark write;
- first render sends one top-level interactive card, persists binding, then sets top notice;
- next tick patches the same message and sends nothing;
- unchanged card hash skips patch;
- provider-confirmed withdrawn/deleted message clears binding and sends exactly one replacement;
- expired/non-patchable message sends exactly one replacement;
- transient patch error retains binding and retries with backoff, without duplicate send;
- pin/top-notice failure records degraded state but keeps the card binding;
- restart loads one binding and continues patching;
- two daemons cannot publish the same plugin concurrently;
- disabling settings stops future ticks without deleting the card;
- card failure never calls service restart, Proxy restart, or plugin start/stop.

- [ ] **Step 2: Run RED**

Run the two new test files. Expected: FAIL because publisher/runtime modules do not exist.

- [ ] **Step 3: Implement the private durable store**

Store under the daemon data directory, mode 0600, keyed by plugin id:

~~~ts
interface PluginStatusCardBinding {
  schemaVersion: 1;
  pluginId: string;
  larkAppId: string;
  chatId: string;
  messageId?: string;
  lastCardHash?: string;
  lastSuccessAt?: string;
  lastError?: string;
  nextAttemptAt?: string;
}
~~~

Use lock plus atomic write. Never store card JSON, credentials, owner ids, or callback tokens.

- [ ] **Step 4: Implement the publisher with existing Lark primitives**

Use sendMessage with msgType interactive for first send, updateMessage for patch, and putChatTopNotice for the approved group top notice. Before every write, verify the publisher bot is configured, transport-enabled, and belongs to the target chat. Use provider acknowledgement as the only success signal.

- [ ] **Step 5: Implement daemon runtime ownership**

Exactly one daemon process owns each configured status-card publisher. Resolve ownership deterministically from the configured publisher larkAppId; other daemons stay idle. Start after bot registration and plugin-service preload are ready. Tick at the contribution interval, plus an explicit kick method for future event-driven updates. Clear timers on shutdown.

- [ ] **Step 6: Run GREEN and commit**

~~~bash
bunx vitest run --project unit \
  test/plugin-status-card-publisher.test.ts \
  test/plugin-status-card-runtime.test.ts \
  test/plugin-manifest-store.test.ts \
  test/chat-top-notice.test.ts
bun run build
git add src/core/plugins/status-card src/core/plugins src/daemon.ts test
git commit -m "feat(plugin): 持久维护群置顶状态卡"
~~~

## Task 3: Add private settings and Dashboard diagnostics

**Files (Botmux topic branch):**
- Modify: src/core/plugins/dashboard-settings.ts
- Modify: src/dashboard/web/plugin-page.tsx
- Modify: test/dashboard-plugin-settings.test.ts
- Modify: test/plugin-status-card-runtime.test.ts

**Files (plugin repository):**
- Create: src/server/settings.js
- Modify: src/dashboard/index.js
- Modify: test/dashboard.test.js

- [ ] **Step 1: Write failing settings tests**

Private settings schema:

~~~json
{
  "statusCard": {
    "enabled": true,
    "larkAppId": "cli_...",
    "chatId": "oc_..."
  }
}
~~~

The plugin adapter validates exact cli_/oc_ shape and contribution presence. The generic Botmux save path validates configured bot existence and non-apiOnly transport before persisting. The publisher performs the authoritative current-chat membership check before any send. Browser-safe getSettings returns ids plus resolved display names and runtime status; it never returns credentials.

- [ ] **Step 2: Run RED**

Run plugin settings and dashboard tests. Expected: FAIL because status-card settings/status are absent.

- [ ] **Step 3: Implement settings validation and diagnostics**

The plugin settings adapter accepts enabled, larkAppId, and chatId only. Botmux generic Dashboard payload exposes publisher state: disabled, starting, online, degraded, last success, last error, message id suffix, and pin/top-notice state. Do not expose full message history or secrets.

- [ ] **Step 4: Run GREEN and commit both repositories**

Botmux commit:

~~~bash
bunx vitest run --project unit test/dashboard-plugin-settings.test.ts test/plugin-status-card-runtime.test.ts
git add src test
git commit -m "feat(dashboard): 配置插件群状态卡"
~~~

Plugin commit:

~~~bash
bun test test/dashboard.test.js
git add src/server/settings.js src/dashboard test/dashboard.test.js
git commit -m "feat(settings): 配置控制中心状态卡"
~~~

## Task 4: Render a valid Trae Proxy Card 2.0 from the plugin

**Files (plugin repository):**
- Modify: src/cli/index.js
- Modify: src/service/server.js
- Create: src/status-card/index.json
- Modify: test/ui-cli.test.js
- Modify: test/server.test.js
- Modify: scripts/build.mjs
- Modify: scripts/validate.mjs

- [ ] **Step 1: Write failing card behavior tests**

Assert the card includes total, abnormal, new, pending-removal counts, six attention models, natural/probe status, and last update. No quota, API key, prompt, raw error body, user identity, or Dashboard token may appear. The Dashboard action is a Botmux-owned relative action, not a raw token URL. Refresh retains the same modern-minimal layout.

- [ ] **Step 2: Run RED**

Run UI/server tests. Expected: FAIL because status-card endpoint/contribution are absent.

- [ ] **Step 3: Implement render endpoint**

Add POST /botmux/status-card/v1 protected by BOTMUX_PLUGIN_STATUS_CARD_TOKEN. Accept only a token-free Dashboard base URL from the Botmux host and return bare Card 2.0 JSON. Keep manual refresh callback through the existing card-action endpoint. Create status-card/index.json with 60-second interval and pin true.

- [ ] **Step 4: Validate schema and previews**

Run:

~~~bash
bun test test/ui-cli.test.js test/server.test.js
bun test
node scripts/build.mjs
node scripts/validate.mjs
npm exec --yes --package=tsx -- tsx /data00/home/zhongweijie.x/.codex/skills/create-lark-card/scripts/validate_card.ts card.json
env npm_config_registry=https://bnpm.byted.org npx -y @lark/card-preview@0.0.5-0 --user-dsl-path card.json --device pc --output card-preview.png
env npm_config_registry=https://bnpm.byted.org npx -y @lark/card-preview@0.0.5-0 --user-dsl-path card.json --device mobile --output card-preview-mobile.png
~~~

Visually inspect both previews. No clipped table, collapsed button, fake image, or unreadable dark-mode token is acceptable.

- [ ] **Step 5: Commit**

~~~bash
git add src test scripts
git commit -m "feat(card): 渲染 Trae Proxy 置顶状态"
~~~

## Task 5: Deploy and prove the single pinned card

**Files:**
- Plugin private settings
- Botmux immutable release candidate and gate record
- Verification record: ~/temp/trae-proxy-control-center-card-20261026/VERIFICATION.md

- [ ] **Step 1: Resolve target identities without hard-coding**

Read the current Botmux control-center chat id and publisher bot from authoritative Botmux configuration and current group membership. Confirm the publisher has transport and card/top-notice permissions. Write only private plugin settings.

- [ ] **Step 2: Deploy Botmux through the maintained release flow**

Add the reviewed Botmux topic branch to the customization manifest, rebuild dev, prepare an immutable release, compare full gate with the frozen upstream baseline, obtain independent review, and activate through the independent release systemd service. Do not run a naked fleet restart.

- [ ] **Step 3: Link-install the reviewed plugin and restart only its service**

Install from the private repository checkout with botmux plugin install --link, enable globally, pin its Dashboard contribution, and restart only trae-model-status. Verify 9362 is loopback-only and no standalone web openUrl exists.

- [ ] **Step 4: Enable status-card settings and observe first publication**

Expected: exactly one new top-level interactive message, one durable binding, and that message becomes the control-center top notice. Record message id and acknowledgement.

- [ ] **Step 5: Prove automatic patch and resilience**

Observe at least two minute ticks with the same message id and changing update time. Trigger a manual refresh. Test one safe renderer failure and verify no duplicate card and no Proxy/plugin restart. Verify Dashboard/Proxy remain healthy.

- [ ] **Step 6: Final independent verification**

Verify one card only, top notice points to it, callback succeeds, no credential leaks, no unrelated bot/config changes, and the previous ad-hoc topic card is not treated as the maintained binding. Deliver screenshots, message receipt, commits, release hash, tests, and rollback commands.
