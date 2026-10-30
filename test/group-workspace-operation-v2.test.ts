import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GroupWorkspaceOperationStore } from '../src/services/group-workspace-operation-store.js';
import { OperationExecutorLeaseStore } from '../src/services/operation-executor-lease-store.js';
import { groupWorkspaceOperationKey } from '../src/services/group-workspace-store.js';

const identity = { path: '/repo/x', dev: '1', ino: '2' };
const sourceEventId = 'group-workspace-text-source-v1:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const journal: any = { operationKey: groupWorkspaceOperationKey(sourceEventId, 'set'),
  sourceEventId, kind: 'set',
  requestIntentDigest: 'intent', payloadDigest: 'payload', chatId: 'chat', sessionId: 'session', expectedSessionGeneration: 1,
  expectedGroupRevision: 0, targetWorkingDir: identity.path, targetWorkspaceIdentity: identity, actor: { tenantKey: 'tenant', unionId: 'on_user' }, phase: 'prepared', updatedAt: 1 };
const dir = () => mkdtempSync(join(tmpdir(), 'operation-v2-'));

describe('same-source winner and executor lease', () => {
  it('adopts the frozen same-intent winner', async () => {
    const store = new GroupWorkspaceOperationStore(dir());
    expect((await store.prepareOrAdopt(journal)).status).toBe('created');
    const adopted = await store.prepareOrAdopt({ ...journal, expectedSessionGeneration: 99, targetWorkingDir: '/other', targetWorkspaceIdentity: { ...identity, path: '/other' } });
    expect(adopted).toMatchObject({ status: 'adopted', journal: { targetWorkingDir: '/repo/x', expectedSessionGeneration: 1 } });
  });
  it('rejects changed semantic intent', async () => {
    const store = new GroupWorkspaceOperationStore(dir()); await store.prepareOrAdopt(journal);
    expect((await store.prepareOrAdopt({ ...journal, requestIntentDigest: 'other' })).status).toBe('protocol_conflict');
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
  it('renew increments epoch and restart identity has no implicit authority', async () => {
    const leases = new OperationExecutorLeaseStore(dir(), { now: () => 10 });
    const first = await leases.acquire(journal.operationKey, 'daemon-boot-1', 5); if (first.status !== 'acquired') throw new Error('lease');
    expect(await leases.renew(journal.operationKey, first.lease, 5)).toMatchObject({ status: 'renewed', lease: { leaseEpoch: 2, fencingToken: 2 } });
    expect((await leases.acquire(journal.operationKey, 'daemon-boot-2', 5)).status).toBe('observer');
  });
});
