import { mkdtempSync, mkdirSync, renameSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { GroupWorkspaceOperationStore } from '../src/services/group-workspace-operation-store.js';
import { GroupWorkspaceOperationCoordinator, createGroupWorkspaceSetCoordinator } from '../src/core/group-workspace-operation.js';
import { groupWorkspaceOperationKey, canonicalGroupOperationPayloadDigest, GroupWorkspaceStore } from '../src/services/group-workspace-store.js';
import { OperationExecutorLeaseStore } from '../src/services/operation-executor-lease-store.js';
import { createGroupWorkspaceRouteRuntime } from '../src/core/group-workspace-route-runtime.js';
import { canManageGroupWorkspace } from '../src/core/group-workspace-policy.js';
import { DurableVerifiedAppTenantRegistry } from '../src/core/workspace-authority.js';
import { proveGroupWorkspaceSessionReplacement } from '../src/core/session-cwd.js';
import { seedPersistedSessionRows, mutatePersistedSessionRow, readPersistedSessionRows } from './helpers/session-store-disk.js';

// Execute fixed-version production closure expressions with controlled caller/callee
// seams. Assertions concern returned state and effects, not source-text presence.
const daemon = ts.createSourceFile('daemon.ts', readFileSync(join(process.cwd(), 'src/daemon.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
function productionArrow(property: string, includes: string, scope: Record<string, unknown>): any {
  let arrow: ts.ArrowFunction | undefined;
  function visit(node: ts.Node) {
    if (!arrow && ts.isPropertyAssignment(node) && node.name.getText(daemon) === property
      && ts.isArrowFunction(node.initializer) && node.initializer.getText(daemon).includes(includes)) arrow = node.initializer;
    if (!arrow) ts.forEachChild(node, visit);
  }
  visit(daemon);
  if (!arrow) throw new Error(`missing production closure ${property}`);
  const source = `const production = ${arrow.getText(daemon)};`;
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(scope), `${js}; return production;`)(...Object.values(scope));
}

describe('Dana fixed 2affe4c87 historical blocker closure regressions', () => {
  it('production tenant supplier excludes a foreign app and denies its owner in the request tenant', async () => {
    const states = [
      { config: { larkAppId: 'app-a', allowedUsers: ['ou_owner_a'] }, rawAllowedUserResolution: new Map() },
      { config: { larkAppId: 'app-b', allowedUsers: ['ou_owner_b'] }, rawAllowedUserResolution: new Map() },
    ];
    const tenantData = mkdtempSync(join(tmpdir(), 'dana-tenant-'));
    const tenants = new DurableVerifiedAppTenantRegistry(tenantData);
    tenants.observeSignedCallback('app-a', 'tenant-a'); tenants.observeSignedCallback('app-b', 'tenant-b');
    const registeredBots = productionArrow('registeredBots', 'loadBotConfigsCached()', {
      verifiedAppTenantRegistry: tenants, loadBotConfigsCached: () => states.map(s => s.config),
    });
    const resolveAllowedUser = productionArrow('resolveAllowedUser', 'resolveUserUnionId', {
      getBot: (app: string) => states.find(s => s.config.larkAppId === app),
      resolveUserUnionId: async (app: string) => ({ unionId: app === 'app-b' ? 'on_foreign' : 'on_owner' }),
      cfg: { larkAppId: 'app-a' }, config: { session: { dataDir: '/unused' } },
      loadBotConfigsCached: () => states.map(s => s.config),
      readBotAdminUnions: (_dir: string, app: string) => ({ exact: true, admins: new Set([app === 'app-b' ? 'on_foreign' : 'on_owner']) }),
    });
    const runtime = createGroupWorkspaceRouteRuntime({ larkAppId: 'app-a', activeSessions: new Map(),
      sessionKey: (chat, app) => `${chat}::${app}`, registeredBots, resolveAllowedUser,
      resolveActorUnion: async () => 'on_foreign', readWorkspace: async () => ({ status: 'available' }),
      canSwitchSession: () => true, dispatchRepo: () => {}, reply: () => {},
    });
    const authority = await runtime.resolveAuthority({ chatId: 'oc_test', senderOpenId: 'ou_foreign_view_a',
      senderUnionId: 'on_foreign', tenantKey: 'tenant-a', humanProvenance: true });
    expect(new DurableVerifiedAppTenantRegistry(tenantData).verifiedTenant('app-b')?.tenantKey).toBe('tenant-b');
    expect(registeredBots('tenant-a').find((b: any) => b.larkAppId === 'app-b')).toBeUndefined();
    expect(authority.status).toBe('recognized_denied');
  });

  it('production set switch proves successful in-place session replacement', async () => {
    const target = mkdtempSync(join(tmpdir(), 'dana-switch-'));
    const stat = statSync(target, { bigint: true });
    const identity = { path: target, dev: String(stat.dev), ino: String(stat.ino) };
    const ds: any = { larkAppId: 'app-a', chatId: 'oc_test', workerGeneration: 4, session: { sessionId: 'old', workingDir: '/old', ownerOpenId: 'ou_owner' } };
    const activeSessions = new Map([['oc_test::app-a', ds]]);
    let switches = 0;
    const switchSession = productionArrow('switchSession', 'await handleCommand', {
      ds, cfg: { larkAppId: 'app-a' }, activeSessions, sessionKey: (c: string, a: string) => `${c}::${a}`,
      route: { messageId: 'om_source', actorOpenId: 'ou_owner', actor: { unionId: 'on_owner' } },
      randomUUID: () => 'random', commandDepsForInvocation: () => ({}),
      getSessionWorkingDir: (s: any) => s.session.workingDir,
      proveGroupWorkspaceSessionReplacement,
      probePathUsability: () => ({ ok: true, normalizedPath: target, identity }),
      handleCommand: async () => { switches++; ds.session = { sessionId: 'new', workingDir: target, ownerOpenId: 'ou_owner' }; ds.workerGeneration = 5; },
    });
    const result = await switchSession({ expectedGeneration: 4, targetWorkingDir: target, workspaceIdentity: identity });
    expect(switches).toBe(1);
    expect(activeSessions.get('oc_test::app-a')).toBe(ds);
    expect(ds.session.workingDir).toBe(target);
    expect(result).toEqual({ status: 'committed', generation: 5 });
  });

  it.each(['recover', 'replay', 'production_metadata_replay'] as const)('unresolved v1 journal remains quarantined on %s with a real executor fence', async mode => {
    const data = mkdtempSync(join(tmpdir(), 'dana-r2-migration-'));
    const target = join(data, 'target'); mkdirSync(target);
    const oldIno = String(statSync(target, { bigint: true }).ino);
    const sourceEventId = 'group-workspace-text-source-v1:sha256:' + 'c'.repeat(64);
    const operationKey = groupWorkspaceOperationKey(sourceEventId, 'set');
    const actor = { tenantKey: 'tenant-a', unionId: 'on_owner' };
    const digest = canonicalGroupOperationPayloadDigest({ kind: 'set', chatId: 'oc_test', sourceEventId, requestedWorkingDir: target,
      expectedRevision: 0, expectedSessionGeneration: 4, actor, authorized: true, directoryValid: true, now: 0 });
    const metadata = mode === 'production_metadata_replay'
      ? { ownerLarkAppId: 'app-a', authorityFingerprint: 'verified-snapshot' } : {};
    const legacy = { operationKey, sourceEventId, kind: 'set', requestIntentDigest: 'intent', payloadDigest: digest, ...metadata,
      chatId: 'oc_test', sessionId: 'session', expectedSessionGeneration: 4, expectedGroupRevision: 0,
      targetWorkingDir: target, actor, phase: 'prepared', updatedAt: 1 };
    writeFileSync(join(data, 'group-workspace-operations.json'), JSON.stringify({ schemaVersion: 1, operations: { [operationKey]: legacy } }));
    renameSync(target, `${target}-original`); mkdirSync(target);
    const newIno = String(statSync(target, { bigint: true }).ino);
    expect(newIno).not.toBe(oldIno);
    const store = new GroupWorkspaceOperationStore(data);
    const loaded = await store.get(operationKey);
    expect(loaded.status).toBe('found');
    if (loaded.status !== 'found') throw new Error('migration unavailable');
    expect(loaded.journal.phase).toBe('migration_blocked_identity_missing');
    expect(loaded.journal.targetWorkspaceIdentity).toBeUndefined();
    let switches = 0;
    let targetResolutions = 0;
    const groupStore = new GroupWorkspaceStore(data);
    const leases = new OperationExecutorLeaseStore(data, { now: () => 2 });
    const coordinator = createGroupWorkspaceSetCoordinator({ journalStore: store, groupStore, now: () => 2,
      executorLeaseStore: leases, executorOwner: 'current-owner',
      revalidateAuthority: async () => ({ status: 'authorized' }),
      resolveCanonicalTarget: async () => {
        targetResolutions++;
        const stat = statSync(target, { bigint: true });
        return { status: 'resolved', workingDir: target, workspaceIdentity: { path: target, dev: String(stat.dev), ino: String(stat.ino) } };
      },
      readSession: async () => ({ status: 'available', generation: 4, workingDir: '/old' }),
      switchSession: async () => { switches++; return { status: 'committed', generation: 5 }; },
      convergeSession: async () => {},
    });
    if (mode === 'recover') await coordinator.recover(loaded.journal);
    else await coordinator.execute({ operationKey, sourceEventId, kind: 'set', requestIntentDigest: 'intent',
      chatId: 'oc_test', sessionId: 'session', actor, ...metadata });
    expect(switches).toBe(0);
    expect(targetResolutions).toBe(0);
    expect.soft(await groupStore.readReceipt(operationKey)).toEqual({ status: 'missing' });
    expect.soft(await groupStore.read('oc_test')).toMatchObject({ status: 'available', record: undefined });
    expect(await store.get(operationKey)).toMatchObject({ status: 'found', journal: { phase: 'migration_blocked_identity_missing' } });
  });

  it.each(['recover', 'replay'] as const)('executor observer reads receipt without journal or session convergence on %s', async mode => {
    const data = mkdtempSync(join(tmpdir(), 'dana-r2-observer-'));
    const sourceEventId = 'group-workspace-text-source-v1:sha256:' + 'd'.repeat(64);
    const operationKey = groupWorkspaceOperationKey(sourceEventId, 'set');
    const identity = { path: '/new', dev: '1', ino: '2' };
    const journal: any = { operationKey, sourceEventId, kind: 'set', requestIntentDigest: 'intent', payloadDigest: 'payload',
      chatId: 'oc_test', sessionId: 'session', expectedSessionGeneration: 4, expectedGroupRevision: 0,
      target: { kind: 'workspace', identity }, targetWorkingDir: '/new', targetWorkspaceIdentity: identity,
      actor: { tenantKey: 'tenant-a', unionId: 'on_owner' }, phase: 'prepared', updatedAt: 1 };
    const store = new GroupWorkspaceOperationStore(data); await store.prepare(journal);
    await store.transition(operationKey, 'session_committed', { sessionGenerationAfter: 5, updatedAt: 2 });
    const loaded = await store.get(operationKey); if (loaded.status !== 'found') throw new Error('missing');
    const leases = new OperationExecutorLeaseStore(data, { now: () => 10 });
    await leases.acquire(operationKey, 'active-owner', 100);
    seedPersistedSessionRows(data, 'app-a', { session: { sessionId: 'session', status: 'active',
      workingDir: '/new', workingDirSource: 'explicit', workerGeneration: 5 } });
    let convergences = 0;
    const coordinator = new GroupWorkspaceOperationCoordinator({ journalStore: store, now: () => 11,
      acquireExecutor: id => leases.acquire(id, 'observer', 100),
      lookupGroupReceipt: async () => ({ status: 'found', receipt: { operationKey, payloadDigest: 'payload', chatId: 'oc_test',
        targetWorkingDir: '/new', workspaceIdentity: identity, status: 'committed', resultingRevision: 1 } }),
      reconcileUnknownGroupReceipt: async () => ({ status: 'missing' }),
      readCurrentGroupRevision: async () => ({ status: 'available', revision: 1 }),
      resolveCanonicalTarget: async () => ({ status: 'resolved', workingDir: '/new', workspaceIdentity: identity }),
      readSession: async () => ({ status: 'available', generation: 5, workingDir: '/new' }),
      switchSession: async () => { throw new Error('observer cannot switch'); },
      commitGroup: async () => { throw new Error('observer cannot commit'); },
      convergeSession: async input => { convergences++; mutatePersistedSessionRow(data, 'app-a', 'session', row => Object.assign(row, {
        workingDirSource: input.source, groupWorkspaceRevision: input.groupRevision, groupWorkspaceIdentity: input.workspaceIdentity,
      })); },
    });
    const result = mode === 'recover' ? await coordinator.recover(loaded.journal)
      : await coordinator.execute({ operationKey, sourceEventId, kind: 'set', requestIntentDigest: 'intent',
        chatId: 'oc_test', sessionId: 'session', actor: journal.actor });
    expect(result.status).toBe('observing');
    expect(convergences).toBe(0);
    expect((await store.get(operationKey))).toMatchObject({ status: 'found', journal: { phase: 'session_committed' } });
    expect(readPersistedSessionRows(data, 'app-a').session).toMatchObject({ workingDirSource: 'explicit' });
    expect((await leases.acquire(operationKey, 'observer', 100)).status).toBe('observer');
  });

  it('stale executor cannot change session provenance on an authorization denial', async () => {
    const data = mkdtempSync(join(tmpdir(), 'dana-r2-revoked-fence-'));
    let now = 10;
    const sourceEventId = 'group-workspace-text-source-v1:sha256:' + 'e'.repeat(64);
    const operationKey = groupWorkspaceOperationKey(sourceEventId, 'set');
    const target = join(data, 'target'); mkdirSync(target);
    const stat = statSync(target, { bigint: true });
    const identity = { path: target, dev: String(stat.dev), ino: String(stat.ino) };
    const actor = { tenantKey: 'tenant-a', unionId: 'on_owner' };
    const payloadDigest = canonicalGroupOperationPayloadDigest({ kind: 'set', chatId: 'oc_test', sourceEventId,
      requestedWorkingDir: target, expectedRevision: 0, expectedSessionGeneration: 4, actor, authorized: true, directoryValid: true, now: 0 });
    const journal: any = { operationKey, sourceEventId, kind: 'set', requestIntentDigest: 'intent', payloadDigest,
      chatId: 'oc_test', sessionId: 'session', expectedSessionGeneration: 4, expectedGroupRevision: 0,
      target: { kind: 'workspace', identity }, targetWorkingDir: target, targetWorkspaceIdentity: identity,
      actor, phase: 'prepared', updatedAt: 1 };
    const store = new GroupWorkspaceOperationStore(data); await store.prepare(journal);
    await store.transition(operationKey, 'session_committed', { sessionGenerationAfter: 5, updatedAt: 2 });
    const loaded = await store.get(operationKey); if (loaded.status !== 'found') throw new Error('missing');
    const leases = new OperationExecutorLeaseStore(data, { now: () => now });
    const groupStore = new GroupWorkspaceStore(data);
    seedPersistedSessionRows(data, 'app-a', { session: { sessionId: 'session', status: 'active',
      workingDir: target, workingDirSource: 'explicit', workerGeneration: 5 } });
    let convergences = 0;
    const successor = createGroupWorkspaceSetCoordinator({ journalStore: store, groupStore, now: () => now,
      executorLeaseStore: leases, executorOwner: 'new-owner', executorLeaseTtlMs: 100,
      revalidateAuthority: async () => ({ status: 'authorized' }),
      resolveCanonicalTarget: async () => ({ status: 'resolved', workingDir: target, workspaceIdentity: identity }),
      readSession: async () => ({ status: 'available', generation: 5, workingDir: target }),
      switchSession: async () => { throw new Error('session already committed'); },
      convergeSession: async input => {
        mutatePersistedSessionRow(data, 'app-a', 'session', row => Object.assign(row, {
          workingDirSource: input.source, groupWorkspaceRevision: input.groupRevision, groupWorkspaceIdentity: input.workspaceIdentity,
        }));
      },
    });
    const coordinator = createGroupWorkspaceSetCoordinator({ journalStore: store, groupStore, now: () => now,
      executorLeaseStore: leases, executorOwner: 'old-owner', executorLeaseTtlMs: 100,
      revalidateAuthority: async () => {
        now = 111;
        expect(await successor.recover(loaded.journal)).toMatchObject({ status: 'group_committed', groupRevision: 1 });
        expect(await groupStore.readReceipt(operationKey)).toMatchObject({ status: 'found', receipt: { outcome: 'committed' } });
        expect(readPersistedSessionRows(data, 'app-a').session).toMatchObject({ workingDirSource: 'group', groupWorkspaceRevision: 1 });
        return { status: 'unauthorized' };
      },
      resolveCanonicalTarget: async () => ({ status: 'resolved', workingDir: target, workspaceIdentity: identity }),
      readSession: async () => ({ status: 'available', generation: 5, workingDir: target }),
      switchSession: async () => { throw new Error('denial cannot switch'); },
      convergeSession: async input => {
        convergences++;
        mutatePersistedSessionRow(data, 'app-a', 'session', row => Object.assign(row, {
          workingDirSource: input.source, groupWorkspaceRevision: input.groupRevision, groupWorkspaceIdentity: input.workspaceIdentity,
        }));
      },
    });
    await coordinator.recover(loaded.journal);
    expect((await leases.acquire(operationKey, 'old-owner', 100)).status).toBe('observer');
    expect.soft(convergences).toBe(0);
    expect.soft(readPersistedSessionRows(data, 'app-a').session).toMatchObject({ workingDirSource: 'group', groupWorkspaceRevision: 1 });
    expect(await store.get(operationKey)).toMatchObject({ status: 'found', journal: { phase: 'group_committed' } });
  });

  it('stale executor cannot mark journal unknown after takeover during a session read', async () => {
    const data = mkdtempSync(join(tmpdir(), 'dana-r2-unknown-fence-'));
    let now = 10;
    const sourceEventId = 'group-workspace-text-source-v1:sha256:' + 'f'.repeat(64);
    const operationKey = groupWorkspaceOperationKey(sourceEventId, 'set');
    const identity = { path: '/new', dev: '1', ino: '2' };
    const journal: any = { operationKey, sourceEventId, kind: 'set', requestIntentDigest: 'intent', payloadDigest: 'payload',
      chatId: 'oc_test', sessionId: 'session', expectedSessionGeneration: 4, expectedGroupRevision: 0,
      target: { kind: 'workspace', identity }, targetWorkingDir: '/new', targetWorkspaceIdentity: identity,
      actor: { tenantKey: 'tenant-a', unionId: 'on_owner' }, phase: 'prepared', updatedAt: 1 };
    const store = new GroupWorkspaceOperationStore(data); await store.prepare(journal);
    const leases = new OperationExecutorLeaseStore(data, { now: () => now });
    const coordinator = createGroupWorkspaceSetCoordinator({ journalStore: store, groupStore: new GroupWorkspaceStore(data), now: () => now,
      executorLeaseStore: leases, executorOwner: 'old-owner', executorLeaseTtlMs: 100,
      revalidateAuthority: async () => ({ status: 'authorized' }),
      resolveCanonicalTarget: async () => ({ status: 'resolved', workingDir: '/new', workspaceIdentity: identity }),
      readSession: async () => {
        now = 111;
        expect((await leases.acquire(operationKey, 'new-owner', 100)).status).toBe('acquired');
        return { status: 'store_unavailable' };
      },
      switchSession: async () => { throw new Error('stale executor cannot switch'); },
      convergeSession: async () => { throw new Error('stale executor cannot converge'); },
    });
    await coordinator.recover(journal);
    expect((await leases.acquire(operationKey, 'old-owner', 100)).status).toBe('observer');
    expect(await store.get(operationKey)).toMatchObject({ status: 'found', journal: { phase: 'prepared' } });
  });
});
