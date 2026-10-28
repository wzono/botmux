import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistedTurnFeedback, Session } from '../src/types.js';
import { createTurnFeedbackReconciler, type TurnFeedbackTarget } from '../src/services/turn-feedback-reconciler.js';

const lark = vi.hoisted(() => ({
  create: vi.fn(),
  remove: vi.fn(),
  list: vi.fn(),
  assertWrite: vi.fn(),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBotClient: () => ({
    im: { v1: { messageReaction: {
      create: lark.create,
      delete: lark.remove,
      list: lark.list,
    } } },
  }),
}));

vi.mock('../src/im/lark/client.js', () => ({
  assertMessageWriteAllowed: lark.assertWrite,
}));

import {
  createReactionOnce,
  deleteReactionOnce,
  listOwnReactions,
} from '../src/im/lark/reaction-provider.js';

const APP = 'cli_test';
const MESSAGE = 'om_message';
const NOW = Date.parse('2026-10-28T08:00:00.000Z');

function feedback(patch: Partial<PersistedTurnFeedback> = {}): PersistedTurnFeedback {
  return {
    version: 1, turnId: 'turn-a', messageId: MESSAGE, phase: 'processing',
    updatedAt: new Date(NOW).toISOString(),
    ...patch,
  };
}

function reconcilerHarness(initial: PersistedTurnFeedback) {
  const session = {
    sessionId: 'session-a', status: 'active',
    turnFeedback: { 'turn-a': structuredClone(initial) },
  } as Session;
  const target: TurnFeedbackTarget = { session, larkAppId: APP };
  const effects: string[] = [];
  const commit = vi.fn((_: TurnFeedbackTarget, mutate: (fresh: Session) => void) => {
    mutate(session);
    effects.push('commit');
    return session;
  });
  const list = vi.fn(async () => {
    effects.push('list');
    return { kind: 'listed' as const, reactions: [] };
  });
  const create = vi.fn(async (_app: string, _message: string, type: string) => {
    effects.push(`create:${type}`);
    return { kind: 'created' as const, reaction: { id: `rid-${type}`, type } };
  });
  const remove = vi.fn(async (_app: string, _message: string, id: string) => {
    effects.push(`delete:${id}`);
    return { kind: 'deleted' as const };
  });
  const make = () => createTurnFeedbackReconciler({
    commit, read: () => session, now: () => NOW, randomId: () => 'intent-a',
    policy: () => ({ processing: 'GoGoGo', completed: 'DONE', failed: 'ERROR' }),
    listOwnReactions: list, createReactionOnce: create, deleteReactionOnce: remove,
  });
  return { session, target, effects, commit, list, create, remove, make };
}

describe('typed one-shot reaction provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lark.assertWrite.mockResolvedValue(undefined);
  });

  it('lists every page, filters to this app, and deduplicates without an emoji filter', async () => {
    lark.list
      .mockResolvedValueOnce({ code: 0, data: {
        items: [
          { reaction_id: 'own-a', reaction_type: { emoji_type: 'Coffee' }, operator: { operator_type: 'app', operator_id: APP } },
          { reaction_id: 'user-a', reaction_type: { emoji_type: 'DONE' }, operator: { operator_type: 'user', operator_id: 'ou_user' } },
          { reaction_id: 'foreign-a', reaction_type: { emoji_type: 'ERROR' }, operator: { operator_type: 'app', operator_id: 'cli_foreign' } },
        ],
        has_more: true,
        page_token: 'next-page',
      } })
      .mockResolvedValueOnce({ code: 0, data: {
        items: [
          { reaction_id: 'own-a', reaction_type: { emoji_type: 'Coffee' }, operator: { operator_type: 'app', operator_id: APP } },
          { reaction_id: 'own-b', reaction_type: { emoji_type: 'DONE' }, operator: { operator_type: 'app', operator_id: APP } },
        ],
        has_more: false,
      } });

    await expect(listOwnReactions(APP, MESSAGE)).resolves.toEqual({
      kind: 'listed',
      reactions: [
        { id: 'own-a', type: 'Coffee' },
        { id: 'own-b', type: 'DONE' },
      ],
    });
    expect(lark.list).toHaveBeenCalledTimes(2);
    expect(lark.list.mock.calls[0][0].params).not.toHaveProperty('reaction_type');
    expect(lark.list.mock.calls[1][0].params).toMatchObject({ page_token: 'next-page' });
  });

  it.each([
    [{ code: 231015 }, { kind: 'retryable', reason: 'request_processing' }],
    [{ code: 99991400 }, { kind: 'retryable', reason: 'rate_limited' }],
    [{ code: 231002 }, { kind: 'blocked', reason: 'permission_denied' }],
    [{ code: 231004 }, { kind: 'blocked', reason: 'chat_unavailable' }],
    [{ code: 231006 }, { kind: 'blocked', reason: 'operator_unavailable' }],
    [{ code: 231012 }, { kind: 'permanent', reason: 'invalid_request' }],
    [{ code: 231017 }, { kind: 'permanent', reason: 'unsupported_message' }],
    [{ code: 230110 }, { kind: 'message_gone' }],
  ] as const)('classifies CREATE receipt %j', async (failure, expected) => {
    lark.create.mockRejectedValue(failure);

    await expect(createReactionOnce(APP, MESSAGE, 'DONE')).resolves.toEqual(expected);
    expect(lark.create).toHaveBeenCalledTimes(1);
    expect(lark.assertWrite).toHaveBeenCalledWith(APP, MESSAGE);
  });

  it('treats an empty successful CREATE receipt as transport uncertainty without replaying POST', async () => {
    lark.create.mockResolvedValue({ code: 0, data: {} });

    await expect(createReactionOnce(APP, MESSAGE, 'DONE')).resolves.toEqual({
      kind: 'retryable', reason: 'transport_uncertain',
    });
    expect(lark.create).toHaveBeenCalledTimes(1);
  });

  it('returns one created reaction from one POST', async () => {
    lark.create.mockResolvedValue({ code: 0, data: { reaction_id: 'rid-created' } });

    await expect(createReactionOnce(APP, MESSAGE, 'DONE')).resolves.toEqual({
      kind: 'created', reaction: { id: 'rid-created', type: 'DONE' },
    });
    expect(lark.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ code: 231003 }, { kind: 'already_absent' }],
    [{ code: 230110 }, { kind: 'message_gone' }],
    [{ code: 99991400 }, { kind: 'retryable', reason: 'rate_limited' }],
    [{ code: 231002 }, { kind: 'blocked', reason: 'permission_denied' }],
  ] as const)('classifies DELETE receipt %j without replaying DELETE', async (failure, expected) => {
    lark.remove.mockRejectedValue(failure);

    await expect(deleteReactionOnce(APP, MESSAGE, 'rid-old')).resolves.toEqual(expected);
    expect(lark.remove).toHaveBeenCalledTimes(1);
  });

  it('fails a malformed or cyclic LIST closed as invalid response', async () => {
    lark.list.mockResolvedValue({ code: 0, data: { items: [], has_more: true, page_token: 'same' } });

    await expect(listOwnReactions(APP, MESSAGE)).resolves.toEqual({
      kind: 'permanent', reason: 'invalid_response',
    });
    expect(lark.list).toHaveBeenCalledTimes(2);
  });

  it('returns transport uncertainty for an unclassified thrown transport', async () => {
    lark.list.mockRejectedValue(new Error('socket reset'));

    await expect(listOwnReactions(APP, MESSAGE)).resolves.toEqual({
      kind: 'retryable', reason: 'transport_uncertain',
    });
  });
});

