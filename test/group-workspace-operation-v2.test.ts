import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';
import {
  GroupWorkspaceOperationStore,
  selectGroupWorkspaceOperationForShow,
} from '../src/services/group-workspace-operation-store.js';
import { OperationExecutorLeaseStore } from '../src/services/operation-executor-lease-store.js';
import { groupWorkspaceOperationKey } from '../src/services/group-workspace-store.js';
import { daemonOwnsGroupWorkspaceRecovery } from '../src/core/group-workspace-operation.js';

const identity = { path: '/repo/x', dev: '1', ino: '2' };
const sourceEventId = 'group-workspace-text-source-v1:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const journal: any = { operationKey: groupWorkspaceOperationKey(sourceEventId, 'set'),
  sourceEventId, kind: 'set',
  requestIntentDigest: 'intent', payloadDigest: 'payload', chatId: 'chat', sessionId: 'session', expectedSessionGeneration: 1,
  expectedGroupRevision: 0, target: { kind: 'workspace', identity }, targetWorkingDir: identity.path, targetWorkspaceIdentity: identity, actor: { tenantKey: 'tenant', unionId: 'on_user' }, phase: 'prepared', updatedAt: 1 };
const dir = () => mkdtempSync(join(tmpdir(), 'operation-v2-'));

describe('same-source winner and executor lease', () => {
  it('leaves a shared migrated ownerless unbind untouched when two Bot daemons perform startup recovery', async () => {
    const dataDir = dir();
    const store = new GroupWorkspaceOperationStore(dataDir);
    const { targetWorkingDir: _targetWorkingDir, targetWorkspaceIdentity: _targetWorkspaceIdentity, ...withoutTarget } = journal;
    const ownerlessUnbind = { ...withoutTarget, operationKey: groupWorkspaceOperationKey(sourceEventId, 'unbind'),
      kind: 'unbind' as const, ownerLarkAppId: undefined, sessionId: 'group-workspace-unbind',
      expectedSessionGeneration: 0, target: { kind: 'absent' as const } };
    await expect(store.prepare(ownerlessUnbind)).resolves.toMatchObject({ status: 'created' });
    let transitions = 0;
    let mutations = 0;
    for (const daemonLarkAppId of ['app-a', 'app-b']) {
      const recoverable = await store.listRecoverable();
      if (recoverable.status !== 'available') throw new Error('operation store unavailable');
      for (const candidate of recoverable.journals) {
        if (!daemonOwnsGroupWorkspaceRecovery(candidate, daemonLarkAppId)) continue;
        transitions += 1;
        mutations += 1;
      }
    }
    expect({ transitions, mutations }).toEqual({ transitions: 0, mutations: 0 });
    const persisted = await store.get(ownerlessUnbind.operationKey);
    expect(persisted).toMatchObject({ status: 'found', journal: { phase: 'prepared' } });
    if (persisted.status !== 'found') throw new Error('journal missing');
    expect(persisted.journal.ownerLarkAppId).toBeUndefined();

    expect(daemonOwnsGroupWorkspaceRecovery({ ...ownerlessUnbind, ownerLarkAppId: 'app-a' }, 'app-a')).toBe(true);
    expect(daemonOwnsGroupWorkspaceRecovery({ ...ownerlessUnbind, ownerLarkAppId: 'app-a' }, 'app-b')).toBe(false);
    expect(daemonOwnsGroupWorkspaceRecovery(journal, 'app-a', { larkAppId: 'app-a' })).toBe(true);
    expect(daemonOwnsGroupWorkspaceRecovery(journal, 'app-b', { larkAppId: 'app-a' })).toBe(false);
  });

  it('selects ownerless legacy show evidence only for the chat and without superseding a newer owned item', () => {
    const ownerless = { ...journal, operationKey: 'ownerless', ownerLarkAppId: undefined, updatedAt: 3 };
    const current = { ...journal, operationKey: 'current', ownerLarkAppId: 'app-a', updatedAt: 2 };
    const foreign = { ...journal, operationKey: 'foreign', ownerLarkAppId: 'app-b', updatedAt: 9 };
    expect(selectGroupWorkspaceOperationForShow([foreign, current, ownerless], 'chat', 'app-a'))
      .toEqual({ journal: ownerless, owner: 'unknown_legacy' });
    expect(selectGroupWorkspaceOperationForShow([
      { ...ownerless, updatedAt: 2 }, { ...current, updatedAt: 4 }, foreign,
    ], 'chat', 'app-a')).toEqual({ journal: { ...current, updatedAt: 4 }, owner: 'current' });
    expect(selectGroupWorkspaceOperationForShow([foreign], 'chat', 'app-a')).toBeUndefined();
    expect(selectGroupWorkspaceOperationForShow([{ ...ownerless, chatId: 'other' }], 'chat', 'app-a')).toBeUndefined();
  });

  it.each(['prepared', 'session_committed', 'group_committed', 'unknown'] as const)(
    'quarantines unresolved schema-v1 set journal in %s without probing a replacement path', async phase => {
      const dataDir = dir();
      const path = join(dataDir, 'group-workspace-operations.json');
      const legacy = { ...journal, target: undefined, targetWorkspaceIdentity: undefined, phase,
        ...(phase === 'session_committed' ? { sessionGenerationAfter: 2 } : {}),
        ...(phase === 'group_committed' ? { sessionGenerationAfter: 2, groupRevisionAfter: 1 } : {}),
      };
      writeFileSync(path, JSON.stringify({ schemaVersion: 1, operations: { [journal.operationKey]: legacy } }));
      let probes = 0;
      const store = new GroupWorkspaceOperationStore(dataDir, { pathProbe: () => { probes += 1; throw new Error('must not probe'); } });
      await expect(store.get(journal.operationKey)).resolves.toMatchObject({ status: 'found', journal: {
        phase: 'migration_blocked_identity_missing', legacyPhase: phase,
      } });
      expect(probes).toBe(0);
      await expect(store.listRecoverable()).resolves.toEqual({ status: 'available', journals: [] });
      await expect(store.listUnresolved()).resolves.toMatchObject({ status: 'available', journals: [
        { operationKey: journal.operationKey, phase: 'migration_blocked_identity_missing' },
      ] });
    },
  );

  it('durably migrates a schema-v1 failed terminal journal without losing phase or intent', async () => {
    const dataDir = dir();
    const path = join(dataDir, 'group-workspace-operations.json');
    const legacy = {
      operationKey: journal.operationKey, sourceEventId, kind: 'set', payloadDigest: journal.payloadDigest,
      chatId: journal.chatId, sessionId: journal.sessionId,
      expectedSessionGeneration: journal.expectedSessionGeneration, expectedGroupRevision: journal.expectedGroupRevision,
      targetWorkingDir: journal.targetWorkingDir, actor: journal.actor,
      phase: 'conflict', sessionGenerationAfter: 2, updatedAt: 2,
    };
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, operations: { [journal.operationKey]: legacy } }));
    const store = new GroupWorkspaceOperationStore(dataDir, { pathProbe: target => ({
      ok: true, normalizedPath: target, identity,
    }) });
    await expect(store.get(journal.operationKey)).resolves.toMatchObject({
      status: 'found', journal: {
        phase: 'conflict', sessionGenerationAfter: 2, requestIntentDigest: journal.payloadDigest,
        target: { kind: 'workspace', identity }, targetWorkspaceIdentity: identity,
      },
    });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ schemaVersion: 2 });
  });

  it('retries a failed durable v1 migration without damaging the locked source', async () => {
    const dataDir = dir();
    const path = join(dataDir, 'group-workspace-operations.json');
    const legacy = {
      operationKey: journal.operationKey, sourceEventId, kind: 'set', payloadDigest: journal.payloadDigest,
      chatId: journal.chatId, sessionId: journal.sessionId,
      expectedSessionGeneration: journal.expectedSessionGeneration, expectedGroupRevision: journal.expectedGroupRevision,
      targetWorkingDir: journal.targetWorkingDir, actor: journal.actor,
      phase: 'conflict', sessionGenerationAfter: 2, updatedAt: 2,
    };
    const original = JSON.stringify({ schemaVersion: 1, operations: { [journal.operationKey]: legacy } });
    writeFileSync(path, original);
    const failed = new GroupWorkspaceOperationStore(dataDir, {
      pathProbe: target => ({ ok: true, normalizedPath: target, identity }),
      writer: () => { throw new Error('crash before rename'); },
    });
    await expect(failed.get(journal.operationKey)).resolves.toEqual({ status: 'store_unavailable' });
    expect(readFileSync(path, 'utf8')).toBe(original);
    const retried = new GroupWorkspaceOperationStore(dataDir, {
      pathProbe: target => ({ ok: true, normalizedPath: target, identity }),
    });
    await expect(retried.get(journal.operationKey)).resolves.toMatchObject({
      status: 'found', journal: { phase: 'conflict', target: { kind: 'workspace', identity } },
    });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ schemaVersion: 2 });
  });

  it('migrates a v1 unbind target to explicit absence without probing a path', async () => {
    const dataDir = dir();
    const path = join(dataDir, 'group-workspace-operations.json');
    const operationKey = groupWorkspaceOperationKey(sourceEventId, 'unbind');
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, operations: { [operationKey]: {
      ...journal, operationKey, kind: 'unbind', sessionId: 'group-workspace-unbind',
      expectedSessionGeneration: 0, targetWorkingDir: '/', target: undefined,
      targetWorkspaceIdentity: undefined,
    } } }));
    const store = new GroupWorkspaceOperationStore(dataDir, {
      pathProbe: () => { throw new Error('unbind must not probe'); },
    });
    await expect(store.get(operationKey)).resolves.toMatchObject({
      status: 'found', journal: { kind: 'unbind', target: { kind: 'absent' } },
    });
    const migrated = JSON.parse(readFileSync(path, 'utf8')).operations[operationKey];
    expect(migrated).not.toHaveProperty('targetWorkingDir');
    expect(migrated).not.toHaveProperty('targetWorkspaceIdentity');
  });

  it('migrates a v1 unbind with absent origin and authority without inventing empty identities', async () => {
    const dataDir = dir();
    const path = join(dataDir, 'group-workspace-operations.json');
    const operationKey = groupWorkspaceOperationKey(sourceEventId, 'unbind');
    const legacy = { ...journal, operationKey, kind: 'unbind', sessionId: 'group-workspace-unbind',
      expectedSessionGeneration: 0, targetWorkingDir: '/', target: undefined,
      targetWorkspaceIdentity: undefined, authorityFingerprint: undefined, originMessageId: undefined };
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, operations: { [operationKey]: legacy } }));
    const store = new GroupWorkspaceOperationStore(dataDir, {
      pathProbe: () => { throw new Error('unbind must not probe'); },
    });
    const migrated = await store.get(operationKey);
    expect(migrated).toMatchObject({ status: 'found', journal: { kind: 'unbind', target: { kind: 'absent' } } });
    if (migrated.status !== 'found') throw new Error('migration failed');
    expect(migrated.journal).not.toHaveProperty('originMessageId');
    expect(migrated.journal).not.toHaveProperty('authorityFingerprint');
  });

  it('adopts the frozen same-intent winner', async () => {
    const store = new GroupWorkspaceOperationStore(dir());
    expect((await store.prepareOrAdopt(journal)).status).toBe('created');
    const adopted = await store.prepareOrAdopt({ ...journal, expectedSessionGeneration: 99, targetWorkingDir: '/other', targetWorkspaceIdentity: { ...identity, path: '/other' } });
    expect(adopted).toMatchObject({ status: 'adopted', journal: { targetWorkingDir: '/repo/x', expectedSessionGeneration: 1 } });
  });
  it('persists recovery ownership and rejects cross-Bot adoption', async () => {
    const store = new GroupWorkspaceOperationStore(dir());
    await expect(store.prepareOrAdopt({ ...journal, ownerLarkAppId: 'app-a' }))
      .resolves.toMatchObject({ status: 'created', journal: { ownerLarkAppId: 'app-a' } });
    await expect(store.prepareOrAdopt({ ...journal, ownerLarkAppId: 'app-b' }))
      .resolves.toMatchObject({ status: 'protocol_conflict', journal: { ownerLarkAppId: 'app-a' } });
  });

  it('terminalizes an unknown missing-session operation only through a fenced orphan transition', async () => {
    const dataDir = dir();
    const store = new GroupWorkspaceOperationStore(dataDir);
    await store.prepare(journal);
    await store.transition(journal.operationKey, 'unknown', { updatedAt: 2 });
    const leases = new OperationExecutorLeaseStore(dataDir, { now: () => 10 });
    const owner = await leases.acquire(journal.operationKey, 'daemon-a', 100);
    if (owner.status !== 'acquired') throw new Error('lease');
    await expect(store.transition(journal.operationKey, 'orphaned', { updatedAt: 3 }, async () =>
      (await leases.assertCurrent(journal.operationKey, owner.lease)).status === 'current'))
      .resolves.toMatchObject({ status: 'updated', journal: { phase: 'orphaned' } });
  });

  it('lists terminal group commits that still require session convergence at startup', async () => {
    const store = new GroupWorkspaceOperationStore(dir());
    await store.prepare(journal);
    await store.transition(journal.operationKey, 'session_committed', { sessionGenerationAfter: 2, updatedAt: 2 });
    await store.transition(journal.operationKey, 'group_committed', { groupRevisionAfter: 3, updatedAt: 3 });
    await expect(store.listUnresolved()).resolves.toEqual({ status: 'available', journals: [] });
    await expect(store.listRecoverable()).resolves.toMatchObject({
      status: 'available', journals: [{ operationKey: journal.operationKey, phase: 'group_committed' }],
    });
  });

  it.each(['prepared', 'session_committed', 'unknown', 'group_committed'] as const)(
    'lists unbind %s journals for startup recovery without session semantics', async phase => {
      const store = new GroupWorkspaceOperationStore(dir());
      const unbind = { ...journal, operationKey: groupWorkspaceOperationKey(sourceEventId, 'unbind'), kind: 'unbind',
        target: { kind: 'absent' }, targetWorkingDir: undefined, targetWorkspaceIdentity: undefined,
        sessionId: 'group-workspace-unbind', expectedSessionGeneration: 0, phase: 'prepared' as const };
      await store.prepare(unbind);
      if (phase !== 'prepared') await store.transition(unbind.operationKey, 'session_committed', {
        sessionGenerationAfter: 0, updatedAt: 2,
      });
      if (phase === 'unknown') await store.transition(unbind.operationKey, 'unknown', { updatedAt: 3 });
      if (phase === 'group_committed') await store.transition(unbind.operationKey, 'group_committed', {
        groupRevisionAfter: 2, updatedAt: 3,
      });
      await expect(store.listRecoverable()).resolves.toMatchObject({
        status: 'available', journals: [{ kind: 'unbind', phase }],
      });
    },
  );

  it('rejects changed semantic intent or frozen authority identity', async () => {
    const store = new GroupWorkspaceOperationStore(dir());
    await store.prepareOrAdopt({ ...journal, authorityFingerprint: 'fingerprint-a' });
    expect((await store.prepareOrAdopt({ ...journal, authorityFingerprint: 'fingerprint-a', requestIntentDigest: 'other' })).status)
      .toBe('protocol_conflict');
    expect((await store.prepareOrAdopt({ ...journal, authorityFingerprint: 'fingerprint-b' })).status)
      .toBe('protocol_conflict');
    expect((await store.prepareOrAdopt({ ...journal, authorityFingerprint: 'fingerprint-a', actor: { ...journal.actor, unionId: 'on_other' } })).status)
      .toBe('protocol_conflict');
  });
  it('fences live owner, expiry steal, and late old owner effects', async () => {
    let now = 10; const leases = new OperationExecutorLeaseStore(dir(), { now: () => now });
    const first = await leases.acquire(journal.operationKey, 'owner-a', 5); expect(first.status).toBe('acquired');
    expect((await leases.acquire(journal.operationKey, 'owner-b', 5)).status).toBe('observer');
    if (first.status !== 'acquired') throw new Error('lease');
    now = 16; const stolen = await leases.acquire(journal.operationKey, 'owner-b', 5); expect(stolen).toMatchObject({ status: 'acquired', lease: { leaseEpoch: 2, fencingToken: 2 } });
    expect((await leases.assertCurrent(journal.operationKey, first.lease)).status).toBe('stale_fence');
    const forgedOldToken = { ...first.lease, owner: 'owner-b', leaseExpiresAt: 99 };
    expect((await leases.assertCurrent(journal.operationKey, forgedOldToken)).status).toBe('stale_fence');
  });
  it('uses a real shared store across two OS processes and rejects the slow old owner late effect', async () => {
    const dataDir = dir();
    const moduleUrl = new URL('../src/services/operation-executor-lease-store.js', import.meta.url).href;
    const effectFile = join(dataDir, 'effects.log');
    const childSource = `
      import { OperationExecutorLeaseStore } from ${JSON.stringify(moduleUrl)};
      const dataDir = process.env.TEST_DATA_DIR; const owner = process.env.TEST_OWNER; const delay = process.env.TEST_DELAY;
      const store = new OperationExecutorLeaseStore(dataDir);
      const acquired = await store.acquire('shared-op', owner, 80);
      process.stdout.write(JSON.stringify(acquired) + '\\n');
      await new Promise(resolve => setTimeout(resolve, Number(delay)));
      const effect = await store.runFencedEffect('shared-op', acquired.lease, async () => {
        const { appendFileSync } = await import('node:fs');
        appendFileSync(process.env.TEST_EFFECT_FILE, owner + '\\n');
        return owner;
      });
      process.stdout.write(JSON.stringify(effect) + '\\n');
    `;
    const run = (owner: string, delay: number) => {
      let firstResolve!: () => void;
      const first = new Promise<void>(resolve => { firstResolve = resolve; });
      const done = new Promise<string[]>((resolve, reject) => {
        const child = spawnTsEvalWithRepoImports(childSource, {
          cwd: process.cwd(), env: { ...process.env, TEST_DATA_DIR: dataDir, TEST_OWNER: owner,
            TEST_DELAY: String(delay), TEST_EFFECT_FILE: effectFile },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const lines: string[] = []; let stderr = '';
        child.stdout!.on('data', chunk => {
          lines.push(...String(chunk).trim().split('\n').filter(Boolean));
          if (lines.length > 0) firstResolve();
        });
        child.stderr!.on('data', chunk => { stderr += String(chunk); });
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolve(lines) : reject(new Error(stderr)));
      });
      return { first, done };
    };
    const oldOwner = run('old-owner', 300);
    await oldOwner.first;
    await new Promise(resolve => setTimeout(resolve, 110));
    const newOwner = run('new-owner', 0);
    const [oldLines, newLines] = await Promise.all([oldOwner.done, newOwner.done]);
    expect(JSON.parse(oldLines[0]!)).toMatchObject({ status: 'acquired', lease: { fencingToken: 1 } });
    expect(JSON.parse(newLines[0]!)).toMatchObject({ status: 'acquired', lease: { fencingToken: 2 } });
    expect(JSON.parse(oldLines[1]!)).toEqual({ status: 'stale_fence' });
    expect(JSON.parse(newLines[1]!)).toEqual({ status: 'applied', value: 'new-owner' });
    expect(readFileSync(effectFile, 'utf8')).toBe('new-owner\n');
  });

  it('holds the journal lock while validating the fencing token', async () => {
    const dataDir = dir();
    const firstStore = new GroupWorkspaceOperationStore(dataDir);
    const secondStore = new GroupWorkspaceOperationStore(dataDir);
    await firstStore.prepare(journal);
    let enterFence!: () => void;
    const entered = new Promise<void>(resolve => { enterFence = resolve; });
    let releaseFence!: () => void;
    const release = new Promise<void>(resolve => { releaseFence = resolve; });
    const first = firstStore.transition(journal.operationKey, 'session_committed', {
      sessionGenerationAfter: 2, updatedAt: 2,
    }, async () => { enterFence(); await release; return true; });
    await entered;
    let secondSettled = false;
    const second = secondStore.transition(journal.operationKey, 'unknown', { updatedAt: 3 })
      .finally(() => { secondSettled = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(secondSettled).toBe(false);
    releaseFence();
    expect((await first).status).toBe('updated');
    expect((await second).status).toBe('updated');
  });

  it('renew increments epoch and restart identity has no implicit authority', async () => {
    const leases = new OperationExecutorLeaseStore(dir(), { now: () => 10 });
    const first = await leases.acquire(journal.operationKey, 'daemon-boot-1', 5); if (first.status !== 'acquired') throw new Error('lease');
    expect(await leases.renew(journal.operationKey, first.lease, 5)).toMatchObject({ status: 'renewed', lease: { leaseEpoch: 2, fencingToken: 2 } });
    expect((await leases.acquire(journal.operationKey, 'daemon-boot-2', 5)).status).toBe('observer');
  });
});
