import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { atomicWriteFileSync } from '../src/utils/atomic-write.js';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TenantHumanId } from '../src/services/bot-admin-unions-store.js';
import {
  GroupWorkspaceStore,
  canonicalCardSourceEventId,
  canonicalGroupOperationPayloadDigest,
  canonicalTextSourceEventId,
  groupWorkspaceOperationKey,
} from '../src/services/group-workspace-store.js';

const U: TenantHumanId = { tenantKey: 'tenant-a', unionId: 'on_user_u' };
const V: TenantHumanId = { tenantKey: 'tenant-a', unionId: 'on_user_v' };
const CHAT = 'oc_group';

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), 'botmux-group-workspace-'));
}

function textSource(messageId: string): string {
  const result = canonicalTextSourceEventId({
    tenantKey: 'tenant-a',
    chatId: CHAT,
    messageId,
  });
  if (!result.ok) throw new Error('unexpected source failure');
  return result.sourceEventId;
}

function setInput(options: {
  sourceEventId: string;
  workingDir: string;
  expectedRevision: number;
  actor?: TenantHumanId;
  expectedSessionGeneration?: number;
  now?: number;
}) {
  return {
    kind: 'set' as const,
    chatId: CHAT,
    sourceEventId: options.sourceEventId,
    requestedWorkingDir: options.workingDir,
    expectedRevision: options.expectedRevision,
    expectedSessionGeneration: options.expectedSessionGeneration ?? 1,
    actor: options.actor ?? U,
    authorized: true,
    directoryValid: true,
    now: options.now ?? 100,
  };
}

