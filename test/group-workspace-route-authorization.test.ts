import { describe, expect, it, vi } from 'vitest';
import type { FreshBotAdminUnionSnapshot, TenantHumanId } from '../src/services/bot-admin-unions-store.js';
import {
  classifyGroupWorkspaceCardRoute,
  classifyGroupWorkspaceTextRoute,
} from '../src/core/group-workspace-policy.js';
import { tryDispatchGroupWorkspaceTextRoute } from '../src/im/lark/event-dispatcher.js';
import { tryDispatchGroupWorkspaceCardRoute } from '../src/im/lark/card-handler.js';

const CHAT = 'oc_group';
const ACTOR: TenantHumanId = { tenantKey: 'tenant-1', unionId: 'on_user' };
const SNAPSHOT: FreshBotAdminUnionSnapshot = {
  configFingerprint: 'current-bot-union',
  admins: [ACTOR],
  updatedAt: 1_000,
  expiresAt: 2_000,
};

function authority(canSwitchSession = true) {
  return { actor: ACTOR, freshSnapshot: SNAPSHOT, canSwitchSession };
}

describe('group workspace text pre-gate route', () => {
  it('routes Bot-A-only administrator through Bot B by stable tenant union', async () => {
    const route = vi.fn(async () => undefined);
    const genericGate = vi.fn(() => false);
    const reply = vi.fn(async () => undefined);

    const result = await tryDispatchGroupWorkspaceTextRoute({
      text: '/repo /repos/x',
      chatId: CHAT,
      chatType: 'group',
      scope: 'chat',
      regularGroupTopLevel: true,
      senderOpenId: 'ou_user_as_seen_by_bot_b',
      senderUnionId: ACTOR.unionId,
      tenantKey: ACTOR.tenantKey,
    }, {
      resolveAuthority: vi.fn(async () => authority()),
      handleRoute: route,
      canRunGenericCommand: genericGate,
      replyDenied: reply,
    });

    expect(result).toBe('dispatched');
    expect(route).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'set', chatId: CHAT, selection: '/repos/x', actor: ACTOR,
    }));
    expect(genericGate).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it.each([
    ['ordinary message', 'please use /repo /repos/x', 'chat', true],
    ['/help', '/help', 'chat', true],
    ['/cd', '/cd /repos/x', 'chat', true],
    ['thread repo', '/repo /repos/x', 'thread', false],
    ['worktree repo', '/repo wt /repos/x', 'chat', true],
    ['here repo', '/repo here', 'chat', true],
    ['show repo', '/repo show', 'chat', true],
  ])('does not bypass for %s', async (_name, text, scope, regularGroupTopLevel) => {
    const genericGate = vi.fn(() => false);
    const result = await tryDispatchGroupWorkspaceTextRoute({
      text,
      chatId: CHAT,
      chatType: 'group',
      scope: scope as 'chat' | 'thread',
      regularGroupTopLevel,
      senderOpenId: 'ou_b',
      senderUnionId: ACTOR.unionId,
      tenantKey: ACTOR.tenantKey,
    }, {
      resolveAuthority: vi.fn(async () => authority()),
      handleRoute: vi.fn(),
      canRunGenericCommand: genericGate,
      replyDenied: vi.fn(),
    });
    expect(result).toBe('not_applicable');
    expect(genericGate).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing union', undefined, ACTOR.tenantKey, SNAPSHOT],
    ['missing tenant', ACTOR.unionId, undefined, SNAPSHOT],
    ['fresh snapshot unavailable', ACTOR.unionId, ACTOR.tenantKey, undefined],
  ])('fails closed when %s', async (_name, senderUnionId, tenantKey, freshSnapshot) => {
    const route = vi.fn();
    const genericGate = vi.fn(() => false);
    const result = await tryDispatchGroupWorkspaceTextRoute({
      text: '/repo unbind', chatId: CHAT, chatType: 'group', scope: 'chat', regularGroupTopLevel: true,
      senderOpenId: 'ou_b', senderUnionId, tenantKey,
    }, {
      resolveAuthority: vi.fn(async () => freshSnapshot ? {
        actor: { tenantKey: tenantKey!, unionId: senderUnionId! }, freshSnapshot, canSwitchSession: true,
      } : undefined),
      handleRoute: route,
      canRunGenericCommand: genericGate,
      replyDenied: vi.fn(),
    });
    expect(result).toBe('not_authorized');
    expect(route).not.toHaveBeenCalled();
    expect(genericGate).toHaveBeenCalledOnce();
  });

  it('denies group manager without session-switch capability and never falls back', async () => {
    const route = vi.fn();
    const genericGate = vi.fn(() => true);
    const reply = vi.fn(async () => undefined);
    const result = await tryDispatchGroupWorkspaceTextRoute({
      text: '/repo /repos/x', chatId: CHAT, chatType: 'group', scope: 'chat', regularGroupTopLevel: true,
      senderOpenId: 'ou_b', senderUnionId: ACTOR.unionId, tenantKey: ACTOR.tenantKey,
    }, {
      resolveAuthority: vi.fn(async () => authority(false)),
      handleRoute: route,
      canRunGenericCommand: genericGate,
      replyDenied: reply,
    });
    expect(result).toBe('switch_denied');
    expect(reply).toHaveBeenCalledWith(expect.stringMatching(/会话|切换/));
    expect(route).not.toHaveBeenCalled();
    expect(genericGate).not.toHaveBeenCalled();
  });
});

