import { beforeEach, describe, expect, it, vi } from 'vitest';

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
