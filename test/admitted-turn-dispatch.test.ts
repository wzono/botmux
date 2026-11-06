import { describe, expect, it, vi } from 'vitest';
import { dispatchAdmittedBusinessTurn, resumeAdmittedControlReply, type BusinessSubmitPermit } from '../src/core/turn-admission.js';

const workspace = { path: '/repo', dev: '1', ino: '2' };
const business = { permitId: 'business', bootstrapPermitId: 'blank', sessionId: 's', turnId: 't', workerGeneration: 4, workspace, groupRevision: 3, expiresAt: Date.now() + 60_000 } as BusinessSubmitPermit;

describe('central admitted turn dispatch', () => {
  it('proves an existing worker before permit, lease, attempting and submit', async () => {
    const trace: string[] = [];
    const accepted = await dispatchAdmittedBusinessTurn({ sessionId: 's', turnId: 't', dependencies: {
      hasLiveWorker: () => true,
      freezeWorkspace: async () => (trace.push('freeze'), { workspace, groupRevision: 3 }),
      currentWorkerGeneration: () => 4,
      proveExistingWorkerReady: async () => (trace.push('ready'), true),
      issueExistingBusiness: async () => (trace.push('permit'), business),
      reserveWorkerGeneration: () => { throw new Error('cold only'); },
      issueBlank: async () => { throw new Error('cold only'); },
      forkBlank: async () => { throw new Error('cold only'); },
      awaitBlankReady: async () => { throw new Error('cold only'); },
      proveBlankReady: async () => { throw new Error('cold only'); },
      acquireResource: async () => (trace.push('lease'), true),
      markAttempting: async () => (trace.push('attempting'), true),
      submit: async () => (trace.push('submit'), true),
    } });
    expect(accepted).toBe(true);
    expect(trace).toEqual(['freeze', 'ready', 'permit', 'lease', 'attempting', 'submit']);
  });

  it('passes the frozen identity into existing-worker proof', async () => {
    const prove = vi.fn(async () => true);
    await dispatchAdmittedBusinessTurn({ sessionId: 's', turnId: 't', dependencies: {
      hasLiveWorker: () => true,
      freezeWorkspace: async () => ({ workspace, groupRevision: 3 }),
      currentWorkerGeneration: () => 4,
      proveExistingWorkerReady: prove,
      issueExistingBusiness: async () => business,
      reserveWorkerGeneration: () => 5,
      issueBlank: async () => { throw new Error('cold only'); },
      forkBlank: async () => 'rejected',
      awaitBlankReady: async () => undefined,
      proveBlankReady: async () => undefined,
      submit: async () => true,
    } });
    expect(prove).toHaveBeenCalledWith(4, workspace);
  });

  it('cold starts with an empty fork and waits for exact proof before business submission', async () => {
    const trace: string[] = [];
    const accepted = await dispatchAdmittedBusinessTurn({ sessionId: 's', turnId: 't', dependencies: {
      hasLiveWorker: () => false,
      freezeWorkspace: async () => ({ workspace, groupRevision: 3 }),
      currentWorkerGeneration: () => undefined,
      proveExistingWorkerReady: async () => false,
      issueExistingBusiness: async () => undefined,
      reserveWorkerGeneration: () => (trace.push('reserve'), 4),
      issueBlank: async input => (trace.push('blank-permit'), { ...input, permitId: 'blank' } as never),
      forkBlank: async permit => (trace.push(`fork:${permit.turnId}`), 'started'),
      awaitBlankReady: async () => (trace.push('ready+prompt_ready'), { actualGeneration: 4, cwd: workspace, backend: workspace }),
      proveBlankReady: async () => (trace.push('business-permit'), business),
      submit: async () => (trace.push('submit'), true),
    } });
    expect(accepted).toBe(true);
    expect(trace).toEqual(['reserve', 'blank-permit', 'fork:t', 'ready+prompt_ready', 'business-permit', 'submit']);
  });

  it.each([
    ['fork rejection', 'pre_fork'],
    ['readiness timeout', 'forked_unproven'],
    ['proof rejection', 'forked_unproven'],
  ] as const)('aborts a cold permit after %s with the exact lifecycle phase', async (kind, phase) => {
    const abort = vi.fn(async () => {});
    const accepted = await dispatchAdmittedBusinessTurn({ sessionId: 's', turnId: 't', dependencies: {
      hasLiveWorker: () => false,
      freezeWorkspace: async () => ({ workspace }),
      currentWorkerGeneration: () => undefined,
      proveExistingWorkerReady: async () => false,
      issueExistingBusiness: async () => undefined,
      reserveWorkerGeneration: () => 4,
      issueBlank: async input => ({ ...input, permitId: 'blank' } as never),
      forkBlank: async () => kind !== 'fork rejection' ? 'started' : 'rejected',
      awaitBlankReady: async () => kind === 'readiness timeout'
        ? undefined : { actualGeneration: 4, cwd: workspace, backend: workspace },
      proveBlankReady: async () => kind === 'proof rejection' ? undefined : business,
      abortBlank: abort,
      submit: async () => true,
    } });
    expect(accepted).toBe(false);
    expect(abort).toHaveBeenCalledWith(expect.objectContaining({ permitId: 'blank' }), phase);
  });

  it('authorizes control reply, durably dispatches, then ACKs only after worker acceptance', async () => {
    const trace: string[] = [];
    const result = await resumeAdmittedControlReply({
      authorizeFresh: async () => (trace.push('auth'), true),
      issuePermit: async () => (trace.push('permit'), ({ permitId: 'c', sessionId: 's', originalTurnId: 'original', wait: { kind: 'ask', askId: 'a' }, expectedGeneration: 4, workspace, expiresAt: Date.now() + 1000 } as never)),
      beginDispatch: async () => (trace.push('dispatching'), 'acquired'),
      resume: async permit => (trace.push(`resume:${permit.originalTurnId}`), true),
      abort: async () => { trace.push('abort'); },
    });
    expect(result).toBe(true);
    expect(trace).toEqual(['auth', 'permit', 'dispatching', 'resume:original']);
  });

  it('returns idempotent success for an already-delivered control permit without resending', async () => {
    const resume = vi.fn(async () => true);
    expect(await resumeAdmittedControlReply({
      authorizeFresh: async () => true,
      issuePermit: async () => ({ permitId: 'c', sessionId: 's', originalTurnId: 'original', wait: { kind: 'ask', askId: 'a' }, expectedGeneration: 4, workspace, expiresAt: Date.now() + 1000 } as never),
      beginDispatch: async () => 'delivered',
      resume,
      abort: async () => {},
    })).toEqual({ status: 'already_delivered' });
    expect(resume).not.toHaveBeenCalled();
  });

  it('never dispatches a control permit when fresh authorization fails', async () => {
    const beginDispatch = vi.fn();
    expect(await resumeAdmittedControlReply({
      authorizeFresh: async () => false,
      issuePermit: async () => undefined,
      beginDispatch,
      resume: async () => true,
      abort: async () => {},
    })).toBeUndefined();
    expect(beginDispatch).not.toHaveBeenCalled();
  });

  it('aborts a synchronously refused control submission so one retry remains', async () => {
    const trace: string[] = [];
    expect(await resumeAdmittedControlReply({
      authorizeFresh: async () => true,
      issuePermit: async () => ({ permitId: 'c', sessionId: 's', originalTurnId: 'original', wait: { kind: 'ask', askId: 'a' }, expectedGeneration: 4, workspace, expiresAt: Date.now() + 1000 } as never),
      beginDispatch: async () => 'acquired',
      resume: async () => false,
      abort: async () => { trace.push('abort'); },
    })).toBe(false);
    expect(trace).toEqual(['abort']);
  });

  it.each(['false', 'throw'] as const)('rearms a business permit when IPC submission returns %s', async outcome => {
    const abort = vi.fn(async () => {});
    const accepted = await dispatchAdmittedBusinessTurn({ sessionId: 's', turnId: 't', dependencies: {
      hasLiveWorker: () => true,
      freezeWorkspace: async () => ({ workspace, groupRevision: 3 }),
      currentWorkerGeneration: () => 4,
      proveExistingWorkerReady: async () => true,
      issueExistingBusiness: async () => business,
      reserveWorkerGeneration: () => 5,
      issueBlank: async () => { throw new Error('cold only'); },
      forkBlank: async () => 'rejected',
      awaitBlankReady: async () => undefined,
      proveBlankReady: async () => undefined,
      submit: async () => {
        if (outcome === 'throw') throw new Error('ipc closed');
        return false;
      },
      abortBusiness: abort,
    } });
    expect(accepted).toBe(false);
    expect(abort).toHaveBeenCalledWith(business, outcome === 'throw' ? 'threw' : 'refused');
  });

  it('waits through an accepted deferred fork and submits exactly once after exact readiness', async () => {
    const business = { permitId: 'business', bootstrapPermitId: 'blank', sessionId: 's', turnId: 't',
      workerGeneration: 4, workspace, expiresAt: Date.now() + 60_000 } as never;
    const submit = vi.fn(async () => true);
    const accepted = await dispatchAdmittedBusinessTurn({ sessionId: 's', turnId: 't', dependencies: {
      hasLiveWorker: () => false,
      freezeWorkspace: async () => ({ workspace }),
      currentWorkerGeneration: () => undefined,
      proveExistingWorkerReady: async () => false,
      issueExistingBusiness: async () => undefined,
      reserveWorkerGeneration: () => 4,
      issueBlank: async input => ({ ...input, permitId: 'blank' } as never),
      forkBlank: async () => 'deferred',
      awaitBlankReady: async () => ({ actualGeneration: 4, cwd: workspace, backend: workspace }),
      proveBlankReady: async () => business,
      submit,
    } });
    expect(accepted).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('aborts a blank permit when cold-start readiness throws', async () => {
    const abort = vi.fn(async () => {});
    await expect(dispatchAdmittedBusinessTurn({ sessionId: 's', turnId: 't', dependencies: {
      hasLiveWorker: () => false,
      freezeWorkspace: async () => ({ workspace }),
      currentWorkerGeneration: () => undefined,
      proveExistingWorkerReady: async () => false,
      issueExistingBusiness: async () => undefined,
      reserveWorkerGeneration: () => 4,
      issueBlank: async input => ({ ...input, permitId: 'blank' } as never),
      forkBlank: async () => 'started',
      awaitBlankReady: async () => { throw new Error('ready probe failed'); },
      proveBlankReady: async () => undefined,
      abortBlank: abort,
      submit: async () => true,
    } })).rejects.toThrow('ready probe failed');
    expect(abort).toHaveBeenCalledWith(expect.objectContaining({ permitId: 'blank' }), 'forked_unproven');
  });
});