describe('group workspace repo-card pre-gate route', () => {
  it('routes the matching original repo card by stable tenant union', async () => {
    const route = vi.fn(async () => undefined);
    const genericGate = vi.fn(() => false);
    const result = await tryDispatchGroupWorkspaceCardRoute({
      repoKey: 'repo_switch', selection: '/repos/x', chatId: CHAT, callbackChatId: CHAT,
      rootId: CHAT, chatType: 'group', cardMessageId: 'om_card', currentRepoCardMessageId: 'om_card',
      operatorOpenId: 'ou_user_as_seen_by_bot_b', operatorUnionId: ACTOR.unionId,
      tenantKey: ACTOR.tenantKey, actionId: 'evt_action_1',
    }, {
      resolveAuthority: vi.fn(async () => authority()),
      handleRoute: route,
      canRunGenericCardAction: genericGate,
    });
    expect(result).toEqual({ status: 'dispatched' });
    expect(route).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'set', source: 'card', chatId: CHAT, selection: '/repos/x', actor: ACTOR,
      originMessageId: 'om_card', actionId: 'evt_action_1',
    }));
    expect(genericGate).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong chat', { callbackChatId: 'oc_other' }],
    ['stale card', { cardMessageId: 'om_old' }],
    ['fabricated card', { currentRepoCardMessageId: undefined }],
    ['worktree card', { repoKey: 'repo_worktree' }],
    ['thread card', { rootId: 'om_thread' }],
  ])('does not bypass a %s action', async (_name, patch) => {
    const genericGate = vi.fn(() => false);
    const input = {
      repoKey: 'repo_switch', selection: '/repos/x', chatId: CHAT, callbackChatId: CHAT,
      rootId: CHAT, chatType: 'group' as const, cardMessageId: 'om_card', currentRepoCardMessageId: 'om_card',
      operatorOpenId: 'ou_b', operatorUnionId: ACTOR.unionId, tenantKey: ACTOR.tenantKey,
      actionId: 'evt_action_1', ...patch,
    };
    const result = await tryDispatchGroupWorkspaceCardRoute(input, {
      resolveAuthority: vi.fn(async () => authority()), handleRoute: vi.fn(), canRunGenericCardAction: genericGate,
    });
    expect(result).toEqual({ status: 'not_applicable' });
    expect(genericGate).toHaveBeenCalledOnce();
  });

  it('returns a visible denial without switching, writing, or falling back', async () => {
    const route = vi.fn();
    const genericGate = vi.fn(() => true);
    const result = await tryDispatchGroupWorkspaceCardRoute({
      repoKey: 'repo_switch', selection: '/repos/x', chatId: CHAT, callbackChatId: CHAT,
      rootId: CHAT, chatType: 'group', cardMessageId: 'om_card', currentRepoCardMessageId: 'om_card',
      operatorOpenId: 'ou_b', operatorUnionId: ACTOR.unionId, tenantKey: ACTOR.tenantKey,
      actionId: 'evt_action_1',
    }, {
      resolveAuthority: vi.fn(async () => authority(false)), handleRoute: route, canRunGenericCardAction: genericGate,
    });
    expect(result.status).toBe('switch_denied');
    expect(result.toast).toMatch(/会话|切换/);
    expect(route).not.toHaveBeenCalled();
    expect(genericGate).not.toHaveBeenCalled();
  });
});

describe('narrow classifiers', () => {
  it('accepts only ordinary-group set/unbind text', () => {
    expect(classifyGroupWorkspaceTextRoute({ text: '/repo x', chatType: 'group', scope: 'chat', regularGroupTopLevel: true }))
      .toEqual({ kind: 'set', selection: 'x' });
    expect(classifyGroupWorkspaceTextRoute({ text: '/repo unbind', chatType: 'group', scope: 'chat', regularGroupTopLevel: true }))
      .toEqual({ kind: 'unbind' });
    expect(classifyGroupWorkspaceTextRoute({ text: '/repo wt x', chatType: 'group', scope: 'chat', regularGroupTopLevel: true }))
      .toBeUndefined();
  });

  it('requires exact chat and original card capability', () => {
    expect(classifyGroupWorkspaceCardRoute({
      repoKey: 'repo_switch', selection: 'x', chatId: CHAT, callbackChatId: CHAT, rootId: CHAT,
      chatType: 'group', cardMessageId: 'om_card', currentRepoCardMessageId: 'om_card', actionId: 'evt_1',
    })).toEqual({ kind: 'set', selection: 'x' });
    expect(classifyGroupWorkspaceCardRoute({
      repoKey: 'repo_switch', selection: 'x', chatId: CHAT, callbackChatId: 'other', rootId: CHAT,
      chatType: 'group', cardMessageId: 'om_card', currentRepoCardMessageId: 'om_card', actionId: 'evt_1',
    })).toBeUndefined();
  });
});
