import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTurnFeedbackReconciler, type TurnFeedbackTarget } from '../src/services/turn-feedback-reconciler.js';
import type { PersistedTurnFeedback, Session } from '../src/types.js';
import type {
  OwnReactionListResult,
  ReactionCreationResult,
  ReactionRemovalResult,
} from '../src/im/lark/client.js';

const lark = vi.hoisted(() => ({
  client: {
    im: { v1: { messageReaction: {
      create: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    } } },
  },
}));

vi.mock('../src/bot-registry.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/bot-registry.js')>();
  return {
    ...actual,
    getBot: () => ({ config: { topicUnavailablePolicy: 'continue' } }),
    getBotClient: () => lark.client,
  };
});

import {
  addReactionOnce,
  listOwnReactions,
  listOwnReactionsDetailed,
  removeReactionDetailed,
} from '../src/im/lark/client.js';

const NOW = Date.parse('2026-10-27T08:00:00.000Z');

function feedback(
  patch: Partial<PersistedTurnFeedback> = {},
): PersistedTurnFeedback {
  return {
    version: 1,
    turnId: 'turn-a',
    messageId: 'om_a',
    phase: 'processing',
    updatedAt: new Date(NOW).toISOString(),
    ...patch,
  };
}

function harness(initial?: PersistedTurnFeedback) {
  const session = {
    sessionId: 'session-a',
    status: 'active',
    ...(initial ? { turnFeedback: { 'turn-a': structuredClone(initial) } } : {}),
  } as Session;
  const target: TurnFeedbackTarget = { session, larkAppId: 'app-a' };
  const own: Array<{ id: string; type: string }> = [];
  const effects: string[] = [];
  const commit = vi.fn((_: TurnFeedbackTarget, mutate: (fresh: Session) => void) => {
    mutate(session);
    return session;
  });
  const listOwnReactionsDetailed = vi.fn(async (): Promise<OwnReactionListResult> => ({
    status: 'ok', items: structuredClone(own),
  }));
  const addReactionOnce = vi.fn(async (_app: string, _message: string, type: string): Promise<ReactionCreationResult> => {
    effects.push('create');
    expect(session.turnFeedback?.['turn-a'].reactionOperation?.phase).toBe('add_pending');
    own.push({ id: 'rid_created', type });
    return { status: 'created', id: 'rid_created' };
  });
  const removeReactionDetailed = vi.fn(async (_app: string, _message: string, id: string): Promise<ReactionRemovalResult> => {
    effects.push(`delete:${id}`);
    const index = own.findIndex(item => item.id === id);
    if (index >= 0) own.splice(index, 1);
    return 'deleted';
  });
  const create = () => createTurnFeedbackReconciler({
    commit,
    read: () => session,
    now: () => NOW,
    policy: () => ({ silent: false, processing: 'GoGoGo', completed: 'DONE', failed: 'ERROR' }),
    addReactionOnce,
    removeReactionDetailed,
    listOwnReactionsDetailed,
  });
  return { session, target, own, effects, commit, create, addReactionOnce, removeReactionDetailed, listOwnReactionsDetailed };
}

