import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TenantHumanId } from '../src/services/bot-admin-unions-store.js';
import { groupWorkspaceOperationKey } from '../src/services/group-workspace-store.js';
import {
  GroupWorkspaceOperationStore,
  type RepoGroupOperationJournal,
} from '../src/services/group-workspace-operation-store.js';
import {
  GroupWorkspaceOperationCoordinator,
  type GroupCommitReceipt,
  type GroupCommitResult,
  type GroupWorkspaceOperationDependencies,
} from '../src/core/group-workspace-operation.js';

const ACTOR: TenantHumanId = { tenantKey: 'tenant-a', unionId: 'on_user' };
const SOURCE_EVENT_ID = 'group-workspace-text-source-v1:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BASE = {
  operationKey: groupWorkspaceOperationKey(SOURCE_EVENT_ID, 'set'), sourceEventId: SOURCE_EVENT_ID, kind: 'set' as const,
  payloadDigest: 'intent-X', chatId: 'chat-1', sessionId: 'session-1',
  expectedSessionGeneration: 4, expectedGroupRevision: 2,
  targetWorkingDir: '/repo/X', actor: ACTOR,
};

function dir(): string { return mkdtempSync(join(tmpdir(), 'botmux-operation-')); }
function journal(phase: RepoGroupOperationJournal['phase'] = 'prepared'): RepoGroupOperationJournal {
  return { ...BASE, phase, updatedAt: 1 };
}

