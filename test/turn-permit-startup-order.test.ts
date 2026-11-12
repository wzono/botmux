import { describe, expect, it, vi } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import { reconcileTurnPermitDispatches } from '../src/core/worker-pool.js';
import { StartupAdmissionBarrier } from '../src/core/startup-admission.js';

function restoredSession(): DaemonSession {
  return {
    session: {
      sessionId: 'restored', workerGeneration: 4,
      dispatchInputReceipts: { turn: { workerGeneration: 4, receivedAt: '2026-10-30T00:00:00.000Z' } },
      controlDispatchReceipts: { control: { replyDigest: 'answer', workerGeneration: 4, committedAt: '2026-10-30T00:00:00.000Z' } },
    },
    worker: { killed: false } as never,
    workerGeneration: 4,
  } as DaemonSession;
}

describe('startup turn permit reconciliation harness', () => {
  it('tracks readiness per exact bot and keeps reconciliation failures closed', () => {
    const barrier = new StartupAdmissionBarrier(['bot-A', 'bot-B']);
    expect(barrier.isReady('bot-A')).toBe(false);
    expect(barrier.isReady('bot-B')).toBe(false);
    barrier.markReady('bot-A');
    expect(barrier.isReady('bot-A')).toBe(true);
    expect(barrier.isReady('bot-B')).toBe(false);
    barrier.markFailed('bot-B', new Error('permit store unavailable'));
    expect(barrier.isReady('bot-B')).toBe(false);
    expect(barrier.failure('bot-B')?.message).toBe('permit store unavailable');
  });

  it('does not wait for bots that are not in the active daemon set', () => {
    const barrier = new StartupAdmissionBarrier(['bot-A']);
    barrier.markReady('bot-A');
    expect(barrier.allReady()).toBe(true);
    expect(barrier.isReady('disabled-bot')).toBe(false);
  });

  it('observes restored session generation and ACK before ingress opens', async () => {
    const trace: string[] = [];
    const session = restoredSession();
    const reconcile = vi.fn(async (_permit, evidence) => { trace.push('reconcile'); expect(evidence).toEqual({
      ack: { sessionId: 'restored', turnId: 'turn', workerGeneration: 4 }, safeToRetry: false,
    }); });
    const store = {
      listDispatching: async () => [{ permit: {
        permitId: 'business', bootstrapPermitId: 'blank', sessionId: 'restored', turnId: 'turn',
        workerGeneration: 4, workspace: { path: '/repo', dev: '1', ino: '2' }, expiresAt: Date.now() + 1000,
      } as never, payloadDigest: 'digest', retryUsed: false }],
      reconcileBusinessDispatch: reconcile,
      listDispatchingControls: async () => [],
      reconcileControlReplyDispatch: async () => ({ status: 'rejected' as const }),
    };
    trace.push('restore');
    await reconcileTurnPermitDispatches([session], store);
    trace.push('ingress');
    expect(trace).toEqual(['restore', 'reconcile', 'ingress']);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('marks a live same-generation control dispatch without exact ACK ambiguous', async () => {
    const session = restoredSession();
    session.session.controlDispatchReceipts = undefined;
    const reconcileControl = vi.fn(async (_permit, _digest, evidence) => {
      expect(evidence.acknowledged).toBe(false);
      return { status: 'ambiguous' as const };
    });
    await reconcileTurnPermitDispatches([session], {
      listDispatching: async () => [], reconcileBusinessDispatch: async () => ({ status: 'rejected' as const }),
      listDispatchingControls: async () => [{ permit: {
        permitId: 'control', controlDispatchId: 'control', sessionId: 'restored', originalTurnId: 'turn', wait: { kind: 'ask', askId: 'ask' },
        expectedGeneration: 4, workspace: { path: '/repo', dev: '1', ino: '2' }, expiresAt: Date.now() + 1000,
      } as never, replyDigest: 'answer', retryUsed: false }],
      reconcileControlReplyDispatch: reconcileControl,
    });
    expect(reconcileControl).toHaveBeenCalledWith(expect.anything(), 'answer', {
      acknowledged: false, safeToRetry: false,
    });
  });

  it('reconciles a dispatch whose restored session is missing as ambiguous', async () => {
    const reconcile = vi.fn(async (_permit, evidence) => {
      expect(evidence).toEqual({ safeToRetry: false });
      return { status: 'ambiguous' as const };
    });
    await reconcileTurnPermitDispatches([], {
      listDispatching: async () => [{ permit: {
        permitId: 'business', bootstrapPermitId: 'blank', sessionId: 'missing', turnId: 'turn',
        workerGeneration: 4, workspace: { path: '/repo', dev: '1', ino: '2' }, expiresAt: Date.now() + 1000,
      } as never, payloadDigest: 'digest', retryUsed: false }],
      reconcileBusinessDispatch: reconcile,
      listDispatchingControls: async () => [],
      reconcileControlReplyDispatch: async () => ({ status: 'rejected' as const }),
    });
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('reconciles a crash-window control dispatch from the restored worker ACK', async () => {
    const session = restoredSession();
    const reconcileControl = vi.fn(async (_permit, _digest, evidence) => {
      expect(evidence).toEqual({ acknowledged: true, safeToRetry: false });
      return { status: 'delivered' as const };
    });
    await reconcileTurnPermitDispatches([session], {
      listDispatching: async () => [], reconcileBusinessDispatch: async () => ({ status: 'rejected' as const }),
      listDispatchingControls: async () => [{ permit: {
        permitId: 'control', controlDispatchId: 'control', sessionId: 'restored', originalTurnId: 'turn', wait: { kind: 'ask', askId: 'ask' },
        expectedGeneration: 4, workspace: { path: '/repo', dev: '1', ino: '2' }, expiresAt: Date.now() + 1000,
      } as never, replyDigest: 'answer', retryUsed: false }],
      reconcileControlReplyDispatch: reconcileControl,
    });
    expect(reconcileControl).toHaveBeenCalledTimes(1);
  });
});
