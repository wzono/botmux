import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runGroupWorkspaceRepoEntrypoint } from '../src/core/command-handler.js';
import type { DaemonSession } from '../src/core/types.js';
import {
  GroupWorkspaceOperationCoordinator,
  executeGroupWorkspaceUnbind,
  type GroupCommitReceipt,
  type GroupWorkspaceOperationDependencies,
} from '../src/core/group-workspace-operation.js';
import {
  canManageGroupWorkspace,
  resolveGroupWorkspaceCwd,
} from '../src/core/group-workspace-policy.js';
import {
  applySessionWorkingDir,
  resolveGroupWorkspaceFollowTarget,
  runGroupWorkspaceSessionFollow,
} from '../src/core/session-cwd.js';
import {
  botAdminIdentityConfigFingerprint,
  loadFreshBotAdminUnionSnapshot,
  type BotAdminIdentityConfig,
  type TenantHumanId,
} from '../src/services/bot-admin-unions-store.js';
import { GroupWorkspaceOperationStore } from '../src/services/group-workspace-operation-store.js';
import * as sessionStore from '../src/services/session-store.js';
import {
  canonicalGroupWorkspaceRequestIntentDigest,
  canonicalTextSourceEventId,
  GroupWorkspaceStore,
  groupWorkspaceOperationKey,
  type GroupOperationReceipt,
  type GroupWorkspaceStoreOptions,
} from '../src/services/group-workspace-store.js';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  class FakeWSClient { start() {} }
  class FakeEventDispatcher { register() {} }
  return { Client: FakeClient, WSClient: FakeWSClient, EventDispatcher: FakeEventDispatcher, LoggerLevel: { info: 2 } };
});

const roots = new Set<string>();
const CHAT = 'oc_group_workspace_e2e';
const ACTOR: TenantHumanId = { tenantKey: 'tenant-shared', unionId: 'on_shared_admin' };
const OTHER: TenantHumanId = { tenantKey: 'tenant-shared', unionId: 'on_other_admin' };

afterEach(() => {
  delete process.env.SESSION_DATA_DIR;
  vi.restoreAllMocks();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `botmux-group-e2e-${label}-`));
  roots.add(root);
  return root;
}