describe('crash-recoverable reaction convergence', () => {
  beforeEach(() => vi.useRealTimers());

  it('journals add intent before CREATE and converges processing to terminal', async () => {
    const h = harness();
    const reconciler = h.create();

    reconciler.admit(h.target, { turnId: 'turn-a', messageId: 'om_a' });
    await reconciler.reconcile(h.target, 'turn-a');
    expect(h.session.turnFeedback?.['turn-a'].reaction).toEqual({ id: 'rid_created', type: 'GoGoGo' });

    await reconciler.terminal(h.target, 'turn-a', 'completed', NOW + 1);

    expect(h.effects).toEqual(['create', 'delete:rid_created', 'create']);
    expect(h.session.turnFeedback?.['turn-a']).toMatchObject({
      phase: 'completed', reaction: { id: 'rid_created', type: 'DONE' },
    });
    expect(h.session.turnFeedback?.['turn-a'].reactionOperation).toBeUndefined();
    expect(h.session.turnFeedback?.['turn-a'].reactionReconcilePending).toBeUndefined();
  });

  it('adopts a provider ACK after persistence failure without another CREATE', async () => {
    const h = harness(feedback({
      reactionReconcilePending: true,
      reactionOperation: {
        opId: 'op-add', messageId: 'om_a', desiredType: 'GoGoGo',
        createdAt: new Date(NOW).toISOString(), phase: 'add_pending',
      },
    }));
    h.own.push({ id: 'provider-ack', type: 'GoGoGo' });

    await h.create().restore([h.target]);

    expect(h.addReactionOnce).not.toHaveBeenCalled();
    expect(h.session.turnFeedback?.['turn-a'].reaction).toEqual({ id: 'provider-ack', type: 'GoGoGo' });
    expect(h.session.turnFeedback?.['turn-a'].reactionOperation).toBeUndefined();
  });

  it('journals duplicate adoption before delete and resumes cleanup after a crash', async () => {
    const h = harness(feedback({
      reactionReconcilePending: true,
      reactionOperation: {
        opId: 'op-duplicates', messageId: 'om_a', desiredType: 'GoGoGo',
        createdAt: new Date(NOW).toISOString(), phase: 'add_pending',
      },
    }));
    h.own.push(
      { id: 'z', type: 'GoGoGo' },
      { id: 'a', type: 'GoGoGo' },
      { id: 'm', type: 'GoGoGo' },
    );
    h.removeReactionDetailed.mockImplementationOnce(async (_app, _message, id) => {
      expect(h.session.turnFeedback?.['turn-a']).toMatchObject({
        reaction: { id: 'a', type: 'GoGoGo' },
        reactionOperation: { phase: 'cleanup_pending', duplicateIds: ['m', 'z'] },
      });
      h.own.splice(h.own.findIndex(item => item.id === id), 1);
      throw new Error('crash after provider delete');
    });

    await h.create().reconcile(h.target, 'turn-a');
    await h.create().restore([h.target]);

    expect(h.own).toEqual([{ id: 'a', type: 'GoGoGo' }]);
    expect(h.addReactionOnce).not.toHaveBeenCalled();
    expect(h.session.turnFeedback?.['turn-a'].reactionOperation).toBeUndefined();
  });

  it('cleanup recovery recreates when the adopted provider reaction disappeared', async () => {
    const h = harness(feedback({
      reaction: { id: 'adopted', type: 'GoGoGo' },
      reactionReconcilePending: true,
      reactionOperation: {
        opId: 'op-cleanup-missing', messageId: 'om_a', desiredType: 'GoGoGo',
        createdAt: new Date(NOW).toISOString(), phase: 'cleanup_pending',
        adopted: { id: 'adopted', type: 'GoGoGo' }, duplicateIds: [],
      },
    }));

    await h.create().restore([h.target]);

    expect(h.addReactionOnce).toHaveBeenCalledWith('app-a', 'om_a', 'GoGoGo');
    expect(h.session.turnFeedback?.['turn-a'].reaction).toEqual({
      id: 'rid_created', type: 'GoGoGo',
    });
  });

  it('matching stored and provider reaction clears pending without DELETE or CREATE', async () => {
    const h = harness(feedback({
      reaction: { id: 'matching', type: 'GoGoGo' },
      reactionReconcilePending: true,
    }));
    h.own.push({ id: 'matching', type: 'GoGoGo' });

    await h.create().restore([h.target]);

    expect(h.listOwnReactionsDetailed).toHaveBeenCalledTimes(1);
    expect(h.removeReactionDetailed).not.toHaveBeenCalled();
    expect(h.addReactionOnce).not.toHaveBeenCalled();
    expect(h.session.turnFeedback?.['turn-a'].reactionReconcilePending).toBeUndefined();
    expect(h.session.turnFeedback?.['turn-a'].reactionOperation).toBeUndefined();
  });

  it('does not CREATE when own-list is ambiguous', async () => {
    const h = harness(feedback({ reactionReconcilePending: true }));
    h.listOwnReactionsDetailed.mockResolvedValue({ status: 'ambiguous' });

    await h.create().reconcile(h.target, 'turn-a');

    expect(h.addReactionOnce).not.toHaveBeenCalled();
    expect(h.session.turnFeedback?.['turn-a'].reactionOperation?.phase).toBe('add_pending');
  });

  it('message-gone clears the journal and suppresses all future recreation', async () => {
    const h = harness(feedback({
      reactionReconcilePending: true,
      reactionOperation: {
        opId: 'op-gone', messageId: 'om_a', desiredType: 'GoGoGo',
        createdAt: new Date(NOW).toISOString(), phase: 'add_pending',
      },
    }));
    h.listOwnReactionsDetailed.mockResolvedValue({ status: 'gone' });

    await h.create().restore([h.target]);
    await h.create().restore([h.target]);

    expect(h.session.turnFeedback?.['turn-a']).toMatchObject({ reactionMessageGone: true });
    expect(h.session.turnFeedback?.['turn-a'].reactionOperation).toBeUndefined();
    expect(h.addReactionOnce).not.toHaveBeenCalled();
    expect(h.listOwnReactionsDetailed).toHaveBeenCalledTimes(1);
  });

  it('silent desired state removes an owned reaction without replacement', async () => {
    const h = harness(feedback({ reaction: { id: 'old', type: 'GoGoGo' } }));
    h.own.push({ id: 'old', type: 'GoGoGo' });
    const reconciler = createTurnFeedbackReconciler({
      commit: h.commit, read: () => h.session, now: () => NOW,
      policy: () => ({ silent: true, processing: 'GoGoGo', completed: 'DONE', failed: 'ERROR' }),
      addReactionOnce: h.addReactionOnce, removeReactionDetailed: h.removeReactionDetailed,
      listOwnReactionsDetailed: h.listOwnReactionsDetailed,
    });

    await reconciler.reconcile(h.target, 'turn-a');

    expect(h.removeReactionDetailed).toHaveBeenCalledWith('app-a', 'om_a', 'old');
    expect(h.addReactionOnce).not.toHaveBeenCalled();
    expect(h.session.turnFeedback?.['turn-a'].reaction).toBeUndefined();
  });

  it('never calls provider seams for a non-Lark message id', async () => {
    const h = harness(feedback({ messageId: 'comment_123', reactionReconcilePending: true }));

    await h.create().restore([h.target]);

    expect(h.listOwnReactionsDetailed).not.toHaveBeenCalled();
    expect(h.addReactionOnce).not.toHaveBeenCalled();
    expect(h.removeReactionDetailed).not.toHaveBeenCalled();
    expect(h.session.turnFeedback?.['turn-a'].reactionReconcilePending).toBeUndefined();
  });

  it('bounds transient repair at 1s/5s/15s and a later process resumes the durable operation', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(feedback({
        reactionReconcilePending: true,
        reactionOperation: {
          opId: 'op-transient', messageId: 'om_a', desiredType: 'GoGoGo',
          createdAt: new Date(NOW).toISOString(), phase: 'add_pending',
        },
      }));
      h.listOwnReactionsDetailed.mockResolvedValue({ status: 'ambiguous' });
      const first = h.create();

      await first.scheduleReactionRepair(h.target, 'turn-a');
      expect(h.listOwnReactionsDetailed).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000 + 5_000 + 15_000);

      expect(h.listOwnReactionsDetailed).toHaveBeenCalledTimes(4);
      expect(h.addReactionOnce).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(h.session.turnFeedback?.['turn-a']).toMatchObject({
        reactionReconcilePending: true,
        reactionOperation: { opId: 'op-transient', phase: 'add_pending' },
      });

      h.listOwnReactionsDetailed.mockResolvedValue({ status: 'ok', items: [] });
      await h.create().restore([h.target]);
      expect(h.addReactionOnce).toHaveBeenCalledTimes(1);
      expect(h.session.turnFeedback?.['turn-a'].reaction?.type).toBe('GoGoGo');
    } finally {
      vi.useRealTimers();
    }
  });

  it('an old transient timer is fenced by operation identity', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(feedback({
        reactionReconcilePending: true,
        reactionOperation: {
          opId: 'op-old', messageId: 'om_a', desiredType: 'GoGoGo',
          createdAt: new Date(NOW).toISOString(), phase: 'add_pending',
        },
      }));
      h.listOwnReactionsDetailed.mockResolvedValue({ status: 'ambiguous' });
      const reconciler = h.create();
      await reconciler.scheduleReactionRepair(h.target, 'turn-a');
      h.commit(h.target, fresh => {
        fresh.turnFeedback!['turn-a'].reactionOperation = {
          opId: 'op-replacement', messageId: 'om_a', desiredType: 'DONE',
          createdAt: new Date(NOW).toISOString(), phase: 'add_pending',
        };
      });

      await vi.advanceTimersByTimeAsync(1_000);

      expect(h.listOwnReactionsDetailed).toHaveBeenCalledTimes(1);
      expect(h.addReactionOnce).not.toHaveBeenCalled();
      expect(h.session.turnFeedback?.['turn-a'].reactionOperation?.opId).toBe('op-replacement');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('blocked repair runs immediate then 5m/30m/2h, exhausts, and only a new process restarts it', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(feedback({
        reactionReconcilePending: true,
        reactionOperation: {
          opId: 'op-blocked', messageId: 'om_a', desiredType: 'GoGoGo',
          createdAt: new Date(NOW).toISOString(), phase: 'add_pending',
        },
      }));
      h.addReactionOnce.mockResolvedValue({ status: 'blocked', reason: 'permission-denied' });
      const first = h.create();

      await first.reconcile(h.target, 'turn-a');
      expect(h.addReactionOnce).toHaveBeenCalledTimes(1);
      expect(h.listOwnReactionsDetailed).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(300_000 + 1_800_000 + 7_200_000);

      expect(h.addReactionOnce).toHaveBeenCalledTimes(4);
      expect(h.listOwnReactionsDetailed.mock.calls.length)
        .toBeGreaterThanOrEqual(h.addReactionOnce.mock.calls.length);
      expect(h.session.turnFeedback?.['turn-a'].reactionOperation)
        .toMatchObject({ phase: 'blocked', retryExhausted: true });
      expect(vi.getTimerCount()).toBe(0);

      await first.restore([h.target]);
      await first.reconcile(h.target, 'turn-a');
      expect(h.addReactionOnce).toHaveBeenCalledTimes(4);
      expect(vi.getTimerCount()).toBe(0);

      await h.create().restore([h.target]);
      expect(h.addReactionOnce).toHaveBeenCalledTimes(5);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('desired phase change cancels blocked schedule and converges the new intent immediately', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(feedback({
        reactionReconcilePending: true,
        reactionOperation: {
          opId: 'op-blocked-change', messageId: 'om_a', desiredType: 'GoGoGo',
          createdAt: new Date(NOW).toISOString(), phase: 'add_pending',
        },
      }));
      h.addReactionOnce
        .mockResolvedValueOnce({ status: 'blocked', reason: 'permission-denied' })
        .mockImplementation(async (_app, _message, type) => ({ status: 'created', id: `rid_${type}` }));
      const reconciler = h.create();
      await reconciler.reconcile(h.target, 'turn-a');
      h.commit(h.target, fresh => { fresh.turnFeedback!['turn-a'].phase = 'completed'; });

      await reconciler.reconcile(h.target, 'turn-a');

      expect(h.addReactionOnce).toHaveBeenLastCalledWith('app-a', 'om_a', 'DONE');
      expect(h.session.turnFeedback?.['turn-a'].reaction?.type).toBe('DONE');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('desired phase change adopts and removes the old in-flight CREATE ACK before creating the new intent', async () => {
    const h = harness(feedback({
      phase: 'completed',
      reactionReconcilePending: true,
      reactionOperation: {
        opId: 'op-old-create', messageId: 'om_a', desiredType: 'GoGoGo',
        createdAt: new Date(NOW).toISOString(), phase: 'add_pending',
      },
    }));
    h.own.push({ id: 'old-provider-ack', type: 'GoGoGo' });

    await h.create().restore([h.target]);

    expect(h.removeReactionDetailed).toHaveBeenCalledWith('app-a', 'om_a', 'old-provider-ack');
    expect(h.addReactionOnce).toHaveBeenCalledWith('app-a', 'om_a', 'DONE');
    expect(h.own).toEqual([{ id: 'rid_created', type: 'DONE' }]);
    expect(h.session.turnFeedback?.['turn-a'].reaction).toEqual({ id: 'rid_created', type: 'DONE' });
  });

  it('successful blocked recovery releases its timer state', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(feedback({ reactionReconcilePending: true }));
      h.addReactionOnce
        .mockResolvedValueOnce({ status: 'blocked', reason: 'permission-denied' })
        .mockResolvedValueOnce({ status: 'created', id: 'recovered' });
      const reconciler = h.create();
      await reconciler.reconcile(h.target, 'turn-a');
      await vi.advanceTimersByTimeAsync(300_000);

      expect(h.session.turnFeedback?.['turn-a'].reaction).toEqual({ id: 'recovered', type: 'GoGoGo' });
      expect(vi.getTimerCount()).toBe(0);
      expect(reconciler.__testOnly_memoryCounts()).toEqual({
        inFlight: 0, permanentProbes: 0, blockedRepairs: 0, transientRepairs: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose releases all per-process reaction repair memory', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(feedback({ reactionReconcilePending: true }));
      h.addReactionOnce.mockResolvedValue({ status: 'blocked', reason: 'permission-denied' });
      const reconciler = h.create();
      await reconciler.reconcile(h.target, 'turn-a');
      expect(reconciler.__testOnly_memoryCounts()).toMatchObject({ blockedRepairs: 1 });
      expect(vi.getTimerCount()).toBe(1);

      reconciler.dispose(h.target);

      expect(reconciler.__testOnly_memoryCounts()).toEqual({
        inFlight: 0, permanentProbes: 0, blockedRepairs: 0, transientRepairs: 0,
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retention pruning bounds permanent-failure process memory to the durable 128 rows', async () => {
    const h = harness();
    h.addReactionOnce.mockResolvedValue({ status: 'failed', reason: 'invalid-emoji' });
    h.session.turnFeedback = Object.fromEntries(Array.from({ length: 140 }, (_, index) => {
      const turnId = `failed-${index}`;
      return [turnId, {
        ...feedback({
          turnId, messageId: `om_${index}`, phase: 'failed', reactionReconcilePending: true,
        }),
        updatedAt: new Date(NOW - index).toISOString(),
      }];
    }));
    const reconciler = h.create();

    for (let index = 0; index < 140; index += 1) {
      await reconciler.reconcile(h.target, `failed-${index}`);
    }

    expect(Object.keys(h.session.turnFeedback)).toHaveLength(128);
    expect(reconciler.__testOnly_memoryCounts().permanentProbes).toBeLessThanOrEqual(128);
    reconciler.dispose(h.target);
    expect(reconciler.__testOnly_memoryCounts()).toEqual({
      inFlight: 0, permanentProbes: 0, blockedRepairs: 0, transientRepairs: 0,
    });
  });

  it('permanent failure never recreates in-process; a new process probes once and adopts externally', async () => {
    const h = harness(feedback({ reactionReconcilePending: true }));
    h.addReactionOnce.mockResolvedValueOnce({ status: 'failed', reason: 'invalid-emoji' });
    const first = h.create();
    await first.reconcile(h.target, 'turn-a');
    const listCalls = h.listOwnReactionsDetailed.mock.calls.length;

    await first.reconcile(h.target, 'turn-a');
    await first.restore([h.target]);
    expect(h.addReactionOnce).toHaveBeenCalledTimes(1);
    expect(h.listOwnReactionsDetailed).toHaveBeenCalledTimes(listCalls);

    h.own.push({ id: 'external', type: 'GoGoGo' });
    await h.create().restore([h.target]);
    expect(h.listOwnReactionsDetailed).toHaveBeenCalledTimes(listCalls + 1);
    expect(h.addReactionOnce).toHaveBeenCalledTimes(1);
    expect(h.session.turnFeedback?.['turn-a'].reaction).toEqual({ id: 'external', type: 'GoGoGo' });
  });
});

describe('typed Lark reaction receipts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('paginates own app reactions, excludes users and other apps, and deduplicates ids', async () => {
    const item = (id: string, type: string, operatorType = 'app', operatorId = 'app-a') => ({
      reaction_id: id, reaction_type: { emoji_type: type },
      operator: { operator_type: operatorType, operator_id: operatorId },
    });
    lark.client.im.v1.messageReaction.list
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [item('own-a', 'DONE'), item('human', 'DONE', 'user', '')],
          has_more: true,
          page_token: 'next',
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [item('own-a', 'DONE'), item('own-b', 'DONE'), item('other', 'DONE', 'app', 'app-b')],
          has_more: false,
        },
      });

    await expect(listOwnReactions('app-a', 'om_a', 'DONE')).resolves.toEqual([
      { id: 'own-a', type: 'DONE' },
      { id: 'own-b', type: 'DONE' },
    ]);
    expect(lark.client.im.v1.messageReaction.list).toHaveBeenNthCalledWith(2, {
      path: { message_id: 'om_a' },
      params: { reaction_type: 'DONE', page_size: 50, user_id_type: 'open_id', page_token: 'next' },
    });
  });

  it.each([undefined, 'bot', 'unknown'])('fails closed for unknown operator type %s', async operatorType => {
    lark.client.im.v1.messageReaction.list.mockResolvedValue({
      code: 0,
      data: { items: [{ operator: { operator_type: operatorType } }], has_more: false },
    });
    await expect(listOwnReactions('app-a', 'om_a')).rejects.toThrow('Ambiguous');
  });

  it('fails closed for repeated cursors and conflicting duplicate ids', async () => {
    lark.client.im.v1.messageReaction.list.mockResolvedValue({
      code: 0, data: { items: [], has_more: true, page_token: 'same' },
    });
    await expect(listOwnReactions('app-a', 'om_a')).rejects.toThrow('pagination');
    expect(lark.client.im.v1.messageReaction.list).toHaveBeenCalledTimes(2);

    lark.client.im.v1.messageReaction.list.mockReset().mockResolvedValue({
      code: 0,
      data: {
        items: [
          { reaction_id: 'same-id', reaction_type: { emoji_type: 'DONE' }, operator: { operator_type: 'app', operator_id: 'app-a' } },
          { reaction_id: 'same-id', reaction_type: { emoji_type: 'ERROR' }, operator: { operator_type: 'app', operator_id: 'app-a' } },
        ],
        has_more: false,
      },
    });
    await expect(listOwnReactions('app-a', 'om_a')).rejects.toThrow('Conflicting');
  });

  it.each([230110, 231003, 231005, 232009])('classifies LIST gone code %s exactly', async code => {
    lark.client.im.v1.messageReaction.list.mockResolvedValue({ code });
    await expect(listOwnReactionsDetailed('app-a', 'om_a')).resolves.toEqual({ status: 'gone' });
  });

  it.each([
    [230110, { status: 'gone' }],
    [231003, { status: 'gone' }],
    [232009, { status: 'gone' }],
    [231001, { status: 'failed', reason: 'invalid-emoji' }],
    [231012, { status: 'failed', reason: 'invalid-request' }],
    [231017, { status: 'failed', reason: 'unsupported-message' }],
    [231002, { status: 'blocked', reason: 'permission-denied' }],
    [231004, { status: 'blocked', reason: 'chat-unavailable' }],
    [231006, { status: 'blocked', reason: 'operator-unavailable' }],
    [99991400, { status: 'retryable', reason: 'rate-limited' }],
    [231015, { status: 'retryable', reason: 'request-processing' }],
  ] as const)('classifies CREATE code %s', async (code, expected) => {
    lark.client.im.v1.messageReaction.create.mockResolvedValue({ code });
    await expect(addReactionOnce('app-a', 'om_a', 'DONE')).resolves.toEqual(expected);
  });

  it('returns ambiguous after one provider CREATE transport attempt', async () => {
    lark.client.im.v1.messageReaction.create.mockRejectedValue(new Error('ACK lost'));
    await expect(addReactionOnce('app-a', 'om_a', 'DONE')).resolves.toEqual({ status: 'ambiguous' });
    expect(lark.client.im.v1.messageReaction.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    [0, 'deleted'],
    [230110, 'gone'],
    [231005, 'gone'],
    [232009, 'gone'],
    [231003, 'failed'],
    [231011, 'failed'],
  ] as const)('classifies DELETE code %s as %s', async (code, expected) => {
    lark.client.im.v1.messageReaction.delete.mockResolvedValue({ code });
    await expect(removeReactionDetailed('app-a', 'om_a', 'rid')).resolves.toBe(expected);
  });
});
