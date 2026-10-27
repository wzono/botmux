import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTurnFeedbackReconciler, type TurnFeedbackTarget } from '../src/services/turn-feedback-reconciler.js';
import * as sessionStore from '../src/services/session-store.js';
import type { Session } from '../src/types.js';

const APP = 'feedback_reconciler_app';
const NOW = Date.parse('2026-10-27T08:00:00.000Z');

function createTarget(sessionPatch: Partial<Session> = {}): TurnFeedbackTarget {
  const session = sessionStore.createSession('oc_feedback', 'om_root', 'feedback fixture', 'group', 'thread');
  Object.assign(session, sessionPatch);
  sessionStore.updateSession(session);
  return { session, larkAppId: APP };
}

function createHarness() {
  const commit = vi.fn((target: TurnFeedbackTarget, mutate: (fresh: Session) => void) => {
    const { rows } = sessionStore.mutateOwnedSessionsAtomically(
      [target.session.sessionId],
      fresh => mutate(fresh.get(target.session.sessionId)!),
    );
    return rows.get(target.session.sessionId)!;
  });
  return { commit, reconciler: createTurnFeedbackReconciler({ commit, now: () => NOW }) };
}

describe('turn feedback admission', () => {
  beforeEach(() => {
    process.env.SESSION_DATA_DIR = mkdtempSync(join(tmpdir(), 'botmux-turn-feedback-'));
    sessionStore.init(APP);
  });

  it.each([
    ['human', false],
    ['bot', true],
    ['unknown', undefined],
  ] as const)('persists the exact %s requester snapshot', (_label, requesterIsBot) => {
    const target = createTarget({
      replyTargets: {
        'turn-1': {
          updatedAt: new Date(NOW).toISOString(),
          senderOpenId: 'ou_requester',
          participants: [{ openId: 'ou_requester', isBot: requesterIsBot }],
        },
      },
    });
    const { reconciler } = createHarness();

    const committed = reconciler.admit(target, { turnId: 'turn-1', messageId: 'comment_123' });

    const row = sessionStore.getSessionFresh(target.session.sessionId)?.turnFeedback?.['turn-1'];
    expect(committed).toBe(target.session);
    expect(row).toMatchObject({
      version: 1,
      turnId: 'turn-1',
      messageId: 'comment_123',
      requesterOpenId: 'ou_requester',
      phase: 'processing',
      updatedAt: new Date(NOW).toISOString(),
    });
    if (requesterIsBot === undefined) {
      expect(row).not.toHaveProperty('requesterIsBot');
    } else {
      expect(row?.requesterIsBot).toBe(requesterIsBot);
    }
  });

  it('keeps an existing terminal/capacity/attention row unchanged on duplicate admission', () => {
    const existing = {
      version: 1 as const,
      turnId: 'turn-terminal',
      messageId: 'om_terminal',
      requesterOpenId: 'ou_original',
      requesterIsBot: false,
      phase: 'completed' as const,
      updatedAt: '2026-10-27T07:00:00.000Z',
      receivedReactionEmoji: 'Get',
      capacity: { state: 'waiting' as const, position: 4, startedAtMs: NOW - 5_000, updatedAtMs: NOW - 1_000, source: 'pty' as const },
      attention: { state: 'needs_user' as const, promptNonce: 'nonce-1', dispatchAttempt: 2, workerGeneration: 3, openedAtMs: NOW - 2_000 },
    };
    const target = createTarget({ turnFeedback: { 'turn-terminal': existing } });
    const { reconciler } = createHarness();

    reconciler.admit(target, { turnId: 'turn-terminal', messageId: 'om_terminal' });

    expect(sessionStore.getSessionFresh(target.session.sessionId)?.turnFeedback?.['turn-terminal']).toEqual(existing);
  });

  it('retains a substitute emoji when a duplicate admission omits it', () => {
    const target = createTarget();
    const { reconciler } = createHarness();

    reconciler.admit(target, { turnId: 'turn-sub', messageId: 'om_sub', receivedReactionEmoji: 'Get' });
    const admitted = structuredClone(sessionStore.getSessionFresh(target.session.sessionId)?.turnFeedback?.['turn-sub']);
    reconciler.admit(target, { turnId: 'turn-sub', messageId: 'om_sub' });

    expect(sessionStore.getSessionFresh(target.session.sessionId)?.turnFeedback?.['turn-sub']).toEqual(admitted);
    expect(admitted?.receivedReactionEmoji).toBe('Get');
  });

  it('restore is inert for legacy missing maps and retains existing rows without pruning', () => {
    const legacy = createTarget();
    const existing = createTarget({
      turnFeedback: {
        old: { version: 1, turnId: 'old', phase: 'failed', updatedAt: '2025-01-01T00:00:00.000Z' },
      },
    });
    const { commit, reconciler } = createHarness();

    reconciler.restore([legacy, existing]);

    expect(commit).not.toHaveBeenCalled();
    expect(legacy.session.turnFeedback).toBeUndefined();
    expect(existing.session.turnFeedback).toEqual({
      old: { version: 1, turnId: 'old', phase: 'failed', updatedAt: '2025-01-01T00:00:00.000Z' },
    });
    expect(reconciler).toEqual(expect.objectContaining({
      observeCapacity: expect.any(Function),
      observeAttention: expect.any(Function),
      terminal: expect.any(Function),
      disableCapacity: expect.any(Function),
    }));
  });
});
