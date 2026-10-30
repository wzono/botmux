import type { ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import type { DaemonSession } from '../src/core/types.js';
import { runGroupWorkspaceRepoEntrypoint } from '../src/core/command-handler.js';
import {
  createGroupWorkspaceSetCoordinator,
  type GroupWorkspaceOperationDependencies,
} from '../src/core/group-workspace-operation.js';
import { createGroupWorkspaceRouteRuntime } from '../src/core/group-workspace-route-runtime.js';
import {
  resolveGroupWorkspaceFollowTarget,
  runGroupWorkspaceSessionFollow,
} from '../src/core/session-cwd.js';
import { retireWorkerForReplacement } from '../src/core/worker-pool.js';
import { GroupWorkspaceOperationStore } from '../src/services/group-workspace-operation-store.js';
import {
  canonicalGroupWorkspaceRequestIntentDigest,
  canonicalTextSourceEventId,
  GroupWorkspaceStore,
  groupWorkspaceOperationKey,
} from '../src/services/group-workspace-store.js';
import { atomicWriteFileSync } from '../src/utils/atomic-write.js';
import {
  mutatePersistedSessionRow,
  readPersistedSessionRows,
  seedPersistedSessionRows,
} from './helpers/session-store-disk.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { descendantPids, killProcessTree } from './helpers/process-tree.js';

const children = new Set<ChildProcess>();
const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...children].map(child => killProcessTree(child, 5_000)));
  children.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