function makeDir(root: string, name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function textSource(messageId: string, attempt = 'attempt-a'): string {
  const source = canonicalTextSourceEventId({
    tenantKey: ACTOR.tenantKey,
    chatId: CHAT,
    messageId,
    deliveryEventId: `delivery-${attempt}`,
    deliveryAttemptId: attempt,
  });
  if (!source.ok) throw new Error(source.reason);
  return source.sourceEventId;
}

function receiptToCommit(receipt: GroupOperationReceipt): GroupCommitReceipt | undefined {
  if (receipt.kind !== 'set' || !receipt.canonicalTargetWorkingDir) return undefined;
  const base = {
    operationKey: receipt.operationKey,
    payloadDigest: receipt.payloadDigest,
    chatId: receipt.chatId,
    targetWorkingDir: receipt.canonicalTargetWorkingDir,
  };
  if (receipt.outcome === 'committed') return { ...base, status: 'committed', resultingRevision: receipt.resultingRevision! };
  if (receipt.outcome === 'conflict') return { ...base, status: 'conflict', currentRevision: receipt.expectedRevision };
  if (receipt.outcome === 'store_unavailable') return { ...base, status: 'store_unavailable' };
  return undefined;
}

interface DurableHarness {
  dataDir: string;
  groupStore: GroupWorkspaceStore;
  operationStore: GroupWorkspaceOperationStore;
  coordinator: GroupWorkspaceOperationCoordinator;
  session: { generation: number; workingDir: string; source: 'explicit' | 'group'; groupRevision?: number };
  replies: string[];
  calls: string[];
  switches: number;
  workerStarts: number;
  execute(messageId: string, selection: string): Promise<ReturnType<GroupWorkspaceOperationCoordinator['execute']> extends Promise<infer T> ? T : never>;
  restart(crashAt?: string): DurableHarness;
}

function durableHarness(input: {
  dataDir: string;
  targetBySelection: Map<string, string>;
  session?: DurableHarness['session'];
  counters?: { switches: number; workerStarts: number };
  replies?: string[];
  crashAt?: string;
  pathProbe?: GroupWorkspaceStoreOptions['pathProbe'];
}): DurableHarness {
  const groupStore = new GroupWorkspaceStore(input.dataDir, input.pathProbe ? { pathProbe: input.pathProbe } : {});
  const operationStore = new GroupWorkspaceOperationStore(input.dataDir);
  const session = input.session ?? { generation: 0, workingDir: makeDir(input.dataDir, 'initial'), source: 'explicit' };
  const counters = input.counters ?? { switches: 0, workerStarts: 0 };
  const replies = input.replies ?? [];
  const calls: string[] = [];
  const deps: GroupWorkspaceOperationDependencies = {
    journalStore: operationStore,
    now: () => Date.now(),
    lookupGroupReceipt: async operationKey => {
      calls.push('receipt');
      const result = await groupStore.readReceipt(operationKey);
      if (result.status !== 'found') return result;
      const receipt = receiptToCommit(result.receipt);
      return receipt ? { status: 'found', receipt } : { status: 'missing' };
    },
    reconcileUnknownGroupReceipt: async journal => {
      calls.push('unknown-readback');
      const result = await groupStore.reconcileExactOperation({
        kind: 'set', chatId: journal.chatId, sourceEventId: journal.sourceEventId,
        requestedWorkingDir: journal.targetWorkingDir, expectedRevision: journal.expectedGroupRevision,
        expectedSessionGeneration: journal.expectedSessionGeneration, actor: journal.actor,
        authorized: true, directoryValid: true, now: journal.updatedAt,
      });
      if (!('receipt' in result)) return result.outcome === 'store_unavailable'
        ? { status: 'store_unavailable' as const } : { status: 'missing' as const };
      const receipt = receiptToCommit(result.receipt);
      return receipt ? { status: 'found', receipt } : { status: 'missing' };
    },
    readCurrentGroupRevision: async chatId => {
      calls.push('revision');
      const result = await groupStore.read(chatId);
      return result.status === 'available'
        ? { status: 'available', revision: result.record?.revision ?? 0 }
        : result;
    },
    resolveCanonicalTarget: async request => {
      calls.push('target');
      const target = input.targetBySelection.get(request.requestIntentDigest);
      return target ? { status: 'resolved', workingDir: target } : { status: 'store_unavailable' };
    },
    readSession: async () => {
      calls.push('session');
      return { status: 'available', generation: session.generation, workingDir: session.workingDir };
    },
    switchSession: async request => {
      calls.push('switch');
      if (session.generation !== request.expectedGeneration) return { status: 'unknown' };
      session.generation += 1;
      session.workingDir = request.targetWorkingDir;
      session.source = 'explicit';
      session.groupRevision = undefined;
      counters.switches += 1;
      counters.workerStarts += 1;
      return { status: 'committed', generation: session.generation };
    },
    commitGroup: async journal => {
      calls.push('group-commit');
      const result = await groupStore.mutate({
        kind: 'set', chatId: journal.chatId, sourceEventId: journal.sourceEventId,
        requestedWorkingDir: journal.targetWorkingDir, expectedRevision: journal.expectedGroupRevision,
        expectedSessionGeneration: journal.expectedSessionGeneration, actor: journal.actor,
        authorized: true, directoryValid: true, now: journal.updatedAt,
      });
      if (result.outcome === 'unknown') return { status: 'unknown' };
      if (!('receipt' in result)) return { status: 'store_unavailable' };
      if (result.outcome === 'committed') return { status: 'committed', resultingRevision: result.receipt.resultingRevision! };
      if (result.outcome === 'conflict') return { status: 'conflict', currentRevision: result.receipt.expectedRevision };
      return { status: 'store_unavailable' };
    },
    convergeSession: async result => {
      calls.push(`converge:${result.source}`);
      session.source = result.source;
      session.groupRevision = result.groupRevision;
    },
    afterBoundary: async boundary => {
      calls.push(`boundary:${boundary}`);
      if (input.crashAt === boundary) throw new Error(`crash:${boundary}`);
    },
  };
  const coordinator = new GroupWorkspaceOperationCoordinator(deps);
  const execute = async (messageId: string, selection: string) => {
    const sourceEventId = textSource(messageId);
    const requestIntentDigest = canonicalGroupWorkspaceRequestIntentDigest({ chatId: CHAT, kind: 'set', selection });
    const result = await coordinator.execute({
      operationKey: groupWorkspaceOperationKey(sourceEventId, 'set'), sourceEventId, kind: 'set',
      requestIntentDigest, chatId: CHAT, sessionId: 'session-shared', actor: ACTOR,
    });
    if (result.status !== 'unknown') replies.push(result.status);
    return result;
  };
  return {
    dataDir: input.dataDir, groupStore, operationStore, coordinator, session, replies, calls,
    get switches() { return counters.switches; },
    get workerStarts() { return counters.workerStarts; },
    execute,
    restart: crashAt => durableHarness({ ...input, session, counters, replies, crashAt }),
  };
}

describe('cross-Bot shared dataDir and restart', () => {
  it('replays one immutable message through Bot B and resolves /th from the persisted binding', async () => {
    const root = tempRoot('cross-bot');
    const dataDir = makeDir(root, 'data');
    const workspace = makeDir(root, 'workspace-X');
    const intent = canonicalGroupWorkspaceRequestIntentDigest({ chatId: CHAT, kind: 'set', selection: 'X' });
    const targets = new Map([[intent, workspace]]);
    const botA = durableHarness({ dataDir, targetBySelection: targets });

    const first = await botA.execute('om_original', 'X');
    expect(first).toMatchObject({ status: 'group_committed', groupRevision: 1 });
    const sourceA = canonicalTextSourceEventId({ tenantKey: ACTOR.tenantKey, chatId: CHAT, messageId: 'om_original', deliveryEventId: 'evt-a', deliveryAttemptId: 'try-a' });
    const sourceB = canonicalTextSourceEventId({ tenantKey: ACTOR.tenantKey, chatId: CHAT, messageId: 'om_original', deliveryEventId: 'evt-b', deliveryAttemptId: 'try-b' });
    const fallback = canonicalTextSourceEventId({ chatId: CHAT, messageId: 'om_original', verifiedTenantMapping: { tenantKey: ACTOR.tenantKey, verifiedAcrossApps: true } });
    expect(sourceB).toEqual(sourceA);
    expect(fallback).toEqual(sourceA);
    expect(canonicalTextSourceEventId({ chatId: CHAT, messageId: 'om_original' }))
      .toEqual({ ok: false, reason: 'unverifiable_tenant' });

    const botB = botA.restart();
    const replay = await botB.execute('om_original', 'X');
    expect(replay).toMatchObject({ status: 'group_committed', groupRevision: 1 });
    expect(botB.switches).toBe(1);
    expect(botB.workerStarts).toBe(1);
    expect(await botB.operationStore.getByIntent((sourceB as { ok: true; sourceEventId: string }).sourceEventId, 'set'))
      .toMatchObject({ status: 'found', journal: { phase: 'group_committed', expectedGroupRevision: 0, targetWorkingDir: workspace } });

    process.env.SESSION_DATA_DIR = dataDir;
    vi.resetModules();
    const registry = await import('../src/bot-registry.js');
    registry.registerBot({ larkAppId: 'bot-b', larkAppSecret: 'secret', cliId: 'claude-code' });
    const daemon = await import('../src/daemon.js');
    const thread = await daemon.__testOnly_resolvePinnedWorkingDir({
      scope: 'thread', anchor: CHAT, chatId: CHAT, chatType: 'group', larkAppId: 'bot-b',
    });
    expect(thread).toMatchObject({
      inheritedFrom: null,
      pinnedWorkingDir: workspace,
      resolution: { status: 'selected', source: 'group', workingDir: workspace, groupWorkspaceRevision: 1 },
    });
  }, 30_000);

  it('refreshes the complete two-Bot fingerprint, honors manager override, and survives profile rewrite', async () => {
    const root = tempRoot('identity');
    const dataDir = makeDir(root, 'data');
    const workspace = makeDir(root, 'workspace');
    const configs: BotAdminIdentityConfig[] = [
      { larkAppId: 'app-a', tenantKey: ACTOR.tenantKey, resolvedAllowedUsers: ['ou_a'] },
      { larkAppId: 'app-b', tenantKey: ACTOR.tenantKey, resolvedAllowedUsers: ['ou_b'] },
    ];
    const snapshot = await loadFreshBotAdminUnionSnapshot({
      registeredBots: configs,
      resolveAllowedUser: async (_bot, entry) => entry === 'ou_a' || entry === 'ou_b' ? ACTOR : undefined,
      now: () => 100,
    });
    expect(snapshot).toMatchObject({ configFingerprint: botAdminIdentityConfigFingerprint(configs), admins: [ACTOR] });
    expect(canManageGroupWorkspace({ actor: ACTOR, freshSnapshot: snapshot })).toBe(true);
    expect(canManageGroupWorkspace({ actor: ACTOR, freshSnapshot: snapshot, workspaceManagers: [OTHER] })).toBe(false);
    expect(await loadFreshBotAdminUnionSnapshot({
      registeredBots: [...configs, { larkAppId: 'app-c', tenantKey: ACTOR.tenantKey, resolvedAllowedUsers: ['ou_unresolved'] }],
      snapshot,
      resolveAllowedUser: async () => undefined,
      now: () => 101,
    })).toBeUndefined();

    const store = new GroupWorkspaceStore(dataDir);
    await store.mutate({ kind: 'set', chatId: CHAT, sourceEventId: textSource('om_profile'), requestedWorkingDir: workspace,
      expectedRevision: 0, expectedSessionGeneration: 0, actor: ACTOR, authorized: true, directoryValid: true, now: 1 });
    const before = readFileSync(join(dataDir, 'group-workspaces.json'), 'utf8');
    writeFileSync(join(dataDir, 'bots.json'), JSON.stringify([{ larkAppId: 'app-b', profile: 'rewritten' }]));
    expect(readFileSync(join(dataDir, 'group-workspaces.json'), 'utf8')).toBe(before);
    await expect(new GroupWorkspaceStore(dataDir).read(CHAT)).resolves.toMatchObject({
      status: 'available', record: { revision: 1, directory: { workingDir: workspace } },
    });
  });

  it('fails closed when a bound directory becomes inaccessible', async () => {
    const root = tempRoot('inaccessible');
    const dataDir = makeDir(root, 'data');
    const workspace = makeDir(root, 'workspace');
    let accessible = true;
    const store = new GroupWorkspaceStore(dataDir, { pathProbe: path => accessible
      ? { ok: true, normalizedPath: resolve(path), identity: { dev: '1', ino: '2' } }
      : { ok: false, normalizedPath: resolve(path), reason: 'inaccessible' } });
    await store.mutate({ kind: 'set', chatId: CHAT, sourceEventId: textSource('om_access'), requestedWorkingDir: workspace,
      expectedRevision: 0, actor: ACTOR, authorized: true, directoryValid: true, now: 1 });
    accessible = false;
    expect(await store.probeBoundDirectoryForConsumption(CHAT)).toMatchObject({
      status: 'unusable', record: { revision: 1, directory: { workingDir: workspace } }, usability: { reason: 'inaccessible' },
    });
  });
});

describe('durable crash and replay matrix', () => {
  it.each([
    'prepared_before_switch',
    'session_persisted_before_advance',
    'group_committed_before_convergence',
    'receipt_before_response',
  ] as const)('recovers %s with one switch, receipt, worker, and terminal response', async crashAt => {
    const root = tempRoot(crashAt);
    const dataDir = makeDir(root, 'data');
    const workspace = makeDir(root, 'X');
    const intent = canonicalGroupWorkspaceRequestIntentDigest({ chatId: CHAT, kind: 'set', selection: 'X' });
    const first = durableHarness({ dataDir, targetBySelection: new Map([[intent, workspace]]), crashAt });
    await expect(first.execute('om_crash', 'X')).rejects.toThrow(`crash:${crashAt}`);

    const restarted = first.restart();
    const result = await restarted.execute('om_crash', 'X');
    expect(result).toMatchObject({ status: 'group_committed', groupRevision: 1 });
    expect(restarted.session).toEqual({ generation: 1, workingDir: workspace, source: 'group', groupRevision: 1 });
    expect(restarted.switches).toBe(1);
    expect(restarted.workerStarts).toBe(1);
    expect(restarted.replies).toEqual(['group_committed']);
    const source = textSource('om_crash');
    const operationKey = groupWorkspaceOperationKey(source, 'set');
    const [group, journal, receipt] = await Promise.all([
      restarted.groupStore.read(CHAT),
      restarted.operationStore.get(operationKey),
      restarted.groupStore.readReceipt(operationKey),
    ]);
    expect(group).toMatchObject({
      status: 'available', record: { revision: 1, directory: { workingDir: workspace } },
    });
    expect(journal).toMatchObject({
      status: 'found', journal: { phase: 'group_committed', groupRevisionAfter: 1 },
    });
    expect(receipt).toMatchObject({
      status: 'found', receipt: { outcome: 'committed', resultingRevision: 1 },
    });
  });

  it('replays the durable success after a reply crash without another switch or revision', async () => {
    const root = tempRoot('reply-pending');
    const dataDir = makeDir(root, 'data');
    const workspace = makeDir(root, 'X');
    const intent = canonicalGroupWorkspaceRequestIntentDigest({ chatId: CHAT, kind: 'set', selection: 'X' });
    const harness = durableHarness({ dataDir, targetBySelection: new Map([[intent, workspace]]) });
    let firstReply = true;
    await expect(runGroupWorkspaceRepoEntrypoint({
      kind: 'set', source: 'text', chatId: CHAT, actor: ACTOR, selection: 'X', messageId: 'om_reply_pending',
      deliveryAttemptId: 'bot-a-attempt',
    }, {
      executeSet: async () => harness.execute('om_reply_pending', 'X'),
      executeUnbind: async () => ({ status: 'aborted' }),
      reply: async () => { if (firstReply) { firstReply = false; throw new Error('reply transport crashed'); } },
    })).rejects.toThrow('reply transport crashed');
    expect(harness.switches).toBe(1);
    expect(await harness.groupStore.read(CHAT)).toMatchObject({ record: { revision: 1 } });

    const restarted = harness.restart();
    const replies: string[] = [];
    const replay = await runGroupWorkspaceRepoEntrypoint({
      kind: 'set', source: 'text', chatId: CHAT, actor: ACTOR, selection: 'X', messageId: 'om_reply_pending',
      deliveryAttemptId: 'bot-b-recovery',
    }, {
      executeSet: async () => restarted.execute('om_reply_pending', 'X'),
      executeUnbind: async () => ({ status: 'aborted' }),
      reply: async message => { replies.push(message); },
    });
    expect(replay).toMatchObject({ status: 'group_committed', groupRevision: 1 });
    expect(restarted.switches).toBe(1);
    expect(restarted.workerStarts).toBe(1);
    expect(replies).toHaveLength(1);
    expect(await restarted.groupStore.read(CHAT)).toMatchObject({ record: { revision: 1 } });
  });

  it('keeps M2 current when M1 replays and rejects changed M1 intent before mutable reads', async () => {
    const root = tempRoot('m1-m2');
    const dataDir = makeDir(root, 'data');
    const x = makeDir(root, 'X');
    const y = makeDir(root, 'Y');
    const xIntent = canonicalGroupWorkspaceRequestIntentDigest({ chatId: CHAT, kind: 'set', selection: 'X' });
    const yIntent = canonicalGroupWorkspaceRequestIntentDigest({ chatId: CHAT, kind: 'set', selection: 'Y' });
    const targets = new Map([[xIntent, x], [yIntent, y]]);
    const first = durableHarness({ dataDir, targetBySelection: targets });
    await first.execute('om_m1', 'X');
    await first.execute('om_m2', 'Y');

    const replay = first.restart();
    const result = await replay.execute('om_m1', 'X');
    expect(result).toMatchObject({ status: 'group_committed', groupRevision: 1 });
    expect(replay.calls).not.toContain('revision');
    expect(replay.calls).not.toContain('target');
    const [group, m1] = await Promise.all([
      replay.groupStore.read(CHAT),
      replay.operationStore.getByIntent(textSource('om_m1'), 'set'),
    ]);
    expect(group).toMatchObject({
      status: 'available', record: { revision: 2, directory: { workingDir: y } },
    });
    expect(m1).toMatchObject({ status: 'found', journal: {
      targetWorkingDir: x, expectedGroupRevision: 0, expectedSessionGeneration: 0,
    } });
    if (m1.status !== 'found') throw new Error('M1 journal missing');
    const payloadBefore = m1.journal.payloadDigest;
    const changed = await replay.execute('om_m1', 'Y');
    expect(changed.status).toBe('protocol_conflict');
    expect((await replay.operationStore.getByIntent(textSource('om_m1'), 'set'))).toMatchObject({
      status: 'found', journal: { payloadDigest: payloadBefore },
    });
  });

  it('keeps revisions and ACL monotonic across set-unbind-set-old-CAS', async () => {
    const root = tempRoot('monotonic');
    const dataDir = makeDir(root, 'data');
    const x = makeDir(root, 'X');
    const y = makeDir(root, 'Y');
    const path = join(dataDir, 'group-workspaces.json');
    const store = new GroupWorkspaceStore(dataDir);
    const seed = await store.mutate({ kind: 'set', chatId: CHAT, sourceEventId: textSource('om_set_x'), requestedWorkingDir: x,
      expectedRevision: 0, actor: ACTOR, authorized: true, directoryValid: true, now: 1 });
    expect(seed.outcome).toBe('committed');
    const registry = JSON.parse(readFileSync(path, 'utf8'));
    registry.records[CHAT].workspaceManagers = [ACTOR];
    writeFileSync(path, JSON.stringify(registry));

    const operationStore = new GroupWorkspaceOperationStore(dataDir);
    await executeGroupWorkspaceUnbind({ sourceEventId: textSource('om_unbind'), chatId: CHAT, actor: ACTOR }, {
      journalStore: operationStore,
      readReceipt: key => store.readReceipt(key),
      readCurrentRevision: async () => ({ status: 'available', revision: 1 }),
      mutate: mutation => store.mutate(mutation),
      now: () => 2,
    });
    expect(await store.read(CHAT)).toMatchObject({ record: { revision: 2, directory: { kind: 'unbound' }, workspaceManagers: [ACTOR] } });
    expect((await store.mutate({ kind: 'set', chatId: CHAT, sourceEventId: textSource('om_other'), requestedWorkingDir: y,
      expectedRevision: 2, actor: OTHER, authorized: true, directoryValid: true, now: 3 })).outcome).toBe('unauthorized');
    expect((await store.mutate({ kind: 'set', chatId: CHAT, sourceEventId: textSource('om_set_y'), requestedWorkingDir: y,
      expectedRevision: 2, actor: ACTOR, authorized: true, directoryValid: true, now: 4 })).outcome).toBe('committed');
    expect((await store.mutate({ kind: 'set', chatId: CHAT, sourceEventId: textSource('om_old_cas'), requestedWorkingDir: x,
      expectedRevision: 1, actor: ACTOR, authorized: true, directoryValid: true, now: 5 })).outcome).toBe('conflict');
    expect(await store.read(CHAT)).toMatchObject({ record: { revision: 3, directory: { workingDir: y }, workspaceManagers: [ACTOR] } });
  });
});

describe('precedence, explicit provenance, and safe local follow', () => {
  it('lets group beat automatic defaultOncall, but not explicit oncall', () => {
    const group = { status: 'usable' as const, workingDir: '/group', revision: 2 };
    expect(resolveGroupWorkspaceCwd({ oncall: { workingDir: '/auto', provenance: 'oncall-default-auto' }, group }))
      .toMatchObject({ status: 'selected', source: 'group', workingDir: '/group' });
    expect(resolveGroupWorkspaceCwd({ oncall: { workingDir: '/explicit', provenance: 'oncall-explicit' }, group }))
      .toMatchObject({ status: 'selected', source: 'oncall-explicit', workingDir: '/explicit' });
  });

  it('records /cd as explicit and prevents a later group revision from following', () => {
    const session = { sessionId: 's', workingDir: '/group-r1', workingDirSource: 'group', groupWorkspaceRevision: 1 } as any;
    const ds = { session, workingDir: '/group-r1', scope: 'chat' } as DaemonSession;
    vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
    applySessionWorkingDir(ds, { workingDir: '/cd-explicit', source: 'explicit' });
    expect(session).toMatchObject({ workingDir: '/cd-explicit', workingDirSource: 'explicit' });
    expect(session.groupWorkspaceRevision).toBeUndefined();
    expect(resolveGroupWorkspaceFollowTarget({
      currentRevision: session.groupWorkspaceRevision,
      group: { status: 'available', record: { revision: 2, directory: { kind: 'bound', workingDir: '/group-r2' } } },
    })).toEqual({ kind: 'follow', target: { workingDir: '/group-r2', revision: 2 } });
    // The follow coordinator itself is the final policy gate for explicit sessions.
    return expect(runGroupWorkspaceSessionFollow(ds, { workingDir: '/group-r2', revision: 2 }, {
      isIdle: () => true, supportsReplacement: () => true, isWorkerLive: () => true,
      persist: () => { throw new Error('must not persist'); }, retire: async () => { throw new Error('must not retire'); },
      spawn: () => { throw new Error('must not spawn'); }, awaitReady: async () => ({ ready: true }), notice: () => undefined,
    })).resolves.toEqual({ kind: 'unchanged' });
  });

  it('retires one local worker before spawning and delivering on the new cwd', async () => {
    const root = tempRoot('follow');
    const oldDir = makeDir(root, 'old');
    const newDir = makeDir(root, 'new');
    const delivered: string[] = [];
    const order: string[] = [];
    let liveWorkers = 1;
    const session = {
      sessionId: 'follow', workingDir: oldDir, workingDirSource: 'group', groupWorkspaceRevision: 1,
      workerGeneration: 1,
    } as any;
    const ds = { session, workingDir: oldDir, scope: 'chat', workerGeneration: 1 } as DaemonSession;
    const result = await runGroupWorkspaceSessionFollow(ds, { workingDir: newDir, revision: 2 }, {
      isIdle: () => true,
      supportsReplacement: () => true,
      isWorkerLive: () => liveWorkers === 1,
      persist: mutation => {
        if (mutation.workingDir && mutation.source) {
          session.workingDir = mutation.workingDir;
          session.workingDirSource = mutation.source;
          session.groupWorkspaceRevision = mutation.groupWorkspaceRevision;
          ds.workingDir = mutation.workingDir;
        }
        if (mutation.workerGeneration !== undefined) session.workerGeneration = mutation.workerGeneration;
        session.groupWorkspaceFollow = mutation.journal;
      },
      retire: async () => { order.push('retire'); liveWorkers = 0; return true; },
      spawn: (_candidate, reserve) => {
        expect(liveWorkers).toBe(0);
        order.push('spawn'); liveWorkers = 1; session.workerGeneration = 2; reserve(2); return true;
      },
      awaitReady: async () => ({ ready: true, workingDir: ds.workingDir }),
      notice: kind => order.push(`notice:${kind}`),
    });
    if (result.kind === 'migrated') delivered.push(`${ds.workingDir}:business-turn`);
    expect(result).toEqual({ kind: 'migrated' });
    expect(order).toEqual(['retire', 'spawn', 'notice:migrated']);
    expect(liveWorkers).toBe(1);
    expect(delivered).toEqual([`${newDir}:business-turn`]);
  });
});
