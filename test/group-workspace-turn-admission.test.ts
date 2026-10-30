import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyTurn, runExistingWorkerAdmission, runBlankBootstrapAdmission } from '../src/core/turn-admission.js';
import { TurnPermitStore } from '../src/services/turn-permit-store.js';

const identity = { path: '/repo/x', dev: '1', ino: '2' };
const base = { sessionId: 's1', turnId: 't1', target: identity, groupRevision: 3, expiresAt: 200 };

describe('unified turn admission', () => {
  it.each(['ordinary', 'listener', 'trigger', 'dashboard_opening', 'queue', 'principal', 'xpi', 'scheduler', 'recovery'] as const)
  ('classifies %s as business', origin => expect(classifyTurn({ origin })).toBe('business'));
  it.each(['repo_show', 'repo_unbind_without_cli'] as const)
  ('classifies %s as management', origin => expect(classifyTurn({ origin })).toBe('management'));
  it('keeps non-business classes explicit', () => {
    expect(classifyTurn({ origin: 'ask_reply' })).toBe('control_reply');
    expect(classifyTurn({ origin: 'terminal_bytes' })).toBe('terminal_bytes');
    expect(classifyTurn({ origin: 'durable_output' })).toBe('output_delivery');
  });
  it('orders existing-worker proof before permit and lease', async () => {
    const trace: string[] = [];
    await runExistingWorkerAdmission({
      botGate: async () => { trace.push('bot_gate'); }, resolve: async () => { trace.push('workspace_resolve'); return identity; },
      follow: async () => { trace.push('follow'); }, consume: async () => { trace.push('consume'); },
      issueBusinessPermit: async () => { trace.push('business_permit'); }, resourceLease: async () => { trace.push('resource_lease'); },
      markAttempting: async () => { trace.push('attempting'); }, submit: async () => { trace.push('submit'); },
    });
    expect(trace).toEqual(['bot_gate', 'workspace_resolve', 'follow', 'consume', 'business_permit', 'resource_lease', 'attempting', 'submit']);
  });
  it.each(['resolve', 'follow', 'consume'] as const)('stops before permit when %s fails', async failed => {
    const trace: string[] = [];
    await expect(runExistingWorkerAdmission({
      botGate: async () => { trace.push('bot_gate'); },
      resolve: async () => { trace.push('workspace_resolve'); if (failed === 'resolve') throw new Error(failed); return identity; },
      follow: async () => { trace.push('follow'); if (failed === 'follow') throw new Error(failed); },
      consume: async () => { trace.push('consume'); if (failed === 'consume') throw new Error(failed); },
      issueBusinessPermit: async () => { trace.push('business_permit'); }, resourceLease: async () => { trace.push('resource_lease'); },
      markAttempting: async () => { trace.push('attempting'); }, submit: async () => { trace.push('submit'); },
    })).rejects.toThrow(failed);
    expect(trace).not.toContain('business_permit'); expect(trace).not.toContain('resource_lease');
  });
  it('performs AR-01 blank bootstrap without carrying opening payload', async () => {
    const trace: string[] = [];
    await runBlankBootstrapAdmission({
      resolve: async () => { trace.push('resolve'); return identity; }, reserveGeneration: async () => { trace.push('reserve_generation'); return 4; },
      persistBlankPermit: async () => { trace.push('persist_blank_permit'); },
      forkBlank: async payload => { trace.push(`blank_fork(${payload.length === 0 ? 'zero_payload' : 'payload'})`); },
      proveReady: async () => { trace.push('ready_generation'); }, proveCwdIdentity: async () => { trace.push('cwd_identity_proof'); },
      proveBackend: async () => { trace.push('backend_proof'); }, persistBusinessPermit: async () => { trace.push('persist_business_permit'); },
      submitOnce: async () => { trace.push('submit_once'); },
    });
    expect(trace).toEqual(['resolve', 'reserve_generation', 'persist_blank_permit', 'blank_fork(zero_payload)', 'ready_generation', 'cwd_identity_proof', 'backend_proof', 'persist_business_permit', 'submit_once']);
  });
});

describe('durable turn permits', () => {
  it('deduplicates generation and submission receipt across restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'turn-permit-')); const store = new TurnPermitStore(dataDir, { now: () => 100 });
    const first = await store.issueBlank({ ...base, reservedGeneration: 4 });
    expect(await store.issueBlank({ ...base, reservedGeneration: 99 })).toEqual(first);
    expect((await store.beginSpawn(first)).status).toBe('acquired');
    expect((await new TurnPermitStore(dataDir, { now: () => 100 }).beginSpawn(first)).status).toBe('observing');
    const business = await store.proveReady(first, { actualGeneration: 4, cwd: identity, backend: identity });
    expect(business.status).toBe('issued'); if (business.status !== 'issued') throw new Error('expected business permit');
    const restarted = new TurnPermitStore(dataDir, { now: () => 100 });
    expect((await restarted.beginBusinessDispatch(business.permit, 'digest-a')).status).toBe('acquired');
    expect((await restarted.beginBusinessDispatch(business.permit, 'digest-a')).status).toBe('observing');
    expect((await restarted.markBusinessDelivered(business.permit, 'digest-a', { downstreamReceiptId: 'turn:t1' })).status).toBe('delivered');
    expect(await restarted.beginBusinessDispatch(business.permit, 'digest-a')).toMatchObject({ status: 'delivered', receipt: { payloadDigest: 'digest-a', downstreamReceiptId: 'turn:t1' } });
    expect((await restarted.beginBusinessDispatch(business.permit, 'digest-b')).status).toBe('rejected');
  });
  it('fails closed on expiry, mismatched proof and terminal failure', async () => {
    let now = 100; const store = new TurnPermitStore(mkdtempSync(join(tmpdir(), 'turn-permit-')), { now: () => now });
    const blank = await store.issueBlank({ ...base, reservedGeneration: 4 });
    expect((await store.proveReady(blank, { actualGeneration: 5, cwd: identity, backend: identity })).status).toBe('generation_mismatch');
    const second = await store.issueBlank({ ...base, turnId: 't2', reservedGeneration: 5 });
    expect((await store.proveReady(second, { actualGeneration: 5, cwd: { ...identity, ino: '9' }, backend: identity })).status).toBe('identity_mismatch');
    const third = await store.issueBlank({ ...base, turnId: 't3', reservedGeneration: 6 }); await store.failBootstrap(third, 'spawn_failed');
    expect((await store.beginSpawn(third)).status).toBe('spawn_failed');
    const expired = await store.issueBlank({ ...base, turnId: 't4', reservedGeneration: 7, expiresAt: 101 }); now = 102;
    expect((await store.beginSpawn(expired)).status).toBe('expired');
  });
  it('rejects wrong-bound permits', async () => {
    const store = new TurnPermitStore(mkdtempSync(join(tmpdir(), 'turn-permit-')), { now: () => 100 });
    const blank = await store.issueBlank({ ...base, reservedGeneration: 4 });
    expect((await store.beginSpawn({ ...blank, sessionId: 'other' })).status).toBe('rejected');
    const business = await store.proveReady(blank, { actualGeneration: 4, cwd: identity, backend: identity });
    if (business.status !== 'issued') throw new Error('expected business permit');
    expect((await store.consumeBusiness({ ...business.permit, workerGeneration: 9 }, 'digest')).status).toBe('rejected');
  });
});
