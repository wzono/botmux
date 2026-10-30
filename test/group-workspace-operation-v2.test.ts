import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';
import { GroupWorkspaceOperationStore } from '../src/services/group-workspace-operation-store.js';
import { OperationExecutorLeaseStore } from '../src/services/operation-executor-lease-store.js';
import { groupWorkspaceOperationKey } from '../src/services/group-workspace-store.js';

const identity = { path: '/repo/x', dev: '1', ino: '2' };
const sourceEventId = 'group-workspace-text-source-v1:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const journal: any = { operationKey: groupWorkspaceOperationKey(sourceEventId, 'set'),
  sourceEventId, kind: 'set',
  requestIntentDigest: 'intent', payloadDigest: 'payload', chatId: 'chat', sessionId: 'session', expectedSessionGeneration: 1,
  expectedGroupRevision: 0, target: { kind: 'workspace', identity }, targetWorkingDir: identity.path, targetWorkspaceIdentity: identity, actor: { tenantKey: 'tenant', unionId: 'on_user' }, phase: 'prepared', updatedAt: 1 };
const dir = () => mkdtempSync(join(tmpdir(), 'operation-v2-'));

describe('same-source winner and executor lease', () => {
  it('adopts the frozen same-intent winner', async () => {
    const store = new GroupWorkspaceOperationStore(dir());
    expect((await store.prepareOrAdopt(journal)).status).toBe('created');
    const adopted = await store.prepareOrAdopt({ ...journal, expectedSessionGeneration: 99, targetWorkingDir: '/other', targetWorkspaceIdentity: { ...identity, path: '/other' } });
    expect(adopted).toMatchObject({ status: 'adopted', journal: { targetWorkingDir: '/repo/x', expectedSessionGeneration: 1 } });
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
