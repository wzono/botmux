import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GroupWorkspaceStore, canonicalGroupOperationPayloadDigest, canonicalTextSourceEventId } from '../src/services/group-workspace-store.js';
import { GroupWorkspaceOperationStore } from '../src/services/group-workspace-operation-store.js';
import { groupWorkspaceOperationKey } from '../src/services/group-workspace-store.js';
import { WORKSPACE_SCHEMA_VERSION, workspaceIdentityEqual } from '../src/types.js';

const actor = { tenantKey: 'tenant-a', unionId: 'on_user' };
const source = canonicalTextSourceEventId({ tenantKey: 'tenant-a', chatId: 'chat', messageId: 'm1' });
if (!source.ok) throw new Error('source');
const identity = { path: '/repo/x', dev: '9007199254740993', ino: '9007199254740995' };
const dir = () => mkdtempSync(join(tmpdir(), 'schema-v2-'));

describe('workspace schema v2', () => {
  it('durably upgrades a real v1 binding under the store lock before reads', async () => {
    const dataDir = dir(); const path = join(dataDir, 'group-workspaces.json');
    const legacySource = canonicalTextSourceEventId({ tenantKey: actor.tenantKey, chatId: 'chat', messageId: 'legacy' });
    if (!legacySource.ok) throw new Error('source');
    const operationKey = groupWorkspaceOperationKey(legacySource.sourceEventId, 'set');
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, records: { chat: {
      chatId: 'chat', revision: 1, directory: { kind: 'bound', workingDir: '/repo' },
      directoryIdentity: { dev: '7', ino: '9' }, updatedAt: 1, updatedBy: actor,
    } }, receipts: { [operationKey]: {
      operationKey, sourceEventId: legacySource.sourceEventId, kind: 'set',
      payloadDigest: canonicalGroupOperationPayloadDigest({ kind: 'set', chatId: 'chat', sourceEventId: legacySource.sourceEventId,
        requestedWorkingDir: '/repo', expectedRevision: 0, expectedSessionGeneration: 1, actor,
        authorized: true, directoryValid: true, now: 1 }),
      chatId: 'chat', outcome: 'committed', resultingRevision: 1,
      resultingDirectory: { kind: 'bound', workingDir: '/repo' }, actor, completedAt: 1,
      expectedRevision: 0, expectedSessionGeneration: 1, canonicalTargetWorkingDir: '/repo',
    } } }));
    const store = new GroupWorkspaceStore(dataDir, { pathProbe: () => ({
      ok: true, normalizedPath: '/repo', identity: { dev: '7', ino: '9' },
    }) });
    await expect(store.read('chat')).resolves.toMatchObject({ status: 'available', record: {
      workspaceIdentity: { path: '/repo', dev: '7', ino: '9' },
    } });
    expect(JSON.parse(readFileSync(path, 'utf8')).schemaVersion).toBe(2);
  });
  it('migrates each historical receipt from its own canonical target identity', async () => {
    const dataDir = dir(); const path = join(dataDir, 'group-workspaces.json');
    const sourceA = canonicalTextSourceEventId({ tenantKey: actor.tenantKey, chatId: 'chat', messageId: 'a' });
    const sourceB = canonicalTextSourceEventId({ tenantKey: actor.tenantKey, chatId: 'chat', messageId: 'b' });
    if (!sourceA.ok || !sourceB.ok) throw new Error('source');
    const makeReceipt = (sourceEventId: string, target: string, expectedRevision: number, completedAt: number) => ({
      operationKey: groupWorkspaceOperationKey(sourceEventId, 'set'), sourceEventId, kind: 'set',
      payloadDigest: canonicalGroupOperationPayloadDigest({ kind: 'set', chatId: 'chat', sourceEventId,
        requestedWorkingDir: target, expectedRevision, actor, authorized: true, directoryValid: true, now: completedAt }),
      chatId: 'chat', outcome: 'committed', resultingRevision: expectedRevision + 1,
      resultingDirectory: { kind: 'bound', workingDir: target }, actor, completedAt,
      expectedRevision, canonicalTargetWorkingDir: target,
    });
    const receiptA = makeReceipt(sourceA.sourceEventId, '/repo/A', 0, 1);
    const receiptB = makeReceipt(sourceB.sourceEventId, '/repo/B', 1, 2);
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, records: { chat: {
      chatId: 'chat', revision: 2, directory: { kind: 'bound', workingDir: '/repo/B' },
      directoryIdentity: { dev: '2', ino: '20' }, updatedAt: 2, updatedBy: actor,
    } }, receipts: { [receiptA.operationKey]: receiptA, [receiptB.operationKey]: receiptB } }));
    const store = new GroupWorkspaceStore(dataDir, { pathProbe: target => ({
      ok: true, normalizedPath: target, identity: target === '/repo/A' ? { dev: '1', ino: '10' } : { dev: '2', ino: '20' },
    }) });
    expect((await store.read('chat')).status).toBe('available');
    const migrated = JSON.parse(readFileSync(path, 'utf8'));
    expect(migrated.receipts[receiptA.operationKey].workspaceIdentity).toEqual({ path: '/repo/A', dev: '1', ino: '10' });
    expect(migrated.receipts[receiptB.operationKey].workspaceIdentity).toEqual({ path: '/repo/B', dev: '2', ino: '20' });
  });

  it('writes bound record and committed receipt identities as strings', async () => {
    const dataDir = dir(); const store = new GroupWorkspaceStore(dataDir, { pathProbe: () => ({ ok: true, normalizedPath: identity.path, identity }) });
    await store.mutate({ kind: 'set', chatId: 'chat', sourceEventId: source.sourceEventId, requestedWorkingDir: identity.path,
      expectedWorkspaceIdentity: identity,
      expectedRevision: 0, expectedSessionGeneration: 1, actor, authorized: true, directoryValid: true, now: 1 });
    const raw = JSON.parse(readFileSync(join(dataDir, 'group-workspaces.json'), 'utf8'));
    expect(raw.schemaVersion).toBe(WORKSPACE_SCHEMA_VERSION);
    expect(raw.records.chat.workspaceIdentity).toEqual(identity);
    expect(Object.values(raw.receipts)[0]).toMatchObject({ workspaceIdentity: identity });
  });
  it('writes unbind without fake identity', async () => {
    const dataDir = dir(); const store = new GroupWorkspaceStore(dataDir);
    const unbind = canonicalTextSourceEventId({ tenantKey: 'tenant-a', chatId: 'chat', messageId: 'm2' }); if (!unbind.ok) throw new Error('source');
    await store.mutate({ kind: 'unbind', chatId: 'chat', sourceEventId: unbind.sourceEventId, expectedRevision: 0, actor, authorized: true, now: 1 });
    const raw = JSON.parse(readFileSync(join(dataDir, 'group-workspaces.json'), 'utf8'));
    expect(raw.records.chat.workspaceIdentity).toBeUndefined(); expect(Object.values(raw.receipts)[0]).not.toHaveProperty('workspaceIdentity');
  });
  it('persists an unbind journal with an absent target instead of a slash sentinel', async () => {
    const dataDir = dir();
    const unbind = canonicalTextSourceEventId({ tenantKey: 'tenant-a', chatId: 'chat', messageId: 'm3' }); if (!unbind.ok) throw new Error('source');
    const operationKey = groupWorkspaceOperationKey(unbind.sourceEventId, 'unbind');
    const result = await new GroupWorkspaceOperationStore(dataDir).prepare({
      operationKey, sourceEventId: unbind.sourceEventId, kind: 'unbind', requestIntentDigest: 'intent', payloadDigest: 'payload',
      chatId: 'chat', sessionId: 'group-workspace-unbind', expectedSessionGeneration: 0, expectedGroupRevision: 0,
      target: { kind: 'absent' }, actor, phase: 'prepared', updatedAt: 1,
    });
    expect(result.status).toBe('created');
    expect((result as any).journal).toMatchObject({ target: { kind: 'absent' } });
    expect((result as any).journal).not.toHaveProperty('targetWorkingDir');
  });
  it('rejects a future schema without rewriting', async () => {
    const schemaVersion = 99;
    const dataDir = dir(); const path = join(dataDir, 'group-workspaces.json');
    writeFileSync(path, JSON.stringify({ schemaVersion, records: {}, receipts: {} })); const before = readFileSync(path, 'utf8');
    expect((await new GroupWorkspaceStore(dataDir).read('chat')).status).toBe('store_unavailable'); expect(readFileSync(path, 'utf8')).toBe(before);
  });
  it('compares path dev and ino', () => {
    expect(workspaceIdentityEqual(identity, identity)).toBe(true);
    expect(workspaceIdentityEqual(identity, { ...identity, ino: '9007199254740996' })).toBe(false);
  });
});
