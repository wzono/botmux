import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  admitTurn,
  admitTurnUnderMutation,
  classifyTurn,
  markBusinessAttempting,
  resumeOriginalTurnReply,
  reconcileTurnPermitDispatches,
  runExistingWorkerAdmission,
  runBlankBootstrapAdmission,
} from '../src/core/turn-admission.js';
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
  it('returns discriminated production admission outcomes under the shared gate', async () => {
    const trace: string[] = [];
    const admitted = await admitTurn({
      runUnderAdmission: async run => { trace.push('gate'); return run(); },
      admitUnderMutation: async () => ({ status: 'rejected', reason: 'unsupported_backend' }),
    });
    expect(admitted).toEqual({ status: 'rejected', reason: 'unsupported_backend' });
    expect(trace).toEqual(['gate']);
  });
  it('does not reacquire the shared gate under an existing mutation', async () => {
    const result = await admitTurnUnderMutation({
      admitUnderMutation: async () => ({ status: 'deferred', reason: 'busy' }),
    });
    expect(result).toEqual({ status: 'deferred', reason: 'busy' });
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
  it('reissues only after a CAS-bound pre-fork abort across restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'turn-permit-'));
    const store = new TurnPermitStore(dataDir, { now: () => 100 });
    const first = await store.issueBlank({ ...base, reservedGeneration: 4 });
    expect((await store.beginSpawn(first)).status).toBe('acquired');
    const restarted = new TurnPermitStore(dataDir, { now: () => 101 });
    expect((await restarted.abortBootstrap(first, {
      phase: 'pre_fork', observedGeneration: 3, orphanRetired: true,
    })).status).toBe('aborted');
    const second = await restarted.issueBlank({ ...base, reservedGeneration: 5 });
    expect(second.permitId).not.toBe(first.permitId);
    expect(second.reservedGeneration).toBe(5);
    expect((await restarted.beginSpawn(second)).status).toBe('acquired');
    expect((await restarted.abortBootstrap(first, {
      phase: 'pre_fork', observedGeneration: 3, orphanRetired: true,
    })).status).toBe('rejected');
  });

  it('reissues an expired bootstrap only after exact-generation orphan retirement and remains single-winner', async () => {
    let now = 100;
    const store = new TurnPermitStore(mkdtempSync(join(tmpdir(), 'turn-permit-')), { now: () => now });
    const first = await store.issueBlank({ ...base, reservedGeneration: 4, expiresAt: 101 });
    expect((await store.beginSpawn(first)).status).toBe('acquired');
    now = 102;
    expect((await store.beginSpawn(first)).status).toBe('expired');
    expect(await store.issueBlank({ ...base, reservedGeneration: 5, expiresAt: 200 })).toEqual(first);
    expect((await store.abortBootstrap(first, {
      phase: 'forked_unproven', observedGeneration: 4, orphanRetired: false,
    })).status).toBe('orphan_unproven');
    expect((await store.abortBootstrap(first, {
      phase: 'forked_unproven', observedGeneration: 4, orphanRetired: true, retiredGeneration: 4,
    })).status).toBe('aborted');
    const [winner, duplicate] = await Promise.all([
      store.issueBlank({ ...base, reservedGeneration: 5, expiresAt: 200 }),
      store.issueBlank({ ...base, reservedGeneration: 6, expiresAt: 200 }),
    ]);
    expect(duplicate).toEqual(winner);
    expect(winner.permitId).not.toBe(first.permitId);
  });

  it('requires orphan-generation retirement before reissuing a forked unproven bootstrap', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'turn-permit-'));
    const store = new TurnPermitStore(dataDir, { now: () => 100 });
    const first = await store.issueBlank({ ...base, reservedGeneration: 4 });
    await store.beginSpawn(first);
    expect((await store.abortBootstrap(first, {
      phase: 'forked_unproven', observedGeneration: 4, orphanRetired: false,
    })).status).toBe('orphan_unproven');
    expect(await store.issueBlank({ ...base, reservedGeneration: 5 })).toEqual(first);
    expect((await new TurnPermitStore(dataDir, { now: () => 101 }).abortBootstrap(first, {
      phase: 'forked_unproven', observedGeneration: 4, orphanRetired: true, retiredGeneration: 4,
    })).status).toBe('aborted');
    const second = await store.issueBlank({ ...base, reservedGeneration: 5 });
    expect(second.permitId).not.toBe(first.permitId);
  });

  it('releases a terminal spawn failure only after exact-generation orphan proof', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'turn-permit-'));
    const store = new TurnPermitStore(dataDir, { now: () => 100 });
    const first = await store.issueBlank({ ...base, reservedGeneration: 4 });
    await store.beginSpawn(first);
    await store.failBootstrap(first, 'spawn_failed');
    expect((await store.abortBootstrap(first, {
      phase: 'forked_unproven', observedGeneration: 4, orphanRetired: false,
    })).status).toBe('orphan_unproven');
    expect(await store.issueBlank({ ...base, reservedGeneration: 5 })).toEqual(first);
    expect((await store.abortBootstrap(first, {
      phase: 'forked_unproven', observedGeneration: 4, orphanRetired: true, retiredGeneration: 4,
    })).status).toBe('aborted');
    const reissued = await store.issueBlank({ ...base, reservedGeneration: 5 });
    expect(reissued.permitId).not.toBe(first.permitId);
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
  it('delivers only after an exact session, turn and generation worker ACK', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'turn-permit-'));
    const store = new TurnPermitStore(dataDir, { now: () => 100 });
    const blank = await store.issueBlank({ ...base, reservedGeneration: 4 });
    expect((await store.beginSpawn(blank)).status).toBe('acquired');
    const issued = await store.proveReady(blank, { actualGeneration: 4, cwd: identity, backend: identity });
    if (issued.status !== 'issued') throw new Error('expected business permit');
    expect((await store.beginBusinessDispatch(issued.permit, 'digest-a')).status).toBe('acquired');
    expect((await store.acknowledgeBusinessDelivery({ sessionId: 'other', turnId: 't1', workerGeneration: 4 })).status).toBe('rejected');
    expect((await store.acknowledgeBusinessDelivery({ sessionId: 's1', turnId: 't1', workerGeneration: 5 })).status).toBe('rejected');
    expect((await store.acknowledgeBusinessDelivery({ sessionId: 's1', turnId: 't1', workerGeneration: 4 })).status).toBe('delivered');
    expect((await new TurnPermitStore(dataDir, { now: () => 101 }).beginBusinessDispatch(issued.permit, 'digest-a')).status).toBe('delivered');
  });
  it('reconciles persisted ACKs, safe retry, and ambiguity after restart', async () => {
    const make = async (turnId: string) => {
      const store = new TurnPermitStore(mkdtempSync(join(tmpdir(), 'turn-permit-')), { now: () => 100 });
      const blank = await store.issueBlank({ ...base, turnId, reservedGeneration: 4 });
      await store.beginSpawn(blank);
      const issued = await store.proveReady(blank, { actualGeneration: 4, cwd: identity, backend: identity });
      if (issued.status !== 'issued') throw new Error('expected business permit');
      await store.beginBusinessDispatch(issued.permit, `digest-${turnId}`);
      return { store, permit: issued.permit };
    };
    const acknowledged = await make('acked');
    expect((await acknowledged.store.reconcileBusinessDispatch(acknowledged.permit, {
      ack: { sessionId: 's1', turnId: 'acked', workerGeneration: 4 }, safeToRetry: false,
    })).status).toBe('delivered');
    const retryable = await make('retry');
    expect((await retryable.store.reconcileBusinessDispatch(retryable.permit, { safeToRetry: true })).status).toBe('retry');
    expect((await retryable.store.beginBusinessDispatch(retryable.permit, 'digest-retry')).status).toBe('acquired');
    expect((await retryable.store.reconcileBusinessDispatch(retryable.permit, { safeToRetry: true })).status).toBe('ambiguous');
    const ambiguous = await make('ambiguous');
    expect((await ambiguous.store.reconcileBusinessDispatch(ambiguous.permit, { safeToRetry: false })).status).toBe('ambiguous');
    expect((await ambiguous.store.beginBusinessDispatch(ambiguous.permit, 'digest-ambiguous')).status).toBe('rejected');
  });
  it('startup reconciliation adopts persisted ACK or grants only one safe retry', async () => {
    const make = async (turnId: string) => {
      const store = new TurnPermitStore(mkdtempSync(join(tmpdir(), 'turn-permit-')), { now: () => 100 });
      const blank = await store.issueBlank({ ...base, turnId, reservedGeneration: 4 });
      await store.beginSpawn(blank);
      const issued = await store.proveReady(blank, { actualGeneration: 4, cwd: identity, backend: identity });
      if (issued.status !== 'issued') throw new Error('expected business permit');
      await store.beginBusinessDispatch(issued.permit, `digest-${turnId}`);
      return { store, permit: issued.permit };
    };
    const acked = await make('acked-startup');
    await reconcileTurnPermitDispatches({
      pending: await acked.store.listDispatching(),
      sessions: [{ sessionId: 's1', workerGeneration: 4, workerAlive: false, dispatchInputReceipts: { 'acked-startup': { workerGeneration: 4 } } }],
      reconcile: (permit, evidence) => acked.store.reconcileBusinessDispatch(permit, evidence),
    });
    expect((await acked.store.beginBusinessDispatch(acked.permit, 'digest-acked-startup')).status).toBe('delivered');
    const retry = await make('retry-startup');
    await reconcileTurnPermitDispatches({
      pending: await retry.store.listDispatching(),
      sessions: [{ sessionId: 's1', workerGeneration: 5, workerAlive: false }],
      reconcile: (permit, evidence) => retry.store.reconcileBusinessDispatch(permit, evidence),
    });
    expect((await retry.store.beginBusinessDispatch(retry.permit, 'digest-retry-startup')).status).toBe('acquired');
    await reconcileTurnPermitDispatches({
      pending: await retry.store.listDispatching(),
      sessions: [{ sessionId: 's1', workerGeneration: 5, workerAlive: false }],
      reconcile: (permit, evidence) => retry.store.reconcileBusinessDispatch(permit, evidence),
    });
    expect((await retry.store.beginBusinessDispatch(retry.permit, 'digest-retry-startup')).status).toBe('rejected');
  });
  it('marks startup dispatch ambiguous when the restored session is absent', async () => {
    const store = new TurnPermitStore(mkdtempSync(join(tmpdir(), 'turn-permit-')), { now: () => 100 });
    const blank = await store.issueBlank({ ...base, turnId: 'not-restored', reservedGeneration: 4 });
    await store.beginSpawn(blank);
    const issued = await store.proveReady(blank, { actualGeneration: 4, cwd: identity, backend: identity });
    if (issued.status !== 'issued') throw new Error('expected business permit');
    await store.beginBusinessDispatch(issued.permit, 'digest-not-restored');
    await reconcileTurnPermitDispatches({
      pending: await store.listDispatching(), sessions: [],
      reconcile: (permit, evidence) => store.reconcileBusinessDispatch(permit, evidence),
    });
    expect((await store.beginBusinessDispatch(issued.permit, 'digest-not-restored')).status).toBe('rejected');
  });
  it('repairs a post-restart dispatch from a late exact ACK after live-generation reconcile', async () => {
    const store = new TurnPermitStore(mkdtempSync(join(tmpdir(), 'turn-permit-')), { now: () => 100 });
    const blank = await store.issueBlank({ ...base, turnId: 'late-ack', reservedGeneration: 4 });
    await store.beginSpawn(blank);
    const issued = await store.proveReady(blank, { actualGeneration: 4, cwd: identity, backend: identity });
    if (issued.status !== 'issued') throw new Error('expected business permit');
    await store.beginBusinessDispatch(issued.permit, 'digest-late-ack');
    await reconcileTurnPermitDispatches({
      pending: await store.listDispatching(),
      sessions: [{ sessionId: 's1', workerGeneration: 4, workerAlive: true }],
      reconcile: (permit, evidence) => store.reconcileBusinessDispatch(permit, evidence),
    });
    expect((await store.acknowledgeBusinessDelivery({ sessionId: 's1', turnId: 'late-ack', workerGeneration: 4 })).status).toBe('delivered');
    expect((await store.acknowledgeBusinessDelivery({ sessionId: 's1', turnId: 'late-ack', workerGeneration: 5 })).status).toBe('rejected');
  });
  it('binds control dispatch and delivery ACK to the original wait and frozen workspace', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'turn-permit-'));
    const store = new TurnPermitStore(dataDir, { now: () => 100 });
    const permit = await store.issueControlReply({
      sessionId: 's1', originalTurnId: 'original', wait: { kind: 'ask', askId: 'ask-1' },
      expectedGeneration: 4, workspace: identity, groupRevision: 3, expiresAt: 200,
    });
    expect((await store.beginControlReplyDispatch(permit, 'answer-a', {
      sessionId: 's1', originalTurnId: 'original', wait: { kind: 'ask', askId: 'wrong' },
      workerGeneration: 4, workspace: identity, groupRevision: 3, originalState: 'needs_user', authorized: true,
    })).status).toBe('rejected');
    const proof = {
      sessionId: 's1', originalTurnId: 'original', wait: { kind: 'ask' as const, askId: 'ask-1' },
      workerGeneration: 4, workspace: identity, groupRevision: 3, originalState: 'needs_user' as const, authorized: true,
    };
    expect((await store.beginControlReplyDispatch(permit, 'answer-a', proof)).status).toBe('acquired');
    expect((await store.beginControlReplyDispatch(permit, 'answer-a', proof)).status).toBe('observing');
    expect((await store.beginControlReplyDispatch(permit, 'answer-b', proof)).status).toBe('rejected');
    expect((await store.acknowledgeControlReply(permit, 'answer-a')).status).toBe('delivered');
    expect((await new TurnPermitStore(dataDir, { now: () => 101 }).beginControlReplyDispatch(permit, 'answer-a', proof)).status).toBe('delivered');
  });

  it('reissues a synchronously refused control reply exactly once and accepts a late ACK after restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'turn-permit-'));
    const store = new TurnPermitStore(dataDir, { now: () => 100 });
    const permit = await store.issueControlReply({ sessionId: 's1', originalTurnId: 'original', wait: { kind: 'ask', askId: 'ask-1' }, expectedGeneration: 4, workspace: identity, expiresAt: 200 });
    const proof = { sessionId: 's1', originalTurnId: 'original', wait: { kind: 'ask' as const, askId: 'ask-1' }, workerGeneration: 4, workspace: identity, originalState: 'needs_user' as const, authorized: true };
    expect((await store.beginControlReplyDispatch(permit, 'answer', proof)).status).toBe('acquired');
    expect((await store.abortControlReplyDispatch(permit, 'answer')).status).toBe('retry');
    expect((await store.beginControlReplyDispatch(permit, 'answer', proof)).status).toBe('acquired');
    expect((await store.abortControlReplyDispatch(permit, 'answer')).status).toBe('ambiguous');
    const restarted = new TurnPermitStore(dataDir, { now: () => 101 });
    expect((await restarted.acknowledgeControlReplyByDispatch({
      controlDispatchId: permit.controlDispatchId, replyDigest: 'wrong', workerGeneration: 4,
    })).status).toBe('rejected');
    expect((await restarted.acknowledgeControlReplyByDispatch({
      controlDispatchId: permit.controlDispatchId, replyDigest: 'answer', workerGeneration: 5,
    })).status).toBe('rejected');
    expect((await restarted.acknowledgeControlReplyByDispatch({
      controlDispatchId: permit.controlDispatchId, replyDigest: 'answer', workerGeneration: 4,
    })).status).toBe('delivered');
  });
  it('persists ambiguous control reconciliation after retry is exhausted', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'turn-permit-'));
    const store = new TurnPermitStore(dataDir, { now: () => 100 });
    const permit = await store.issueControlReply({ sessionId: 's1', originalTurnId: 'original', wait: { kind: 'ask', askId: 'ask-1' }, expectedGeneration: 4, workspace: identity, expiresAt: 200 });
    const proof = { sessionId: 's1', originalTurnId: 'original', wait: { kind: 'ask' as const, askId: 'ask-1' }, workerGeneration: 4, workspace: identity, originalState: 'needs_user' as const, authorized: true };
    await store.beginControlReplyDispatch(permit, 'answer', proof);
    await store.abortControlReplyDispatch(permit, 'answer');
    await store.beginControlReplyDispatch(permit, 'answer', proof);
    expect((await store.reconcileControlReplyDispatch(permit, 'answer', { acknowledged: false, safeToRetry: false })).status).toBe('ambiguous');
    expect((await new TurnPermitStore(dataDir, { now: () => 101 }).beginControlReplyDispatch(permit, 'answer', proof)).status).toBe('rejected');
  });

  it('requires typed permits at attempting and control-resume callees', async () => {
    const store = new TurnPermitStore(mkdtempSync(join(tmpdir(), 'turn-permit-')), { now: () => 100 });
    const blank = await store.issueBlank({ ...base, reservedGeneration: 4 });
    await store.beginSpawn(blank);
    const business = await store.proveReady(blank, { actualGeneration: 4, cwd: identity, backend: identity });
    if (business.status !== 'issued') throw new Error('expected business permit');
    const trace: string[] = [];
    expect(await markBusinessAttempting(business.permit, async () => { trace.push('attempting'); return true; })).toBe(true);
    const control = await store.issueControlReply({ sessionId: 's1', originalTurnId: 'original', wait: { kind: 'approval', approvalId: 'approval-1' }, expectedGeneration: 4, workspace: identity, groupRevision: 3, expiresAt: 200 });
    expect(await resumeOriginalTurnReply(control, async () => { trace.push('resume'); return true; })).toBe(true);
    expect(trace).toEqual(['attempting', 'resume']);
  });
});
