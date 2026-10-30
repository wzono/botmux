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
      forkBlank: async permit => (trace.push(`fork:${permit.turnId}`), true),
      awaitBlankReady: async () => (trace.push('ready+prompt_ready'), { actualGeneration: 4, cwd: workspace, backend: workspace }),
      proveBlankReady: async () => (trace.push('business-permit'), business),
      submit: async () => (trace.push('submit'), true),
    } });
    expect(accepted).toBe(true);
    expect(trace).toEqual(['reserve', 'blank-permit', 'fork:t', 'ready+prompt_ready', 'business-permit', 'submit']);
  });

  it('authorizes control reply before consuming and resumes only the original turn', async () => {
    const trace: string[] = [];
    const result = await resumeAdmittedControlReply({
      authorizeFresh: async () => (trace.push('auth'), true),
      issuePermit: async () => (trace.push('permit'), ({ permitId: 'c', sessionId: 's', originalTurnId: 'original', wait: { kind: 'ask', askId: 'a' }, expectedGeneration: 4, workspace, expiresAt: Date.now() + 1000 } as never)),
      consume: async () => (trace.push('consume'), 'consumed'),
      resume: async permit => (trace.push(`resume:${permit.originalTurnId}`), true),
    });
    expect(result).toBe(true);
    expect(trace).toEqual(['auth', 'permit', 'consume', 'resume:original']);
  });

  it('never consumes a control permit when fresh authorization fails', async () => {
    const consume = vi.fn();
    expect(await resumeAdmittedControlReply({
      authorizeFresh: async () => false,
      issuePermit: async () => undefined,
      consume,
      resume: async () => true,
    })).toBeUndefined();
    expect(consume).not.toHaveBeenCalled();
  });
});
