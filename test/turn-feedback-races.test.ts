import { describe, expect, it } from 'vitest';
import { createTurnFeedbackReconciler } from '../src/services/turn-feedback-reconciler.js';
import type { Session } from '../src/types.js';

describe('persisted terminal reaction convergence', () => {
  it('probes a permanent diagnostic once per process', async () => {
    const now = Date.parse('2026-10-28T12:00:00Z');
    const session = { sessionId: 'permanent', status: 'active', turnFeedback: { turn: {
      version: 1, turnId: 'turn', messageId: 'om_r1', phase: 'completed',
      updatedAt: new Date(now).toISOString(), reactionIntent: {
        id: 'intent', messageId: 'om_r1', desiredType: 'DONE',
        createdAt: new Date(now).toISOString(), stage: 'permanent',
        diagnostic: 'unsupported_message', deleteIds: [],
      },
    } } } as Session;
    let probes = 0;
    const runtime = createTurnFeedbackReconciler({
      now: () => now, read: () => session,
      commit: (_target, mutate) => { mutate(session); return session; },
      listOwnReactions: async () => {
        probes++;
        if (probes > 3) throw new Error('repeated permanent LIST');
        return { kind: 'permanent', reason: 'unsupported_message' };
      },
    });

    await runtime.restore([{ session, larkAppId: 'cli_r1' }]);

    expect(probes).toBe(1);
    runtime.dispose();
  });

  it('retires settled capacity metadata so old terminal rows can be pruned', async () => {
    const now = Date.parse('2026-10-28T12:00:00Z');
    const session = { sessionId: 'settled-capacity', status: 'active', turnFeedback: { turn: {
      version: 1, turnId: 'turn', messageId: 'om_r1', phase: 'capacity_waiting',
      updatedAt: new Date(now - 10).toISOString(), capacity: {
        state: 'waiting', source: 'pty', startedAtMs: now - 100, updatedAtMs: now - 10,
      }, capacityBinding: {
        adapter: 'codex', nativeTurnId: 'native', dispatchAttempt: 1, workerGeneration: 1,
      }, capacitySidebandCursor: {
        adapter: 'codex', signerKeyId: 'key', signerEpoch: 1, requestId: 'request', sequence: 1, observedAtMs: now - 10,
      },
    } } } as Session;
    const target = { session, larkAppId: 'cli_r1' };
    const runtime = createTurnFeedbackReconciler({
      now: () => now, read: () => session,
      commit: (_target, mutate) => { mutate(session); return session; },
      listOwnReactions: async () => ({ kind: 'listed', reactions: [] }),
      createReactionOnce: async (_app, _message, type) => ({ kind: 'created', reaction: { id: `rid-${type}`, type } }),
    });

    expect(runtime.terminal(target, 'turn', 'completed')).toBe(true);
    await runtime.reconcile(target, 'turn');

    expect(session.turnFeedback!.turn).not.toHaveProperty('capacity');
    expect(session.turnFeedback!.turn).not.toHaveProperty('capacityBinding');
    expect(session.turnFeedback!.turn).not.toHaveProperty('capacitySidebandCursor');
    runtime.dispose();
  });

  it('retires solved attention metadata at terminal settlement', async () => {
    const now = Date.parse('2026-10-28T12:00:00Z');
    const session = { sessionId: 'settled-attention', status: 'active', turnFeedback: { turn: {
      version: 1, turnId: 'turn', messageId: 'om_r1', phase: 'needs_user',
      updatedAt: new Date(now - 10).toISOString(), attention: {
        state: 'needs_user', promptNonce: 'nonce', dispatchAttempt: 1, workerGeneration: 1, openedAtMs: now - 10,
      },
    } } } as Session;
    const target = { session, larkAppId: 'cli_r1' };
    const runtime = createTurnFeedbackReconciler({
      now: () => now, read: () => session,
      commit: (_target, mutate) => { mutate(session); return session; },
      listOwnReactions: async () => ({ kind: 'listed', reactions: [] }),
      createReactionOnce: async (_app, _message, type) => ({ kind: 'created', reaction: { id: `rid-${type}`, type } }),
    });

    expect(runtime.terminal(target, 'turn', 'completed')).toBe(true);
    await runtime.reconcile(target, 'turn');

    expect(session.turnFeedback!.turn).not.toHaveProperty('attention');
    runtime.dispose();
  });

  it('converges terminal after an earlier CREATE receipt arrives late', async () => {
    const now = Date.parse('2026-10-28T12:00:00Z');
    const session = { sessionId: 'race', status: 'active', turnFeedback: { turn: {
      version: 1, turnId: 'turn', messageId: 'om_r1',
      phase: 'processing', updatedAt: new Date(now).toISOString(),
    } } } as Session;
    const target = { session, larkAppId: 'cli_r1' };
    let releaseCreate!: () => void;
    let createStarted!: () => void;
    const started = new Promise<void>(resolve => { createStarted = resolve; });
    const paused = new Promise<void>(resolve => { releaseCreate = resolve; });
    const provider: Array<{ id: string; type: string }> = [];
    const runtime = createTurnFeedbackReconciler({
      now: () => now, read: () => session,
      commit: (_target, mutate) => { mutate(session); return session; },
      listOwnReactions: async () => ({ kind: 'listed', reactions: [...provider] }),
      deleteReactionOnce: async (_app, _message, id) => {
        const index = provider.findIndex(item => item.id === id);
        if (index >= 0) provider.splice(index, 1);
        return { kind: 'deleted' };
      },
      createReactionOnce: async (_app, _message, type) => {
        if (type === 'GoGoGo') { createStarted(); await paused; }
        const reaction = { id: `rid-${type}`, type };
        provider.push(reaction);
        return { kind: 'created', reaction };
      },
    });

    const processing = runtime.reconcile(target, 'turn');
    await started;
    expect(runtime.terminal(target, 'turn', 'completed')).toBe(true);
    const terminal = runtime.reconcile(target, 'turn');
    releaseCreate();
    await Promise.all([processing, terminal]);

    expect(session.turnFeedback!.turn.phase).toBe('completed');
    expect(provider.map(item => item.type)).toEqual(['DONE']);
    expect(session.turnFeedback!.turn.reactionIntent).toBeUndefined();
    runtime.dispose();
  });
});