describe('persisted reaction intent orchestration', () => {
  beforeEach(() => vi.useRealTimers());

  it('commits intent before LIST and every receipt before the next provider action', async () => {
    const h = reconcilerHarness(feedback());

    await h.make().reconcile(h.target, 'turn-a');

    expect(h.effects).toEqual(['commit', 'list', 'commit', 'create:GoGoGo', 'commit']);
    expect(h.session.turnFeedback?.['turn-a']).toMatchObject({
      reaction: { id: 'rid-GoGoGo', type: 'GoGoGo' },
    });
    expect(h.session.turnFeedback?.['turn-a'].reactionIntent).toBeUndefined();
  });

  it('restores only persisted intents and LISTs before adopting a prior CREATE ACK', async () => {
    const h = reconcilerHarness(feedback({ reactionIntent: {
      id: 'intent-a', messageId: MESSAGE, desiredType: 'GoGoGo',
      createdAt: new Date(NOW).toISOString(), stage: 'create', deleteIds: [],
    } }));
    h.list.mockImplementation(async () => {
      h.effects.push('list');
      return { kind: 'listed', reactions: [{ id: 'provider-ack', type: 'GoGoGo' }] };
    });

    await h.make().restore([h.target]);

    expect(h.effects).toEqual(['list', 'commit']);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.session.turnFeedback?.['turn-a'].reaction).toEqual({
      id: 'provider-ack', type: 'GoGoGo',
    });
    expect(h.session.turnFeedback?.['turn-a'].reactionIntent).toBeUndefined();
  });

  it('does not call the provider when the intent commit fails', async () => {
    const h = reconcilerHarness(feedback());
    h.commit.mockImplementationOnce(() => { throw new Error('session store unavailable'); });

    await expect(h.make().reconcile(h.target, 'turn-a')).rejects.toThrow('session store unavailable');

    expect(h.list).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('retries transient uncertainty at 1s, 5s, and 15s while keeping the intent durable', async () => {
    vi.useFakeTimers();
    try {
      const h = reconcilerHarness(feedback({ reactionIntent: {
        id: 'intent-a', messageId: MESSAGE, desiredType: 'GoGoGo',
        createdAt: new Date(NOW).toISOString(), stage: 'observe', deleteIds: [],
      } }));
      h.list.mockResolvedValue({ kind: 'retryable', reason: 'transport_uncertain' });
      const reconciler = h.make();

      await reconciler.scheduleReactionRepair(h.target, 'turn-a');
      expect(h.list).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000 + 5_000 + 15_000);

      expect(h.list).toHaveBeenCalledTimes(4);
      expect(h.create).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(h.session.turnFeedback?.['turn-a'].reactionIntent).toMatchObject({
        id: 'intent-a', retryClass: 'transient',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries blocked operations at 5m, 30m, and 2h then persists exhaustion', async () => {
    vi.useFakeTimers();
    try {
      const h = reconcilerHarness(feedback({ reactionIntent: {
        id: 'intent-a', messageId: MESSAGE, desiredType: 'GoGoGo',
        createdAt: new Date(NOW).toISOString(), stage: 'observe', deleteIds: [],
      } }));
      h.list.mockResolvedValue({ kind: 'blocked', reason: 'permission_denied' });
      const reconciler = h.make();

      await reconciler.scheduleReactionRepair(h.target, 'turn-a');
      await vi.advanceTimersByTimeAsync(300_000 + 1_800_000 + 7_200_000);

      expect(h.list).toHaveBeenCalledTimes(4);
      expect(h.session.turnFeedback?.['turn-a'].reactionIntent).toMatchObject({
        stage: 'blocked', retryExhausted: true, diagnostic: 'permission_denied',
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
