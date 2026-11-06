import { describe, expect, it, vi } from 'vitest';

import { resolveAskRootTarget } from '../src/core/ask-into-target.js';
import { bindSessionScopedIpcIdentity } from '../src/core/daemon-ipc-session-auth.js';

const validItem = {
  message_id: 'om_target', chat_id: 'oc_chat', deleted: false,
};

function input(getMessageDetail: (appId: string, messageId: string) => Promise<unknown>) {
  return {
    requestedRootMessageId: 'om_target',
    ambientRootMessageId: null,
    authenticatedChatId: 'oc_chat',
    larkAppId: 'cli_app',
    getMessageDetail,
  };
}

describe('resolveAskRootTarget', () => {
  it('preserves ambient routing without a provider lookup when --into is absent', async () => {
    const getMessageDetail = vi.fn();
    await expect(resolveAskRootTarget({
      ...input(getMessageDetail), requestedRootMessageId: undefined,
    })).resolves.toEqual({ ok: true, rootMessageId: null });
    expect(getMessageDetail).not.toHaveBeenCalled();
  });

  it.each([
    ['items response', { items: [validItem] }],
    ['message response', { message: validItem }],
    ['direct response', validItem],
    ['self-root response', { items: [{ ...validItem, root_id: 'om_target' }] }],
  ])('accepts a live exact root from the provider %s', async (_label, detail) => {
    const getMessageDetail = vi.fn(async () => detail);
    await expect(resolveAskRootTarget(input(getMessageDetail)))
      .resolves.toEqual({ ok: true, rootMessageId: 'om_target' });
    expect(getMessageDetail).toHaveBeenCalledWith('cli_app', 'om_target', { userCardContent: false });
  });

  it('uses authenticated chat identity instead of caller-supplied chat claims', async () => {
    const bound = bindSessionScopedIpcIdentity({
      sessionId: 'spoofed', chatId: 'oc_spoofed', larkAppId: 'cli_spoofed', rootMessageId: null,
      requestedRootMessageId: 'om_target',
    }, {
      sessionId: 'live', chatId: 'oc_live', larkAppId: 'cli_live', rootMessageId: null,
    });
    const getMessageDetail = vi.fn(async () => ({ items: [{ ...validItem, chat_id: 'oc_spoofed' }] }));
    await expect(resolveAskRootTarget({
      requestedRootMessageId: bound.requestedRootMessageId,
      ambientRootMessageId: bound.rootMessageId,
      authenticatedChatId: bound.chatId,
      larkAppId: bound.larkAppId,
      getMessageDetail,
    })).resolves.toMatchObject({ ok: false, status: 403 });
    expect(getMessageDetail).toHaveBeenCalledWith('cli_live', 'om_target', { userCardContent: false });
  });

  it.each([
    ['deleted root', { items: [{ ...validItem, deleted: true }] }],
    ['unknown deletion state', { items: [{ message_id: 'om_target', chat_id: 'oc_chat' }] }],
    ['same-chat reply', { items: [{ ...validItem, root_id: 'om_other_root' }] }],
    ['cross-chat root', { items: [{ ...validItem, chat_id: 'oc_other' }] }],
    ['mismatched message id', { items: [{ ...validItem, message_id: 'om_other' }] }],
    ['multiple exact matches', { items: [validItem, { ...validItem }] }],
    ['missing root', { items: [] }],
  ])('rejects %s without falling back or creating an Ask', async (_label, detail) => {
    await expect(resolveAskRootTarget(input(async () => detail)))
      .resolves.toEqual({ ok: false, status: 403, error: 'ask_into_invalid_target' });
  });

  it('rejects provider validation failures without creating an Ask', async () => {
    await expect(resolveAskRootTarget(input(async () => { throw new Error('message withdrawn'); })))
      .resolves.toEqual({ ok: false, status: 502, error: 'ask_into_validation_failed', detail: 'message withdrawn' });
  });
});