async function waitUntil(check: () => boolean, detail: () => string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out: ${detail()}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function fakeCliSource(prompt: string, deliveryFile: string): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
process.stdout.write(${JSON.stringify(prompt)});
let input = '';
process.stdin.on('data', chunk => {
  input += chunk.toString();
  if (!/[\\r\\n]$/.test(input)) return;
  if (input.includes('\\x1b[200~') && !input.includes('\\x1b[201~')) return;
  const text = input.replace(/\\x1b\\[20[01]~/g, '').trim();
  input = '';
  if (text) fs.appendFileSync(${JSON.stringify(deliveryFile)}, process.cwd() + '\\t' + text + '\\n');
  process.stdout.write('\\r\\n' + ${JSON.stringify(prompt)});
});
`;
}

function startWorker(input: {
  root: string; workingDir: string; cliId: 'claude-code' | 'codex'; cliPath: string;
  sessionId: string; generation: number; larkAppId?: string; botsConfig?: string;
}): { child: ChildProcess; messages: WorkerToDaemon[]; logs: string[] } {
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: input.root,
      SESSION_DATA_DIR: join(input.root, 'data'),
      ...(input.botsConfig ? { BOTS_CONFIG: input.botsConfig } : {}),
      BOTMUX_SESSION_ID: input.sessionId,
      LARK_APP_ID: input.larkAppId ?? 'app_follow_real',
      LARK_APP_SECRET: 'test-only',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  child.on('message', raw => messages.push(raw as WorkerToDaemon));
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  child.send({
    type: 'init', sessionId: input.sessionId, chatId: 'oc_follow', rootMessageId: 'oc_follow',
    workingDir: input.workingDir, cliId: input.cliId, cliPathOverride: input.cliPath,
    backendType: 'pty', prompt: '', resume: false, workerGeneration: input.generation,
    larkAppId: input.larkAppId ?? 'app_follow_real', larkAppSecret: 'test-only', locale: 'zh',
    ...(input.botsConfig ? { loadedBotsConfigPath: input.botsConfig, loadedBotsConfigProvenance: 'loaded' as const } : {}),
  } satisfies DaemonToWorker);
  return { child, messages, logs };
}

const CRASH_CHAT = 'oc_group_workspace_runtime';
const CRASH_ACTOR = { tenantKey: 'tenant-runtime', unionId: 'on_runtime_admin' } as const;
type CrashBoundary = NonNullable<GroupWorkspaceOperationDependencies['afterBoundary']> extends
  (boundary: infer T) => Promise<void> ? T : never;
type RuntimeWorker = ReturnType<typeof startWorker>;

interface ProductionComposition {
  dispatch(appId: 'app-runtime-a' | 'app-runtime-b', input: {
    messageId: string; deliveryAttemptId: string; selection: string;
  }): Promise<void>;
  crash(): Promise<void>;
  reconstruct(crashAt?: CrashBoundary, ambiguousWriter?: boolean): Promise<ProductionComposition>;
  replies: Array<{ appId: string; text: string }>;
  emitted: string[];
  workers: Map<string, RuntimeWorker>;
  allWorkers: RuntimeWorker[];
  groupStore: GroupWorkspaceStore;
  operationStore: GroupWorkspaceOperationStore;
}

async function productionComposition(input: {
  root: string; oldDir: string; targetDir: string; fakeCli: string;
  crashAt?: CrashBoundary; ambiguousWriter?: boolean;
  replies?: Array<{ appId: string; text: string }>; emitted?: string[];
  allWorkers?: RuntimeWorker[];
}): Promise<ProductionComposition> {
  const dataDir = join(input.root, 'data');
  const appIds = ['app-runtime-a', 'app-runtime-b'] as const;
  const botsConfig = join(dataDir, 'bots.json');
  writeFileSync(botsConfig, JSON.stringify(appIds.map(larkAppId => ({
    larkAppId, larkAppSecret: 'test-only', cliId: 'claude-code', backendType: 'pty',
  }))));
  const sessionIds = new Map(appIds.map(appId => [appId, `group-runtime-${appId.at(-1)}`]));
  for (const appId of appIds) {
    const sessionId = sessionIds.get(appId)!;
    try { readPersistedSessionRows(dataDir, appId); } catch {
      seedPersistedSessionRows(dataDir, appId, { [sessionId]: {
        sessionId, chatId: CRASH_CHAT, rootMessageId: CRASH_CHAT, status: 'active',
        createdAt: new Date().toISOString(), larkAppId: appId, scope: 'chat', chatType: 'group',
        cliId: 'claude-code', backendType: 'pty', workingDir: input.oldDir,
        workingDirSource: 'explicit', workerGeneration: 0,
      } });
    }
  }

  const workers = new Map<string, RuntimeWorker>();
  const allWorkers = input.allWorkers ?? [];
  const sessions = new Map<string, DaemonSession>();
  for (const appId of appIds) {
    const sessionId = sessionIds.get(appId)!;
    const row = readPersistedSessionRows(dataDir, appId)[sessionId];
    const worker = startWorker({ root: input.root, workingDir: row.workingDir, cliId: 'claude-code',
      cliPath: input.fakeCli, sessionId, generation: row.workerGeneration ?? 0, larkAppId: appId, botsConfig });
    workers.set(appId, worker);
    allWorkers.push(worker);
    sessions.set(sessionId, {
      session: row, worker: worker.child, workerPort: null, workerToken: null, larkAppId: appId,
      chatId: CRASH_CHAT, chatType: 'group', scope: 'chat', spawnedAt: Date.now(), lastMessageAt: Date.now(),
      hasHistory: false, workingDir: row.workingDir, initConfig: { backendType: 'pty' },
      workerGeneration: row.workerGeneration ?? 0, workerReady: true, cliReady: true, lastScreenStatus: 'idle',
    } as unknown as DaemonSession);
  }
  await Promise.all([...workers.values()].map(worker => waitUntil(
    () => worker.messages.some(message => message.type === 'prompt_ready'),
    () => `${worker.logs.join('')}\n${JSON.stringify(worker.messages)}`,
  )));

  let writerThrown = false;
  const groupStore = new GroupWorkspaceStore(dataDir, input.ambiguousWriter ? {
    writer: (path, data, options) => {
      atomicWriteFileSync(path, data, options);
      if (!writerThrown) { writerThrown = true; throw new Error('injected unknown after rename'); }
    },
    durabilityReestablisher: path => {
      if (writerThrown) throw new Error('injected durability unknown');
      void path;
    },
  } : {});
  const operationStore = new GroupWorkspaceOperationStore(dataDir);
  const replies = input.replies ?? [];
  const emitted = input.emitted ?? [];
  let armedCrash = input.crashAt;
  const runtimes = new Map<string, ReturnType<typeof createGroupWorkspaceRouteRuntime>>();
  const routeResults = new Map<string, Awaited<ReturnType<ReturnType<typeof createGroupWorkspaceSetCoordinator>['execute']>>>();

  for (const appId of appIds) {
    runtimes.set(appId, createGroupWorkspaceRouteRuntime({
      larkAppId: appId, activeSessions: sessions,
      sessionKey: (_chatId, botAppId) => sessionIds.get(botAppId as typeof appIds[number])!,
      registeredBots: tenantKey => appIds.map(larkAppId => ({ larkAppId, tenantKey, resolvedAllowedUsers: ['ou_runtime_admin'] })),
      resolveAllowedUser: async () => CRASH_ACTOR,
      resolveActorUnion: async () => CRASH_ACTOR.unionId,
      readWorkspace: chatId => groupStore.read(chatId),
      canSwitchSession: () => true,
      dispatchRepo: async () => { throw new Error('legacy coordinator path used'); },
      reply: async message => { replies.push({ appId, text: message }); },
      executeGroupWorkspaceRoute: async route => {
        const requestIntentDigest = canonicalGroupWorkspaceRequestIntentDigest({ kind: 'set', chatId: route.chatId, selection: route.selection });
        const coordinator = createGroupWorkspaceSetCoordinator({
          journalStore: operationStore, groupStore, now: Date.now,
          resolveCanonicalTarget: async () => ({ status: 'resolved', workingDir: input.targetDir }),
          readSession: async sessionId => {
            const current = sessions.get(sessionId);
            return current ? { status: 'available', generation: current.workerGeneration ?? 0, workingDir: current.workingDir }
              : { status: 'store_unavailable' };
          },
          switchSession: async request => {
            const current = sessions.get(request.sessionId);
            if (!current || current.workerGeneration !== request.expectedGeneration) return { status: 'unknown' };
            const app = current.larkAppId;
            if (!await retireWorkerForReplacement(current, { timeoutMs: 5_000 })) return { status: 'unknown' };
            const generation = request.expectedGeneration + 1;
            mutatePersistedSessionRow(dataDir, app, request.sessionId, row => {
              row.workingDir = request.targetWorkingDir; row.workingDirSource = 'explicit';
              delete row.groupWorkspaceRevision; row.workerGeneration = generation;
            });
            const row = readPersistedSessionRows(dataDir, app)[request.sessionId];
            current.session = row; current.workingDir = row.workingDir; current.workerGeneration = generation;
            const replacement = startWorker({ root: input.root, workingDir: row.workingDir, cliId: 'claude-code',
              cliPath: input.fakeCli, sessionId: request.sessionId, generation, larkAppId: app, botsConfig });
            workers.set(app, replacement); current.worker = replacement.child;
            allWorkers.push(replacement);
            await waitUntil(() => replacement.messages.some(message => message.type === 'prompt_ready'),
              () => `${replacement.logs.join('')}\n${JSON.stringify(replacement.messages)}`);
            return { status: 'committed', generation };
          },
          convergeSession: async result => {
            const current = sessions.get(result.sessionId);
            if (!current || current.workerGeneration !== result.expectedGeneration) throw new Error('lost generation');
            mutatePersistedSessionRow(dataDir, current.larkAppId, result.sessionId, row => {
              row.workingDirSource = result.source;
              if (result.groupRevision === undefined) delete row.groupWorkspaceRevision;
              else row.groupWorkspaceRevision = result.groupRevision;
            });
            current.session = readPersistedSessionRows(dataDir, current.larkAppId)[result.sessionId];
          },
          afterBoundary: async boundary => {
            if (armedCrash === boundary) { armedCrash = undefined; throw new Error(`crash:${boundary}`); }
          },
        });
        const result = await coordinator.execute({
          operationKey: groupWorkspaceOperationKey(route.messageId!, 'set'), sourceEventId: route.messageId!,
          kind: 'set', requestIntentDigest, chatId: route.chatId, sessionId: sessionIds.get(appId)!, actor: route.actor,
        });
        routeResults.set(appId, result);
        if (result.status !== 'unknown') emitted.push(`${appId}:${result.status}`);
      },
    }));
  }

  const runtime: ProductionComposition = {
    groupStore, operationStore, replies, emitted, workers, allWorkers,
    async dispatch(appId, dispatchInput) {
      await runGroupWorkspaceRepoEntrypoint({
        kind: 'set', source: 'text', chatId: CRASH_CHAT, actor: CRASH_ACTOR,
        selection: dispatchInput.selection, messageId: dispatchInput.messageId,
        deliveryAttemptId: dispatchInput.deliveryAttemptId,
      }, {
        executeSet: async request => {
          const runtimeForBot = runtimes.get(appId)!;
          const authority = await runtimeForBot.resolveAuthority({
            chatId: CRASH_CHAT, senderOpenId: 'ou_runtime_admin', senderUnionId: CRASH_ACTOR.unionId,
            tenantKey: CRASH_ACTOR.tenantKey, humanProvenance: true,
          });
          if (!authority?.canSwitchSession) return { status: 'unauthorized' };
          await runtimeForBot.handleRoute({
            kind: 'set', source: 'text', chatId: CRASH_CHAT, actor: CRASH_ACTOR,
            actorOpenId: 'ou_runtime_admin', selection: request.selection!, messageId: request.sourceEventId,
          });
          const routeResult = routeResults.get(appId);
          if (routeResult?.status === 'unknown') return { status: 'unknown' };
          const journal = await operationStore.getByIntent(request.sourceEventId, 'set');
          if (journal.status !== 'found') return { status: 'unknown' };
          const receipt = await groupStore.readReceipt(journal.journal.operationKey);
          return receipt.status === 'found' && receipt.receipt.outcome === 'committed'
            ? { status: 'group_committed', groupRevision: receipt.receipt.resultingRevision! }
            : { status: 'unknown' };
        },
        executeUnbind: async () => ({ status: 'aborted' }),
        reply: async text => { replies.push({ appId, text }); },
      });
    },
    async crash() {
      await Promise.all([...workers.values()].map(worker => killProcessTree(worker.child, 5_000)));
      await waitUntil(() => [...workers.values()].every(worker => worker.child.exitCode !== null || worker.child.signalCode !== null),
        () => 'workers did not exit');
    },
    async reconstruct(crashAt, ambiguousWriter) {
      await runtime.crash();
      return productionComposition({ ...input, crashAt, ambiguousWriter, replies, emitted, allWorkers });
    },
  };
  return runtime;
}

describe('group workspace follow with real PTY workers', () => {
  it.each([
    'prepared_before_switch',
    'session_persisted_before_advance',
    'group_committed_before_convergence',
    'receipt_before_response',
  ] as const)('reconstructs both Bot runtimes and recovers %s through real SQLite and PTY workers', async crashAt => {
    const root = mkdtempSync(join(tmpdir(), `botmux-group-runtime-${crashAt}-`));
    roots.add(root);
    const oldDir = join(root, 'old');
    const targetDir = join(root, 'target');
    const dataDir = join(root, 'data');
    for (const directory of [oldDir, targetDir, dataDir]) mkdirSync(directory, { recursive: true });
    const deliveries = join(root, 'deliveries');
    const fakeCli = join(root, 'fake-claude');
    writeFileSync(deliveries, '');
    writeFileSync(fakeCli, fakeCliSource('❯ ', deliveries));
    chmodSync(fakeCli, 0o755);

    let runtime = await productionComposition({ root, oldDir, targetDir, fakeCli, crashAt });
    const aclSource = canonicalTextSourceEventId({
      tenantKey: CRASH_ACTOR.tenantKey, chatId: CRASH_CHAT, messageId: 'om_acl_seed',
    });
    if (!aclSource.ok) throw new Error(aclSource.reason);
    const seeded = await runtime.groupStore.mutate({
      kind: 'unbind', chatId: CRASH_CHAT,
      sourceEventId: aclSource.sourceEventId,
      expectedRevision: 0, actor: CRASH_ACTOR, authorized: true, now: 1,
    });
    expect(seeded.outcome).toBe('committed');
    const registryPath = join(dataDir, 'group-workspaces.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    registry.records[CRASH_CHAT].workspaceManagers = [CRASH_ACTOR];
    writeFileSync(registryPath, JSON.stringify(registry));

    await expect(runtime.dispatch('app-runtime-a', {
      messageId: 'om_runtime_original', deliveryAttemptId: 'delivery-a', selection: targetDir,
    })).rejects.toThrow(`crash:${crashAt}`);
    runtime = await runtime.reconstruct();
    await runtime.dispatch('app-runtime-a', {
      messageId: 'om_runtime_original', deliveryAttemptId: 'delivery-recovery-a', selection: targetDir,
    });
    await runtime.dispatch('app-runtime-b', {
      messageId: 'om_runtime_original', deliveryAttemptId: 'delivery-replay-b', selection: targetDir,
    });

    const source = canonicalTextSourceEventId({
      tenantKey: CRASH_ACTOR.tenantKey, chatId: CRASH_CHAT, messageId: 'om_runtime_original',
      deliveryEventId: 'provider-event-b', deliveryAttemptId: 'delivery-replay-b',
    });
    if (!source.ok) throw new Error(source.reason);
    const operationKey = groupWorkspaceOperationKey(source.sourceEventId, 'set');
    const sessionA = readPersistedSessionRows(dataDir, 'app-runtime-a')['group-runtime-a'];
    const sessionB = readPersistedSessionRows(dataDir, 'app-runtime-b')['group-runtime-b'];
    expect(sessionA).toMatchObject({
      workingDir: targetDir, workingDirSource: 'group', groupWorkspaceRevision: 2, workerGeneration: 1,
    });
    expect(sessionB).toMatchObject({ workingDir: oldDir, workingDirSource: 'explicit', workerGeneration: 0 });
    const [group, journal, receipt] = await Promise.all([
      runtime.groupStore.read(CRASH_CHAT),
      runtime.operationStore.get(operationKey),
      runtime.groupStore.readReceipt(operationKey),
    ]);
    expect(group).toMatchObject({
      status: 'available', record: {
        revision: 2, directory: { kind: 'bound', workingDir: targetDir }, workspaceManagers: [CRASH_ACTOR],
      },
    });
    expect(journal).toMatchObject({
      status: 'found', journal: { phase: 'group_committed', sessionGenerationAfter: 1, groupRevisionAfter: 2 },
    });
    expect(receipt).toMatchObject({
      status: 'found', receipt: { outcome: 'committed', resultingRevision: 2, expectedSessionGeneration: 0 },
    });
    const liveWorkerProcesses = runtime.allWorkers.filter(worker => worker.child.pid
      && worker.child.exitCode === null && worker.child.signalCode === null
      && (() => { try { process.kill(worker.child.pid!, 0); return true; } catch { return false; } })());
    expect(liveWorkerProcesses).toHaveLength(2);
    expect(liveWorkerProcesses.map(worker => descendantPids(worker.child.pid!).length)).toEqual([2, 2]);
    expect(runtime.replies).toHaveLength(2);
    expect(runtime.emitted.filter(value => value.endsWith(':group_committed'))).toHaveLength(2);

    const workerA = runtime.workers.get('app-runtime-a')!;
    workerA.child.send({ type: 'message', content: 'AFTER_CRASH_RECOVERY', turnId: 'om_runtime_turn' } satisfies DaemonToWorker);
    let delivered = '';
    await waitUntil(() => {
      delivered = readFileSync(deliveries, 'utf8');
      return delivered.includes('AFTER_CRASH_RECOVERY');
    }, () => workerA.logs.join(''));
    expect(delivered.match(/AFTER_CRASH_RECOVERY/g)).toHaveLength(1);
    expect(delivered).toContain(`${realpathSync(targetDir)}\tAFTER_CRASH_RECOVERY`);
  }, 90_000);

  it('recovers an ambiguous group write after rename from the authoritative record and receipt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-group-runtime-ambiguous-'));
    roots.add(root);
    const oldDir = join(root, 'old');
    const targetDir = join(root, 'target');
    const dataDir = join(root, 'data');
    for (const directory of [oldDir, targetDir, dataDir]) mkdirSync(directory, { recursive: true });
    const deliveries = join(root, 'deliveries');
    const fakeCli = join(root, 'fake-claude');
    writeFileSync(deliveries, '');
    writeFileSync(fakeCli, fakeCliSource('❯ ', deliveries));
    chmodSync(fakeCli, 0o755);

    let runtime = await productionComposition({ root, oldDir, targetDir, fakeCli, ambiguousWriter: true });
    await runtime.dispatch('app-runtime-a', {
      messageId: 'om_runtime_ambiguous', deliveryAttemptId: 'delivery-a', selection: targetDir,
    });
    expect(runtime.replies.at(-1)?.text).toMatch(/未知|unknown/i);
    runtime = await runtime.reconstruct();
    await runtime.dispatch('app-runtime-b', {
      messageId: 'om_runtime_ambiguous', deliveryAttemptId: 'delivery-b', selection: targetDir,
    });
    const source = canonicalTextSourceEventId({ tenantKey: CRASH_ACTOR.tenantKey, chatId: CRASH_CHAT, messageId: 'om_runtime_ambiguous' });
    if (!source.ok) throw new Error(source.reason);
    expect(await runtime.groupStore.read(CRASH_CHAT)).toMatchObject({ record: { revision: 1, directory: { workingDir: targetDir } } });
    expect(await runtime.groupStore.readReceipt(groupWorkspaceOperationKey(source.sourceEventId, 'set')))
      .toMatchObject({ status: 'found', receipt: { outcome: 'committed', resultingRevision: 1 } });
    expect(await runtime.operationStore.getByIntent(source.sourceEventId, 'set'))
      .toMatchObject({ status: 'found', journal: { phase: 'group_committed', groupRevisionAfter: 1 } });
    expect(runtime.replies.at(-1)?.text).not.toMatch(/未知|unknown/i);
    const liveWorkerProcesses = runtime.allWorkers.filter(worker => worker.child.pid
      && worker.child.exitCode === null && worker.child.signalCode === null
      && (() => { try { process.kill(worker.child.pid!, 0); return true; } catch { return false; } })());
    expect(liveWorkerProcesses).toHaveLength(2);
    expect(liveWorkerProcesses.map(worker => descendantPids(worker.child.pid!).length)).toEqual([2, 2]);
  }, 90_000);

  it.each(['prepared', 'old_exited', 'persisted', 'spawned'] as const)(
    'recovers a frozen r2 %s journal after unbind without stale-cwd delivery', async phase => {
      const root = mkdtempSync(join(tmpdir(), `botmux-follow-unbind-${phase}-`));
      roots.add(root);
      const oldDir = join(root, 'r1');
      const frozenDir = join(root, 'r2');
      const fallbackDir = join(root, 'fallback');
      const dataDir = join(root, 'data');
      for (const dir of [oldDir, frozenDir, fallbackDir, dataDir]) mkdirSync(dir, { recursive: true });
      const deliveries = join(root, 'deliveries');
      const cliPath = join(root, 'fake-claude');
      writeFileSync(deliveries, '');
      writeFileSync(cliPath, fakeCliSource('❯ ', deliveries));
      chmodSync(cliPath, 0o755);
      const sessionId = `follow-unbind-${phase}`;
      const old = startWorker({ root, workingDir: oldDir, cliId: 'claude-code', cliPath, sessionId, generation: 4 });
      await waitUntil(() => old.messages.some(message => message.type === 'prompt_ready'), () => old.logs.join(''));

      const journal = {
        targetWorkingDir: frozenDir, targetRevision: 2, previousRevision: 1,
        previousGeneration: 4, nextGeneration: 5, phase,
      } as const;
      const session: any = {
        sessionId, chatId: 'oc_follow', rootMessageId: 'oc_follow', status: 'active',
        createdAt: new Date().toISOString(), larkAppId: 'app_follow_real', scope: 'chat',
        cliId: 'claude-code', backendType: 'pty', workingDir: oldDir, workingDirSource: 'group',
        groupWorkspaceRevision: 1, workerGeneration: 4, groupWorkspaceFollow: { ...journal },
      };
      const ds = {
        session, worker: old.child, workerPort: null, workerToken: null, larkAppId: 'app_follow_real',
        chatId: 'oc_follow', chatType: 'group', scope: 'chat', spawnedAt: Date.now(),
        lastMessageAt: Date.now(), hasHistory: false, workingDir: oldDir, initConfig: { backendType: 'pty' },
        workerGeneration: 4, workerReady: true, cliReady: true, lastScreenStatus: 'idle',
      } as unknown as DaemonSession;
      let liveWorkers = 1;
      let current = old;
      if (phase === 'old_exited' || phase === 'persisted' || phase === 'spawned') {
        await retireWorkerForReplacement(ds, { timeoutMs: 5_000 });
        liveWorkers = 0;
      }
      if (phase === 'persisted' || phase === 'spawned') {
        session.workingDir = frozenDir;
        session.groupWorkspaceRevision = 2;
        ds.workingDir = frozenDir;
      }
      if (phase === 'spawned') {
        session.workerGeneration = 5;
        ds.workerGeneration = 5;
        current = startWorker({ root, workingDir: frozenDir, cliId: 'claude-code', cliPath, sessionId, generation: 5 });
        ds.worker = current.child;
        ds.workerReady = false;
        ds.cliReady = false;
        await waitUntil(() => current.messages.some(message => message.type === 'prompt_ready'), () => current.logs.join(''));
        ds.workerReady = true;
        ds.cliReady = true;
      }

      const resolution = resolveGroupWorkspaceFollowTarget({
        journal: session.groupWorkspaceFollow,
        group: { status: 'available', record: { revision: 3, directory: { kind: 'unbound' } } },
      });
      expect(resolution).toEqual({ kind: 'follow', target: { workingDir: frozenDir, revision: 2 } });
      if (resolution.kind !== 'follow') throw new Error('journal target was not recovered');
      const result = await runGroupWorkspaceSessionFollow(ds, resolution.target, {
        isIdle: () => true,
        supportsReplacement: () => true,
        isWorkerLive: candidate => !!candidate.worker && !candidate.worker.killed,
        persist: mutation => {
          if (mutation.source && mutation.workingDir) {
            session.workingDir = mutation.workingDir;
            session.workingDirSource = mutation.source;
            session.groupWorkspaceRevision = mutation.groupWorkspaceRevision;
            ds.workingDir = mutation.workingDir;
          }
          if (mutation.workerGeneration !== undefined) session.workerGeneration = mutation.workerGeneration;
          session.groupWorkspaceFollow = mutation.journal;
        },
        retire: async candidate => {
          const retired = await retireWorkerForReplacement(candidate, { timeoutMs: 5_000 });
          if (retired) liveWorkers = 0;
          return retired;
        },
        spawn: (candidate, reserved) => {
          if (liveWorkers > 0) throw new Error('overlapping workers');
          session.workerGeneration = (session.workerGeneration ?? 0) + 1;
          candidate.workerGeneration = session.workerGeneration;
          reserved(session.workerGeneration);
          current = startWorker({ root, workingDir: candidate.workingDir, cliId: 'claude-code', cliPath,
            sessionId, generation: session.workerGeneration });
          candidate.worker = current.child;
          candidate.workerReady = false;
          candidate.cliReady = false;
          liveWorkers = 1;
          return true;
        },
        awaitReady: async candidate => {
          await waitUntil(() => current.messages.some(message => message.type === 'prompt_ready'), () => current.logs.join(''));
          candidate.workerReady = true;
          candidate.cliReady = true;
          return { ready: true, workingDir: candidate.workingDir };
        },
        notice: () => undefined,
      });

      expect(result).toEqual({ kind: 'migrated' });
      expect(session.groupWorkspaceFollow).toBeUndefined();
      expect(liveWorkers).toBeLessThanOrEqual(1);
      expect(readFileSync(deliveries, 'utf8')).toBe('');
      current.child.send({ type: 'message', content: 'AFTER_RECOVERY', turnId: `om_${phase}` } satisfies DaemonToWorker);
      await waitUntil(() => readFileSync(deliveries, 'utf8').includes('AFTER_RECOVERY'), () => current.logs.join(''));
      const delivered = readFileSync(deliveries, 'utf8');
      expect(delivered).not.toContain(`${realpathSync(oldDir)}\tAFTER_RECOVERY`);
      expect(delivered).toContain(`${realpathSync(frozenDir)}\tAFTER_RECOVERY`);
      expect(resolveGroupWorkspaceFollowTarget({
        group: { status: 'available', record: { revision: 3, directory: { kind: 'unbound' } } },
        currentRevision: session.groupWorkspaceRevision,
      })).toEqual({ kind: 'continue' });
      // The unbound policy is consulted only by future sessions; this recovered
      // persisted session remains safely frozen at r2 rather than silently
      // switching to the fallback directory mid-session.
      expect(session.workingDir).toBe(frozenDir);
      expect(session.workingDir).not.toBe(fallbackDir);
    }, 60_000,
  );

  it.each([
    ['claude-code', '❯ '] as const,
    ['codex', '› '] as const,
  ])('retires %s, starts in the new cwd, and delivers the business turn once', async (cliId, prompt) => {
    const root = mkdtempSync(join(tmpdir(), `botmux-follow-${cliId}-`));
    roots.add(root);
    const oldDir = join(root, 'old');
    const newDir = join(root, 'new');
    const dataDir = join(root, 'data');
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    const deliveries = join(root, 'deliveries');
    const cliPath = join(root, cliId === 'codex' ? 'fake-codex' : 'fake-claude');
    writeFileSync(deliveries, '');
    writeFileSync(cliPath, fakeCliSource(prompt, deliveries));
    chmodSync(cliPath, 0o755);
    const sessionId = `follow-${cliId}`;
    const old = startWorker({ root, workingDir: oldDir, cliId, cliPath, sessionId, generation: 1 });
    await waitUntil(() => old.messages.some(message => message.type === 'prompt_ready'), () => old.logs.join(''));

    const ds = {
      session: {
        sessionId, chatId: 'oc_follow', rootMessageId: 'oc_follow', status: 'active',
        createdAt: new Date().toISOString(), larkAppId: 'app_follow_real', scope: 'chat',
        cliId, backendType: 'pty', workingDir: oldDir, workingDirSource: 'group',
        groupWorkspaceRevision: 1, workerGeneration: 1,
      },
      worker: old.child, workerPort: null, workerToken: null, larkAppId: 'app_follow_real',
      chatId: 'oc_follow', chatType: 'group', scope: 'chat', spawnedAt: Date.now(),
      lastMessageAt: Date.now(), hasHistory: false, workingDir: oldDir, initConfig: { backendType: 'pty' },
      workerGeneration: 1, workerReady: true, cliReady: true, lastScreenStatus: 'idle',
    } as unknown as DaemonSession;
    let current = old;
    const order: string[] = [];
    const result = await runGroupWorkspaceSessionFollow(ds, { workingDir: newDir, revision: 2 }, {
      isIdle: () => true,
      supportsReplacement: () => true,
      isWorkerLive: candidate => !!candidate.worker && !candidate.worker.killed,
      persist: mutation => {
        if (mutation.source && mutation.workingDir) {
          ds.session.workingDir = mutation.workingDir;
          ds.session.workingDirSource = mutation.source;
          ds.session.groupWorkspaceRevision = mutation.groupWorkspaceRevision;
          ds.workingDir = mutation.workingDir;
        }
        ds.session.groupWorkspaceFollow = mutation.journal;
      },
      retire: async candidate => {
        order.push('retire');
        return retireWorkerForReplacement(candidate, { timeoutMs: 5_000 });
      },
      spawn: (candidate, reserved) => {
        order.push('spawn');
        candidate.session.workerGeneration = 2;
        candidate.workerGeneration = 2;
        reserved(2);
        current = startWorker({ root, workingDir: newDir, cliId, cliPath, sessionId, generation: 2 });
        candidate.worker = current.child;
        candidate.workerReady = false;
        candidate.cliReady = false;
        return true;
      },
      awaitReady: async candidate => {
        await waitUntil(() => current.messages.some(message => message.type === 'prompt_ready'), () => current.logs.join(''));
        candidate.workerReady = true;
        candidate.cliReady = true;
        return { ready: true, workingDir: candidate.workingDir };
      },
      notice: () => undefined,
    });

    expect(result).toEqual({ kind: 'migrated' });
    expect(order).toEqual(['retire', 'spawn']);
    expect(old.child.exitCode ?? old.child.signalCode).not.toBeNull();
    current.child.send({ type: 'message', content: 'DELIVER_ONCE', turnId: 'om_follow_once' } satisfies DaemonToWorker);
    await waitUntil(() => readFileSync(deliveries, 'utf8').includes('DELIVER_ONCE'), () => current.logs.join(''));
    const delivered = readFileSync(deliveries, 'utf8');
    expect(delivered.match(/DELIVER_ONCE/g)).toHaveLength(1);
    expect(delivered.startsWith(`${realpathSync(newDir)}\tDELIVER_ONCE`)).toBe(true);
  }, 60_000);
});
