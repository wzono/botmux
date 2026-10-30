import { describe, expect, it, vi } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import { reconcileTurnPermitDispatches } from '../src/core/worker-pool.js';

function restoredSession(): DaemonSession {
  return {
    session: {
      sessionId: 'restored', workerGeneration: 4,
      dispatchInputReceipts: { turn: { workerGeneration: 4, receivedAt: '2026-10-30T00:00:00.000Z' } },
    },
    worker: { killed: false } as never,
    workerGeneration: 4,
  } as DaemonSession;
}

describe('startup turn permit reconciliation harness', () => {
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

  it('reconciles a crash-window control dispatch from the restored worker ACK', async () => {
    const session = restoredSession();
    const reconcileControl = vi.fn(async (_permit, _digest, evidence) => {
      expect(evidence).toEqual({ acknowledged: true, safeToRetry: false });
      return { status: 'delivered' as const };
    });
    await reconcileTurnPermitDispatches([session], {
      listDispatching: async () => [], reconcileBusinessDispatch: async () => ({ status: 'rejected' as const }),
      listDispatchingControls: async () => [{ permit: {
        permitId: 'control', sessionId: 'restored', originalTurnId: 'turn', wait: { kind: 'ask', askId: 'ask' },
        expectedGeneration: 4, workspace: { path: '/repo', dev: '1', ino: '2' }, expiresAt: Date.now() + 1000,
      } as never, replyDigest: 'answer', retryUsed: false }],
      reconcileControlReplyDispatch: reconcileControl,
    });
    expect(reconcileControl).toHaveBeenCalledTimes(1);
  });
});