describe('GroupWorkspaceOperationStore', () => {
  it('persists legal transitions and rejects skipped or backward transitions', async () => {
    const dataDir = dir();
    const store = new GroupWorkspaceOperationStore(dataDir);
    expect((await store.prepare(journal())).status).toBe('created');
    await expect(store.transition(BASE.operationKey, 'group_committed', { updatedAt: 2 })).resolves.toMatchObject({ status: 'invalid_transition' });
    await expect(store.transition(BASE.operationKey, 'session_committed', { sessionGenerationAfter: 5, updatedAt: 3 })).resolves.toMatchObject({ status: 'updated' });
    await expect(store.transition(BASE.operationKey, 'group_committed', { groupRevisionAfter: 3, updatedAt: 4 })).resolves.toMatchObject({ status: 'updated' });
    await expect(store.transition(BASE.operationKey, 'session_committed', { updatedAt: 5 })).resolves.toMatchObject({ status: 'invalid_transition' });
    await expect(new GroupWorkspaceOperationStore(dataDir).get(BASE.operationKey)).resolves.toMatchObject({ status: 'found', journal: { phase: 'group_committed', sessionGenerationAfter: 5, groupRevisionAfter: 3 } });
  });

  it.each(['conflict', 'store_unavailable'] as const)('allows session_committed to terminate as %s', async phase => {
    const store = new GroupWorkspaceOperationStore(dir());
    await store.prepare(journal());
    await store.transition(BASE.operationKey, 'session_committed', { sessionGenerationAfter: 5, updatedAt: 2 });
    await expect(store.transition(BASE.operationKey, phase, { updatedAt: 3 })).resolves.toMatchObject({ status: 'updated', journal: { phase } });
  });

  it('allows unresolved I/O to become unknown and only explicit receipt convergence can terminate it', async () => {
    const dataDir = dir();
    const store = new GroupWorkspaceOperationStore(dataDir);
    await store.prepare(journal());
    await expect(store.transition(BASE.operationKey, 'unknown', { sessionGenerationAfter: 5, updatedAt: 2 })).resolves.toMatchObject({ status: 'updated' });
    await expect(store.transition(BASE.operationKey, 'session_committed', { updatedAt: 3 })).resolves.toMatchObject({ status: 'invalid_transition' });
    await expect(store.transition(BASE.operationKey, 'group_committed', { groupRevisionAfter: 3, updatedAt: 3 })).resolves.toMatchObject({ status: 'invalid_transition' });
    await expect(store.convergeReceipt(BASE.operationKey, 'group_committed', { groupRevisionAfter: 3, updatedAt: 4 })).resolves.toMatchObject({ status: 'updated', journal: { phase: 'group_committed' } });
    await expect(new GroupWorkspaceOperationStore(dataDir).get(BASE.operationKey)).resolves.toMatchObject({ status: 'found', journal: { phase: 'group_committed' } });
  });

  it('surfaces real journal writer and lock failures without a partial journal', async () => {
    const writeDir = dir();
    const writeStore = new GroupWorkspaceOperationStore(writeDir, {
      writer: () => { const error = new Error('disk full') as NodeJS.ErrnoException; error.code = 'ENOSPC'; throw error; },
    });
    await expect(writeStore.prepare(journal())).resolves.toEqual({ status: 'store_unavailable' });
    await expect(new GroupWorkspaceOperationStore(writeDir).get(BASE.operationKey)).resolves.toEqual({ status: 'missing' });

    const lockDir = dir();
    writeFileSync(join(lockDir, 'group-workspace-operations.json.lock'), String(process.pid));
    const lockStore = new GroupWorkspaceOperationStore(lockDir, { lockTimeoutMs: 0 });
    await expect(lockStore.prepare(journal())).resolves.toEqual({ status: 'store_unavailable' });
  });

  it('loads a legacy schema-v1 journal without an index and derives its canonical intent index', async () => {
    const dataDir = dir();
    const path = join(dataDir, 'group-workspace-operations.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, operations: { [BASE.operationKey]: journal() } }));
    await expect(new GroupWorkspaceOperationStore(dataDir).getByIntent(BASE.sourceEventId, BASE.kind)).resolves.toMatchObject({
      status: 'found', journal: { operationKey: BASE.operationKey },
    });
  });

  it('looks up the canonical source/kind index and rejects a corrupt index', async () => {
    const dataDir = dir();
    const store = new GroupWorkspaceOperationStore(dataDir);
    await store.prepare(journal());
    await expect(store.getByIntent(BASE.sourceEventId, BASE.kind)).resolves.toMatchObject({ status: 'found', journal: { operationKey: BASE.operationKey } });
    const path = join(dataDir, 'group-workspace-operations.json');
    const registry = JSON.parse(readFileSync(path, 'utf8'));
    registry.sourceIndex[JSON.stringify([BASE.sourceEventId, BASE.kind])] = 'wrong';
    writeFileSync(path, JSON.stringify(registry));
    await expect(new GroupWorkspaceOperationStore(dataDir).getByIntent(BASE.sourceEventId, BASE.kind)).resolves.toEqual({ status: 'store_unavailable' });
  });
});

interface Harness {
  coordinator: GroupWorkspaceOperationCoordinator;
  store: GroupWorkspaceOperationStore;
  calls: string[];
  session: { generation: number; workingDir: string };
  readonly revision: number;
  readonly switches: number;
  readonly workers: number;
  readonly commits: number;
  receipts: Map<string, GroupCommitReceipt>;
}

function receipt(result: Exclude<GroupCommitResult, { status: 'unknown' }>, patch: Partial<GroupCommitReceipt> = {}): GroupCommitReceipt {
  return {
    ...result,
    operationKey: BASE.operationKey,
    payloadDigest: BASE.payloadDigest,
    chatId: BASE.chatId,
    targetWorkingDir: BASE.targetWorkingDir,
    ...patch,
  };
}

function harness(options: {
  dataDir?: string;
  crashAt?: string;
  commitResult?: GroupCommitResult;
  target?: string;
  revision?: number;
} = {}): Harness {
  const store = new GroupWorkspaceOperationStore(options.dataDir ?? dir());
  const calls: string[] = [];
  const session = { generation: 4, workingDir: '/old' };
  const receipts = new Map<string, GroupCommitResult>();
  let revision = options.revision ?? 2;
  let switches = 0, workers = 0, commits = 0;
  const deps: GroupWorkspaceOperationDependencies = {
    journalStore: store,
    now: () => calls.length + 10,
    lookupGroupReceipt: async key => {
      calls.push('receipt');
      const receipt = receipts.get(key);
      return receipt && receipt.status !== 'unknown'
        ? { status: 'found', receipt }
        : { status: 'missing' };
    },
    reconcileUnknownGroupReceipt: async journal => {
      calls.push('unknown-readback');
      const receipt = receipts.get(journal.operationKey);
      return receipt && receipt.status !== 'unknown'
        ? { status: 'found', receipt }
        : { status: 'missing' };
    },
    readCurrentGroupRevision: async () => { calls.push('revision'); return { status: 'available', revision }; },
    resolveCanonicalTarget: async () => { calls.push('target'); return { status: 'resolved', workingDir: options.target ?? '/repo/X' }; },
    readSession: async () => { calls.push('session-read'); return { status: 'available', ...session }; },
    switchSession: async input => {
      calls.push('switch'); switches += 1; workers += 1;
      session.generation = input.expectedGeneration + 1; session.workingDir = input.targetWorkingDir;
      return { status: 'committed', generation: session.generation };
    },
    commitGroup: async input => {
      calls.push('group-commit'); commits += 1;
      const result = options.commitResult ?? { status: 'committed', resultingRevision: input.expectedGroupRevision + 1 };
      if (result.status !== 'unknown') receipts.set(input.operationKey, receipt(result));
      if (result.status === 'committed') revision = result.resultingRevision;
      return result;
    },
    convergeSession: async input => { calls.push(`converge:${input.source}:${input.groupRevision ?? 'none'}`); },
    afterBoundary: async boundary => {
      calls.push(`boundary:${boundary}`);
      if (options.crashAt === boundary) throw new Error(`crash:${boundary}`);
    },
  };
  return {
    coordinator: new GroupWorkspaceOperationCoordinator(deps), store, calls, session,
    get revision() { return revision; }, get switches() { return switches; },
    get workers() { return workers; }, get commits() { return commits; }, receipts,
  };
}

const REQUEST = {
  operationKey: BASE.operationKey, sourceEventId: BASE.sourceEventId, kind: BASE.kind,
  payloadDigest: BASE.payloadDigest, chatId: BASE.chatId, sessionId: BASE.sessionId, actor: ACTOR,
};

describe('GroupWorkspaceOperationCoordinator', () => {
  it('rejects unbind at the session-to-group coordinator seam', async () => {
    const h = harness();
    await expect(h.coordinator.execute({ ...REQUEST, kind: 'unbind' } as any)).resolves.toMatchObject({ status: 'protocol_conflict' });
    expect(h.switches).toBe(0);
  });

  it('freezes the complete journal before any session side effect', async () => {
    const h = harness({ crashAt: 'prepared_before_switch' });
    await expect(h.coordinator.execute(REQUEST)).rejects.toThrow('crash:prepared_before_switch');
    expect(h.switches).toBe(0);
    await expect(h.store.get(BASE.operationKey)).resolves.toMatchObject({ status: 'found', journal: BASE });
    expect(h.calls.slice(0, 4)).toEqual(['receipt', 'revision', 'target', 'session-read']);
  });

  it('derives the canonical operation key and rejects noncanonical replay intent before mutable reads', async () => {
    const dataDir = dir();
    const first = harness({ dataDir, crashAt: 'prepared_before_switch' });
    await expect(first.coordinator.execute(REQUEST)).rejects.toThrow();
    const replay = harness({ dataDir });
    await expect(replay.coordinator.execute({
      ...REQUEST, operationKey: 'caller-controlled', payloadDigest: 'different-intent',
    })).resolves.toMatchObject({ status: 'protocol_conflict' });
    expect(replay.calls).toEqual([]);
  });

  it('looks up prior intent before target/revision and reuses frozen values after intervening change', async () => {
    const dataDir = dir();
    const first = harness({ dataDir, crashAt: 'prepared_before_switch' });
    await expect(first.coordinator.execute(REQUEST)).rejects.toThrow();
    const replay = harness({ dataDir, target: '/repo/changed', revision: 99 });
    await replay.coordinator.execute(REQUEST);
    expect(replay.calls).not.toContain('target');
    expect(replay.calls).not.toContain('revision');
    expect(replay.calls).toContain('group-commit');
    expect(await replay.store.get(BASE.operationKey)).toMatchObject({ journal: { targetWorkingDir: '/repo/X', expectedGroupRevision: 2, expectedSessionGeneration: 4, payloadDigest: 'intent-X' } });
    await expect(replay.coordinator.execute({ ...REQUEST, payloadDigest: 'different-intent' })).resolves.toMatchObject({ status: 'protocol_conflict' });
  });

  it.each([
    'prepared_before_switch',
    'session_persisted_before_advance',
    'group_committed_before_convergence',
    'receipt_before_response',
  ] as const)('recovers crash at %s without duplicate switch, worker, or revision', async crashAt => {
    const dataDir = dir();
    const first = harness({ dataDir, crashAt });
    await expect(first.coordinator.execute(REQUEST)).rejects.toThrow();
    const second = harness({ dataDir, revision: first.revision });
    second.session.generation = first.session.generation;
    second.session.workingDir = first.session.workingDir;
    for (const [key, value] of first.receipts) second.receipts.set(key, value);
    await expect(second.coordinator.execute(REQUEST)).resolves.toMatchObject({ status: 'group_committed' });
    expect(first.switches + second.switches).toBe(1);
    expect(first.workers + second.workers).toBe(1);
    expect(first.commits + second.commits).toBe(1);
    expect(second.revision).toBe(3);
  });

  it.each([
    [{ status: 'conflict', currentRevision: 9 } as const, 'conflict'],
    [{ status: 'store_unavailable' } as const, 'store_unavailable'],
  ])('keeps switched session explicit on definite group failure %#', async (commitResult, phase) => {
    const h = harness({ commitResult });
    await expect(h.coordinator.execute(REQUEST)).resolves.toMatchObject({ status: phase });
    expect(h.calls).toContain('converge:explicit:none');
    await expect(h.store.get(BASE.operationKey)).resolves.toMatchObject({ journal: { phase } });
  });

  it('keeps a restored group_committed journal unknown when its authoritative receipt was lost', async () => {
    const dataDir = dir();
    const store = new GroupWorkspaceOperationStore(dataDir);
    await store.prepare(journal());
    await store.transition(BASE.operationKey, 'session_committed', { sessionGenerationAfter: 5, updatedAt: 2 });
    const committed = await store.transition(BASE.operationKey, 'group_committed', { groupRevisionAfter: 3, updatedAt: 3 });
    expect(committed).toMatchObject({ status: 'updated' });
    if (committed.status !== 'updated') throw new Error('expected committed journal');

    const replay = harness({ dataDir });
    await expect(replay.coordinator.recover(committed.journal)).resolves.toMatchObject({ status: 'unknown' });
    expect(replay.calls).not.toContain('converge:group:3');
  });

  it('keeps group_committed recovery unknown when the exact receipt revision mismatches the journal', async () => {
    const dataDir = dir();
    const store = new GroupWorkspaceOperationStore(dataDir);
    await store.prepare(journal());
    await store.transition(BASE.operationKey, 'session_committed', { sessionGenerationAfter: 5, updatedAt: 2 });
    const committed = await store.transition(BASE.operationKey, 'group_committed', { groupRevisionAfter: 3, updatedAt: 3 });
    expect(committed).toMatchObject({ status: 'updated' });
    if (committed.status !== 'updated') throw new Error('expected committed journal');

    const replay = harness({ dataDir });
    replay.receipts.set(BASE.operationKey, receipt({ status: 'committed', resultingRevision: 4 }));
    await expect(replay.coordinator.recover(committed.journal)).resolves.toMatchObject({ status: 'unknown' });
    expect(replay.calls).not.toContain('converge:group:4');
  });

  it.each([
    ['operation', { operationKey: `${BASE.operationKey}-other` }],
    ['target', { targetWorkingDir: '/repo/Y' }],
  ] as const)('keeps group_committed recovery unknown when receipt %s mismatches', async (_field, patch) => {
    const dataDir = dir();
    const store = new GroupWorkspaceOperationStore(dataDir);
    await store.prepare(journal());
    await store.transition(BASE.operationKey, 'session_committed', { sessionGenerationAfter: 5, updatedAt: 2 });
    const committed = await store.transition(BASE.operationKey, 'group_committed', { groupRevisionAfter: 3, updatedAt: 3 });
    expect(committed).toMatchObject({ status: 'updated' });
    if (committed.status !== 'updated') throw new Error('expected committed journal');

    const replay = harness({ dataDir });
    replay.receipts.set(BASE.operationKey, receipt({ status: 'committed', resultingRevision: 3 }, patch));
    await expect(replay.coordinator.recover(committed.journal)).resolves.toMatchObject({ status: 'unknown' });
    expect(replay.calls.some(call => call.startsWith('converge:'))).toBe(false);
  });

  it('keeps group_committed recovery unknown when receipt contradicts the committed outcome', async () => {
    const dataDir = dir();
    const store = new GroupWorkspaceOperationStore(dataDir);
    await store.prepare(journal());
    await store.transition(BASE.operationKey, 'session_committed', { sessionGenerationAfter: 5, updatedAt: 2 });
    const committed = await store.transition(BASE.operationKey, 'group_committed', { groupRevisionAfter: 3, updatedAt: 3 });
    expect(committed).toMatchObject({ status: 'updated' });
    if (committed.status !== 'updated') throw new Error('expected committed journal');

    const replay = harness({ dataDir });
    replay.receipts.set(BASE.operationKey, receipt({ status: 'conflict', currentRevision: 3 }));
    await expect(replay.coordinator.recover(committed.journal)).resolves.toMatchObject({ status: 'unknown' });
    expect(replay.calls.some(call => call.startsWith('converge:'))).toBe(false);
  });

  it('durably converges an unknown exact proof through journal then provenance, and replays after callback failure', async () => {
    const dataDir = dir();
    const first = harness({ dataDir, commitResult: { status: 'unknown' } });
    await expect(first.coordinator.execute(REQUEST)).resolves.toMatchObject({ status: 'unknown' });
    const replay = harness({ dataDir });
    replay.session.generation = 5; replay.session.workingDir = '/repo/X';
    replay.receipts.set(BASE.operationKey, receipt({ status: 'committed', resultingRevision: 3 }));
    const originalConverge = (replay.coordinator as any).dependencies.convergeSession;
    (replay.coordinator as any).dependencies.convergeSession = async () => { throw new Error('provenance callback failed'); };
    await expect(replay.coordinator.execute(REQUEST)).rejects.toThrow('provenance callback failed');
    await expect(replay.store.get(BASE.operationKey)).resolves.toMatchObject({ journal: { phase: 'group_committed', groupRevisionAfter: 3 } });
    (replay.coordinator as any).dependencies.convergeSession = originalConverge;
    await expect(replay.coordinator.execute(REQUEST)).resolves.toMatchObject({ status: 'group_committed', groupRevision: 3 });
    expect(replay.commits).toBe(0);
  });

  it('keeps ambiguous group result unknown, reads back before retry, and blocks irreducible replay', async () => {
    const dataDir = dir();
    const first = harness({ dataDir, commitResult: { status: 'unknown' } });
    await expect(first.coordinator.execute(REQUEST)).resolves.toMatchObject({ status: 'unknown' });
    const replay = harness({ dataDir, revision: 2 });
    replay.session.generation = 5; replay.session.workingDir = '/repo/X';
    await expect(replay.coordinator.execute(REQUEST)).resolves.toMatchObject({ status: 'unknown' });
    expect(replay.calls.slice(0, 3)).toEqual(['receipt', 'receipt', 'unknown-readback']);
    expect(replay.switches).toBe(0);
    expect(replay.commits).toBe(0);
  });

  it('mutation probe catches repeat-switch recovery', async () => {
    const dataDir = dir();
    const first = harness({ dataDir, crashAt: 'session_persisted_before_advance' });
    await expect(first.coordinator.execute(REQUEST)).rejects.toThrow();
    const replay = harness({ dataDir });
    replay.session.generation = first.session.generation; replay.session.workingDir = first.session.workingDir;
    await replay.coordinator.execute(REQUEST);
    expect(replay.switches).toBe(0);
  });
});