describe('GroupWorkspaceStore', () => {
  it('treats a missing store as an empty available store', async () => {
    const result = await new GroupWorkspaceStore(dataDir()).read(CHAT);
    expect(result).toEqual({ status: 'available', record: undefined });
  });

  it('round-trips a bound canonical path and durable receipt', async () => {
    const dir = dataDir();
    const store = new GroupWorkspaceStore(dir);
    const sourceEventId = textSource('om_set_x');
    const outcome = await store.mutate(setInput({
      sourceEventId,
      workingDir: '/tmp/repo/../canonical-repo',
      expectedRevision: 0,
    }));

    expect(outcome).toMatchObject({
      outcome: 'committed',
      receipt: {
        sourceEventId,
        resultingRevision: 1,
        resultingDirectory: { kind: 'bound', workingDir: resolve('/tmp/canonical-repo') },
      },
    });
    await expect(new GroupWorkspaceStore(dir).read(CHAT)).resolves.toEqual({
      status: 'available',
      record: expect.objectContaining({
        chatId: CHAT,
        revision: 1,
        directory: { kind: 'bound', workingDir: resolve('/tmp/canonical-repo') },
      }),
    });
    expect(readFileSync(join(dir, 'group-workspaces.json'), 'utf8')).toContain('"receipts"');
  });

  it('fails closed on a malformed store', async () => {
    const dir = dataDir();
    writeFileSync(join(dir, 'group-workspaces.json'), '{broken');
    const store = new GroupWorkspaceStore(dir);
    expect(await store.read(CHAT)).toEqual({ status: 'store_unavailable' });
    expect((await store.mutate(setInput({
      sourceEventId: textSource('om_malformed'),
      workingDir: '/tmp/x',
      expectedRevision: 0,
    }))).outcome).toBe('store_unavailable');
  });

  it('fails closed on a receipt whose operation key does not match its source and kind', async () => {
    const dir = dataDir();
    const sourceEventId = textSource('om_bad_key');
    writeFileSync(join(dir, 'group-workspaces.json'), JSON.stringify({
      schemaVersion: 1,
      records: {},
      receipts: {
        wrong: {
          operationKey: 'wrong',
          sourceEventId,
          kind: 'set',
          payloadDigest: canonicalGroupOperationPayloadDigest(setInput({ sourceEventId, workingDir: '/tmp/X', expectedRevision: 0 })),
          chatId: CHAT,
          outcome: 'conflict',
          actor: U,
          completedAt: 100,
          expectedRevision: 1,
          canonicalTargetWorkingDir: '/tmp/X',
        },
      },
    }));
    expect(await new GroupWorkspaceStore(dir).read(CHAT)).toEqual({ status: 'store_unavailable' });
  });

  it('fails closed on cross-field receipt corruption', async () => {
    const dir = dataDir();
    const sourceEventId = textSource('om_fabricated');
    const operationKey = groupWorkspaceOperationKey(sourceEventId, 'set');
    writeFileSync(join(dir, 'group-workspaces.json'), JSON.stringify({
      schemaVersion: 1,
      records: {},
      receipts: {
        [operationKey]: {
          operationKey,
          sourceEventId,
          kind: 'set',
          payloadDigest: 'group-workspace-payload-v1:sha256:fabricated',
          chatId: CHAT,
          outcome: 'committed',
          resultingRevision: 1,
          resultingDirectory: { kind: 'bound', workingDir: '/tmp/fabricated' },
          actor: U,
          completedAt: 100,
          expectedRevision: 0,
          canonicalTargetWorkingDir: '/tmp/fabricated',
        },
      },
    }));

    expect(await new GroupWorkspaceStore(dir).read(CHAT)).toEqual({ status: 'store_unavailable' });
  });

  it('ignores an interrupted atomic replacement and preserves the last complete store', async () => {
    const dir = dataDir();
    const store = new GroupWorkspaceStore(dir);
    await store.mutate(setInput({ sourceEventId: textSource('om_complete'), workingDir: '/tmp/x', expectedRevision: 0 }));
    writeFileSync(join(dir, 'group-workspaces.json.999.deadbeef.tmp'), '{partial');

    expect(await new GroupWorkspaceStore(dir).read(CHAT)).toMatchObject({
      status: 'available',
      record: { revision: 1, directory: { kind: 'bound', workingDir: '/tmp/x' } },
    });
  });

  it.each([
    ['blank chatId', { chatId: ' ' }],
    ['non-canonical sourceEventId', { sourceEventId: 'delivery-attempt-1' }],
    ['unstable actor tenant', { actor: { tenantKey: ' tenant-a', unionId: 'on_user_u' } }],
    ['unstable actor union', { actor: { tenantKey: 'tenant-a', unionId: 'ou_app_scoped' } }],
    ['negative revision', { expectedRevision: -1 }],
    ['unsafe revision', { expectedRevision: Number.MAX_SAFE_INTEGER + 1 }],
    ['negative generation', { expectedSessionGeneration: -1 }],
    ['non-finite time', { now: Number.POSITIVE_INFINITY }],
    ['negative time', { now: -1 }],
    ['non-boolean semantic validity', { directoryValid: 'yes' }],
    ['relative target despite semantic validity', { requestedWorkingDir: 'relative' }],
    ['blank invalid target', { requestedWorkingDir: '', directoryValid: false }],
  ])('rejects malformed mutation input before lookup or write: %s', async (_name, patch) => {
    const dir = dataDir();
    const path = join(dir, 'group-workspaces.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, records: {}, receipts: {} }));
    let reads = 0;
    let writes = 0;
    const store = new GroupWorkspaceStore(dir, {
      onRegistryRead: () => { reads += 1; },
      writer: (...args) => {
        writes += 1;
        atomicWriteFileSync(...args);
      },
    });
    const result = await store.mutate({
      ...setInput({ sourceEventId: textSource(`om_invalid_${_name}`), workingDir: '/tmp/X', expectedRevision: 0 }),
      ...patch,
    } as any);
    expect(result).toEqual({ outcome: 'store_unavailable' });
    expect(reads).toBe(0);
    expect(writes).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(JSON.stringify({ schemaVersion: 1, records: {}, receipts: {} }));
  });

  it('leaves a readable store byte-for-byte unchanged for malformed mutation input', async () => {
    const dir = dataDir();
    const path = join(dir, 'group-workspaces.json');
    const store = new GroupWorkspaceStore(dir);
    await store.mutate(setInput({
      sourceEventId: textSource('om_valid_seed'), workingDir: '/tmp/seed', expectedRevision: 0,
    }));
    const before = readFileSync(path, 'utf8');
    const result = await store.mutate({
      ...setInput({ sourceEventId: textSource('om_bad_after_seed'), workingDir: '/tmp/bad', expectedRevision: 1 }),
      now: Number.NaN,
    });
    expect(result).toEqual({ outcome: 'store_unavailable' });
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(await new GroupWorkspaceStore(dir).read(CHAT)).toMatchObject({
      status: 'available', record: { revision: 1, directory: { workingDir: '/tmp/seed' } },
    });
  });

  it('exposes lookup counters used to prove validation and replay short-circuit ordering', async () => {
    const dir = dataDir();
    let reads = 0;
    let records = 0;
    let targets = 0;
    const store = new GroupWorkspaceStore(dir, {
      onRegistryRead: () => { reads += 1; },
      onCurrentRecordAccess: () => { records += 1; },
      onCanonicalTargetAccess: () => { targets += 1; },
    });
    await store.mutate(setInput({
      sourceEventId: textSource('om_counter_wiring'), workingDir: '/tmp/X', expectedRevision: 0,
    }));
    expect({ reads, records, targets }).toEqual({ reads: 1, records: 1, targets: 1 });
  });

  it('returns store_unavailable when an injected write fails before rename and leaves no receipt', async () => {
    const dir = dataDir();
    const store = new GroupWorkspaceStore(dir, {
      writer: () => { throw new Error('before rename'); },
    });
    const result = await store.mutate(setInput({
      sourceEventId: textSource('om_before_rename'),
      workingDir: '/tmp/X',
      expectedRevision: 0,
    }));
    expect(result).toEqual({ outcome: 'store_unavailable' });
    expect(await new GroupWorkspaceStore(dir).read(CHAT)).toEqual({ status: 'available', record: undefined });
  });

  it('reconciles an injected post-rename failure to the committed receipt without retrying', async () => {
    const dir = dataDir();
    let writes = 0;
    const store = new GroupWorkspaceStore(dir, {
      writer: (...args) => {
        writes += 1;
        atomicWriteFileSync(...args);
        throw new Error('directory fsync result lost');
      },
    });
    const result = await store.mutate(setInput({
      sourceEventId: textSource('om_after_rename'),
      workingDir: '/tmp/X',
      expectedRevision: 0,
    }));
    expect(result).toMatchObject({ outcome: 'committed', receipt: { resultingRevision: 1 } });
    expect(writes).toBe(1);
    expect(await new GroupWorkspaceStore(dir).read(CHAT)).toMatchObject({
      status: 'available', record: { revision: 1, directory: { workingDir: '/tmp/X' } },
    });
  });

  it('returns unknown when a caught write cannot be reconciled from the durable store', async () => {
    const dir = dataDir();
    const store = new GroupWorkspaceStore(dir, {
      writer: (path) => {
        writeFileSync(path, '{ambiguous unreadable replacement');
        throw new Error('directory fsync result lost');
      },
    });
    const result = await store.mutate(setInput({
      sourceEventId: textSource('om_unknown'),
      workingDir: '/tmp/X',
      expectedRevision: 0,
    }));
    expect(result).toEqual({ outcome: 'unknown' });
  });

  it('returns store_unavailable when the cross-process lock cannot be acquired', async () => {
    const dir = dataDir();
    writeFileSync(join(dir, 'group-workspaces.json.lock'), String(process.pid));
    const store = new GroupWorkspaceStore(dir, { lockTimeoutMs: 0 });
    const result = await store.mutate(setInput({
      sourceEventId: textSource('om_locked'),
      workingDir: '/tmp/x',
      expectedRevision: 0,
    }));
    expect(result.outcome).toBe('store_unavailable');
  });

  it('serializes parallel writers so exactly one CAS commits', async () => {
    const dir = dataDir();
    const [left, right] = await Promise.all([
      new GroupWorkspaceStore(dir).mutate(setInput({ sourceEventId: textSource('om_left'), workingDir: '/tmp/left', expectedRevision: 0 })),
      new GroupWorkspaceStore(dir).mutate(setInput({ sourceEventId: textSource('om_right'), workingDir: '/tmp/right', expectedRevision: 0 })),
    ]);
    expect([left.outcome, right.outcome].sort()).toEqual(['committed', 'conflict']);
    expect((await new GroupWorkspaceStore(dir).read(CHAT))).toMatchObject({
      status: 'available',
      record: { revision: 1 },
    });
  });

  it('derives stable canonical text and card source identities', () => {
    const textA = canonicalTextSourceEventId({ tenantKey: 'tenant-a', chatId: CHAT, messageId: 'om_original', deliveryEventId: 'evt-a' });
    const textB = canonicalTextSourceEventId({ tenantKey: 'tenant-a', chatId: CHAT, messageId: 'om_original', deliveryEventId: 'evt-b' });
    const fallback = canonicalTextSourceEventId({
      chatId: CHAT,
      messageId: 'om_original',
      verifiedTenantMapping: { tenantKey: 'tenant-a', verifiedAcrossApps: true },
    });
    expect(textA).toEqual(textB);
    expect(fallback).toEqual(textA);
    expect(canonicalTextSourceEventId({ chatId: CHAT, messageId: 'om_original' })).toEqual({ ok: false, reason: 'unverifiable_tenant' });
    expect(canonicalTextSourceEventId({
      chatId: CHAT,
      messageId: 'om_original',
      verifiedTenantMapping: { tenantKey: 'tenant-a', verifiedAcrossApps: false },
    })).toEqual({ ok: false, reason: 'unverifiable_tenant' });

    const cardA = canonicalCardSourceEventId({ tenantKey: 'tenant-a', chatId: CHAT, originMessageId: 'om_card', actionId: 'act-1', deliveryAttemptId: 'try-1' });
    const cardARetry = canonicalCardSourceEventId({ tenantKey: 'tenant-a', chatId: CHAT, originMessageId: 'om_card', actionId: 'act-1', deliveryAttemptId: 'try-2' });
    const cardB = canonicalCardSourceEventId({ tenantKey: 'tenant-a', chatId: CHAT, originMessageId: 'om_card', actionId: 'act-2' });
    expect(cardA).toEqual(cardARetry);
    expect(cardB).not.toEqual(cardA);
  });

  it('shares text identity across Bots and replays historical M1 after recovery without writing current revision or target', async () => {
    const dir = dataDir();
    const botA = new GroupWorkspaceStore(dir);
    const m1FromBotA = canonicalTextSourceEventId({
      tenantKey: 'tenant-a', chatId: CHAT, messageId: 'om_m1', deliveryAttemptId: 'bot-a-live-attempt',
    });
    const m1FromBotBRecovery = canonicalTextSourceEventId({
      tenantKey: 'tenant-a', chatId: CHAT, messageId: 'om_m1', deliveryAttemptId: 'bot-b-historical-recovery',
    });
    if (!m1FromBotA.ok || !m1FromBotBRecovery.ok) throw new Error('unexpected source failure');
    expect(m1FromBotBRecovery).toEqual(m1FromBotA);
    const m2 = textSource('om_m2');
    const m1Input = setInput({ sourceEventId: m1FromBotA.sourceEventId, workingDir: '/tmp/X', expectedRevision: 0, expectedSessionGeneration: 7 });
    const first = await botA.mutate(m1Input);
    await botA.mutate(setInput({ sourceEventId: m2, workingDir: '/tmp/Y', expectedRevision: 1, expectedSessionGeneration: 8 }));

    let botBWrites = 0;
    let botBRecordAccesses = 0;
    let botBTargetAccesses = 0;
    const botBReloaded = new GroupWorkspaceStore(dir, {
      onCurrentRecordAccess: () => { botBRecordAccesses += 1; },
      onCanonicalTargetAccess: () => { botBTargetAccesses += 1; },
      writer: (...args) => {
        botBWrites += 1;
        atomicWriteFileSync(...args);
      },
    });
    const replay = await botBReloaded.mutate({
      ...m1Input,
      sourceEventId: m1FromBotBRecovery.sourceEventId,
      // Values derived from current state must not change the semantic digest or frozen receipt.
      expectedRevision: 2,
      expectedSessionGeneration: 99,
    });
    expect(replay).toEqual(first);
    expect(botBWrites).toBe(0);
    expect(botBRecordAccesses).toBe(0);
    expect(botBTargetAccesses).toBe(0);
    expect(replay).toMatchObject({
      outcome: 'committed',
      receipt: {
        expectedRevision: 0,
        expectedSessionGeneration: 7,
        canonicalTargetWorkingDir: '/tmp/X',
      },
    });
    expect(await new GroupWorkspaceStore(dir).read(CHAT)).toMatchObject({
      status: 'available',
      record: { revision: 2, directory: { kind: 'bound', workingDir: '/tmp/Y' } },
    });
    expect(canonicalGroupOperationPayloadDigest(m1Input)).toBe(canonicalGroupOperationPayloadDigest({ ...m1Input, expectedRevision: 42 }));
  });

  it('rejects reuse of one source with different semantic intent or operation kind', async () => {
    const dir = dataDir();
    const store = new GroupWorkspaceStore(dir);
    const sourceEventId = textSource('om_protocol');
    await store.mutate(setInput({ sourceEventId, workingDir: '/tmp/X', expectedRevision: 0 }));
    const conflict = await store.mutate(setInput({ sourceEventId, workingDir: '/tmp/Z', expectedRevision: 1 }));
    expect(conflict.outcome).toBe('protocol_conflict');
    const kindConflict = await store.mutate({
      kind: 'unbind',
      chatId: CHAT,
      sourceEventId,
      expectedRevision: 1,
      actor: U,
      authorized: true,
      now: 200,
    });
    expect(kindConflict.outcome).toBe('protocol_conflict');
    expect(await store.read(CHAT)).toMatchObject({ record: { revision: 1, directory: { workingDir: '/tmp/X' } } });
  });

  it('keeps revisions monotonic across tombstones and rejects an old CAS', async () => {
    const dir = dataDir();
    const store = new GroupWorkspaceStore(dir);
    await store.mutate(setInput({ sourceEventId: textSource('om_set_x'), workingDir: '/tmp/X', expectedRevision: 0 }));
    const unbindInput = {
      kind: 'unbind' as const,
      chatId: CHAT,
      sourceEventId: textSource('om_unbind'),
      expectedRevision: 1,
      actor: U,
      authorized: true,
      now: 200,
    };
    const unbound = await store.mutate(unbindInput);
    expect(unbound).toMatchObject({ outcome: 'committed', receipt: { resultingRevision: 2, resultingDirectory: { kind: 'unbound' } } });
    expect(await new GroupWorkspaceStore(dir).mutate({ ...unbindInput, expectedRevision: 99 })).toEqual(unbound);
    await store.mutate(setInput({ sourceEventId: textSource('om_set_y'), workingDir: '/tmp/Y', expectedRevision: 2 }));
    expect((await store.mutate(setInput({ sourceEventId: textSource('om_delayed_z'), workingDir: '/tmp/Z', expectedRevision: 1 }))).outcome).toBe('conflict');
    expect(await store.read(CHAT)).toMatchObject({ record: { revision: 3, directory: { kind: 'bound', workingDir: '/tmp/Y' } } });
  });

  it('retains existing workspaceManagers on a tombstone so default administrators do not regain access', async () => {
    const dir = dataDir();
    const sourceEventId = textSource('om_acl_seed');
    const payloadDigest = canonicalGroupOperationPayloadDigest(setInput({
      sourceEventId,
      workingDir: '/tmp/X',
      expectedRevision: 0,
    }));
    const operationKey = groupWorkspaceOperationKey(sourceEventId, 'set');
    writeFileSync(join(dir, 'group-workspaces.json'), JSON.stringify({
      schemaVersion: 1,
      records: {
        [CHAT]: {
          chatId: CHAT,
          revision: 1,
          directory: { kind: 'bound', workingDir: '/tmp/X' },
          workspaceManagers: [U],
          updatedAt: 100,
          updatedBy: U,
        },
      },
      receipts: {
        [operationKey]: {
          operationKey,
          sourceEventId,
          kind: 'set',
          payloadDigest,
          chatId: CHAT,
          outcome: 'committed',
          resultingRevision: 1,
          resultingDirectory: { kind: 'bound', workingDir: '/tmp/X' },
          actor: U,
          completedAt: 100,
          expectedRevision: 0,
          expectedSessionGeneration: 1,
          canonicalTargetWorkingDir: '/tmp/X',
        },
      },
    }));
    const store = new GroupWorkspaceStore(dir);
    await store.mutate({ kind: 'unbind', chatId: CHAT, sourceEventId: textSource('om_acl_unbind'), expectedRevision: 1, actor: U, authorized: true, now: 200 });
    expect(await new GroupWorkspaceStore(dir).read(CHAT)).toMatchObject({ record: { revision: 2, workspaceManagers: [U], directory: { kind: 'unbound' } } });
    const denied = await new GroupWorkspaceStore(dir).mutate(setInput({ sourceEventId: textSource('om_v_set'), workingDir: '/tmp/V', expectedRevision: 2, actor: V }));
    expect(denied.outcome).toBe('unauthorized');
  });

  it('does not allow an ordinary directory set to establish workspaceManagers', async () => {
    const dir = dataDir();
    const result = await new GroupWorkspaceStore(dir).mutate({
      ...setInput({ sourceEventId: textSource('om_acl_injection'), workingDir: '/tmp/X', expectedRevision: 0, actor: V }),
      workspaceManagers: [U],
    });
    expect(result.outcome).toBe('committed');
    expect(await new GroupWorkspaceStore(dir).read(CHAT)).toMatchObject({
      status: 'available',
      record: { revision: 1, directory: { workingDir: '/tmp/X' } },
    });
    expect((await new GroupWorkspaceStore(dir).read(CHAT) as { status: 'available'; record?: { workspaceManagers?: TenantHumanId[] } }).record?.workspaceManagers).toBeUndefined();
  });

  it('fails closed instead of overflowing the revision counter', async () => {
    const dir = dataDir();
    writeFileSync(join(dir, 'group-workspaces.json'), JSON.stringify({
      schemaVersion: 1,
      records: {
        [CHAT]: {
          chatId: CHAT,
          revision: Number.MAX_SAFE_INTEGER,
          directory: { kind: 'unbound' },
          updatedAt: 100,
          updatedBy: U,
        },
      },
      receipts: {},
    }));
    const outcome = await new GroupWorkspaceStore(dir).mutate(setInput({
      sourceEventId: textSource('om_exhausted'),
      workingDir: '/tmp/X',
      expectedRevision: Number.MAX_SAFE_INTEGER,
    }));
    expect(outcome.outcome).toBe('store_unavailable');
    expect(await new GroupWorkspaceStore(dir).read(CHAT)).toMatchObject({
      status: 'available',
      record: { revision: Number.MAX_SAFE_INTEGER, directory: { kind: 'unbound' } },
    });
  });

  it('returns invalid_dir and unauthorized terminal outcomes without changing revision', async () => {
    const dir = dataDir();
    const store = new GroupWorkspaceStore(dir);
    expect((await store.mutate({ ...setInput({ sourceEventId: textSource('om_invalid'), workingDir: 'relative', expectedRevision: 0 }), directoryValid: false })).outcome).toBe('invalid_dir');
    expect((await store.mutate({ ...setInput({ sourceEventId: textSource('om_unauthorized'), workingDir: '/tmp/X', expectedRevision: 0 }), authorized: false })).outcome).toBe('unauthorized');
    expect(await store.read(CHAT)).toEqual({ status: 'available', record: undefined });
  });
});
