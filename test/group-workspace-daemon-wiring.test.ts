import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import { createGroupWorkspaceRouteRuntime } from '../src/core/group-workspace-route-runtime.js';
import { tryDispatchGroupWorkspaceTextRoute } from '../src/im/lark/event-dispatcher.js';
import { tryDispatchGroupWorkspaceCardRoute } from '../src/im/lark/card-handler.js';
import { VerifiedAppTenantRegistry } from '../src/core/workspace-authority.js';
import { setDefaultLocale } from '../src/i18n/index.js';

const APP = 'cli_b';
const CHAT = 'oc_group';
const ACTOR = { tenantKey: 'tenant-1', unionId: 'on_user' };

afterEach(() => setDefaultLocale('zh'));

function liveSession(overrides: Partial<DaemonSession> = {}): DaemonSession {
  return {
    larkAppId: APP,
    chatId: CHAT,
    chatType: 'group',
    scope: 'chat',
    session: {
      sessionId: 'session-1', chatId: CHAT, rootMessageId: CHAT, status: 'active',
      createdAt: new Date(0).toISOString(), larkAppId: APP, chatType: 'group', scope: 'chat',
    },
    worker: null,
    spawnedAt: 0,
    lastMessageAt: 0,
    hasHistory: false,
    ...overrides,
  } as DaemonSession;
}

function setup(overrides: { active?: boolean; managers?: typeof ACTOR[]; canOperate?: boolean } = {}) {
  const ds = liveSession();
  const dispatchRepo = vi.fn(async () => undefined);
  const reply = vi.fn(async () => undefined);
  const runtime = createGroupWorkspaceRouteRuntime({
    larkAppId: APP,
    activeSessions: overrides.active === false ? new Map() : new Map([[`${APP}:${CHAT}`, ds]]),
    sessionKey: (chatId, appId) => `${appId}:${chatId}`,
    registeredBots: () => [
      { larkAppId: 'cli_a', tenantKey: ACTOR.tenantKey, resolvedAllowedUsers: ['ou_a'] },
      { larkAppId: APP, tenantKey: ACTOR.tenantKey, resolvedAllowedUsers: [] },
    ],
    resolveAllowedUser: vi.fn(async bot => bot.larkAppId === 'cli_a' ? ACTOR : undefined),
    resolveActorUnion: vi.fn(async () => ACTOR.unionId),
    readWorkspace: vi.fn(async () => ({ status: 'available' as const,
      record: overrides.managers ? { workspaceManagers: overrides.managers } : undefined })),
    canSwitchSession: (candidate, actor) => candidate === ds
      && actor.openId === 'ou_b'
      && actor.unionId === ACTOR.unionId
      && actor.humanProvenance === true
      && overrides.canOperate !== false,
    dispatchRepo,
    reply,
    now: () => 1_000,
  });
  return { runtime, dispatchRepo, reply, ds };
}

describe('production group-workspace route dependency assembly', () => {
  it('uses the host-wide fresh snapshot and exact chat ACL before existing /repo behavior', async () => {
    const { runtime, dispatchRepo, ds } = setup({ managers: [ACTOR] });
    const authority = await runtime.resolveAuthority({
      text: '/repo /repos/x', chatId: CHAT, chatType: 'group', scope: 'chat',
      senderOpenId: 'ou_b', senderUnionId: ACTOR.unionId, tenantKey: ACTOR.tenantKey, humanProvenance: true,
    });
    expect(authority?.actor).toEqual(ACTOR);
    expect(authority?.freshSnapshot.admins).toContainEqual(ACTOR);
    expect(authority?.workspaceManagers).toEqual([ACTOR]);
    expect(authority?.canSwitchSession).toBe(true);

    await runtime.handleRoute({ kind: 'set', selection: '/repos/x', source: 'text', chatId: CHAT, actor: ACTOR,
      actorOpenId: 'ou_b' });
    expect(dispatchRepo).toHaveBeenCalledWith(ds, '/repos/x', expect.objectContaining({ actor: ACTOR, actorOpenId: 'ou_b' }));
  });

  it('denies a Bot-A group manager who lacks receiving Bot B canOperate with zero handler or fallback', async () => {
    const { runtime, dispatchRepo } = setup({ managers: [ACTOR], canOperate: false });
    const fallback = vi.fn(() => true);
    const reply = vi.fn(async () => undefined);
    const result = await tryDispatchGroupWorkspaceTextRoute({
      text: '/repo /repos/x', chatId: CHAT, chatType: 'group', scope: 'chat', regularGroupTopLevel: true,
      senderOpenId: 'ou_b', senderUnionId: ACTOR.unionId, tenantKey: ACTOR.tenantKey, humanProvenance: true,
    }, {
      resolveAuthority: runtime.resolveAuthority,
      handleRoute: runtime.handleRoute,
      canRunGenericCommand: fallback,
      replyDenied: reply,
    });

    expect(result).toBe('switch_denied');
    expect(reply).toHaveBeenCalledWith(expect.stringMatching(/接收机器人.*会话切换权限/));
    expect(dispatchRepo).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  it('dispatches text and card routes when the same actor passes receiving Bot B canOperate', async () => {
    const { runtime, dispatchRepo } = setup({ managers: [ACTOR], canOperate: true });
    const textResult = await tryDispatchGroupWorkspaceTextRoute({
      text: '/repo /repos/text', chatId: CHAT, chatType: 'group', scope: 'chat', regularGroupTopLevel: true,
      senderOpenId: 'ou_b', senderUnionId: ACTOR.unionId, tenantKey: ACTOR.tenantKey, humanProvenance: true,
    }, {
      resolveAuthority: runtime.resolveAuthority,
      handleRoute: runtime.handleRoute,
      canRunGenericCommand: vi.fn(() => false),
      replyDenied: vi.fn(),
    });
    const cardResult = await tryDispatchGroupWorkspaceCardRoute({
      repoKey: 'repo_switch', selection: '/repos/card', chatId: CHAT, callbackChatId: CHAT,
      rootId: CHAT, chatType: 'group', cardMessageId: 'om_card', currentRepoCardMessageId: 'om_card',
      operatorOpenId: 'ou_b', operatorUnionId: ACTOR.unionId, tenantKey: ACTOR.tenantKey, humanProvenance: true, actionId: 'evt_1',
    }, {
      resolveAuthority: runtime.resolveAuthority,
      handleRoute: runtime.handleRoute,
      canRunGenericCardAction: vi.fn(() => false),
    });

    expect(textResult).toBe('dispatched');
    expect(cardResult).toEqual({ status: 'dispatched' });
    expect(dispatchRepo).toHaveBeenCalledTimes(2);
  });

  it('denies the equivalent card route without receiving Bot B canOperate and invokes zero handler', async () => {
    const { runtime, dispatchRepo } = setup({ managers: [ACTOR], canOperate: false });
    const fallback = vi.fn(() => true);
    const result = await tryDispatchGroupWorkspaceCardRoute({
      repoKey: 'repo_switch', selection: '/repos/x', chatId: CHAT, callbackChatId: CHAT,
      rootId: CHAT, chatType: 'group', cardMessageId: 'om_card', currentRepoCardMessageId: 'om_card',
      operatorOpenId: 'ou_b', operatorUnionId: ACTOR.unionId, tenantKey: ACTOR.tenantKey, humanProvenance: true, actionId: 'evt_1',
    }, {
      resolveAuthority: runtime.resolveAuthority,
      handleRoute: runtime.handleRoute,
      canRunGenericCardAction: fallback,
    });

    expect(result.status).toBe('switch_denied');
    expect(result.toast).toMatch(/接收机器人.*会话切换权限/);
    expect(dispatchRepo).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  it('fails closed without an exact active chat session and produces zero switch effects', async () => {
    const { runtime, dispatchRepo } = setup({ active: false });
    const authority = await runtime.resolveAuthority({
      text: '/repo /repos/x', chatId: CHAT, chatType: 'group', scope: 'chat',
      senderOpenId: 'ou_b', senderUnionId: ACTOR.unionId, tenantKey: ACTOR.tenantKey, humanProvenance: true,
    });
    expect(authority?.canSwitchSession).toBe(false);
    expect(dispatchRepo).not.toHaveBeenCalled();
  });

  it('excludes a foreign-tenant bot from the production admin union', async () => {
    const tenants = new VerifiedAppTenantRegistry();
    tenants.observeSignedCallback('app-a', 'tenant-a', 1);
    tenants.observeSignedCallback('app-b', 'tenant-b', 1);
    const registeredBots = tenants.registeredBots([
      { larkAppId: 'app-a', resolvedAllowedUsers: ['ou_owner_a'] },
      { larkAppId: 'app-b', resolvedAllowedUsers: ['ou_owner_b'] },
    ], 'tenant-a');
    const runtime = createGroupWorkspaceRouteRuntime({
      larkAppId: 'app-a', activeSessions: new Map(), sessionKey: (chatId, appId) => `${appId}:${chatId}`,
      registeredBots: () => registeredBots,
      resolveAllowedUser: vi.fn(async bot => bot.larkAppId === 'app-b'
        ? { tenantKey: bot.tenantKey, unionId: 'on_foreign' }
        : { tenantKey: bot.tenantKey, unionId: 'on_owner' }),
      resolveActorUnion: vi.fn(async () => 'on_foreign'),
      readWorkspace: vi.fn(async () => ({ status: 'available' as const })),
      canSwitchSession: () => true, dispatchRepo: vi.fn(), reply: vi.fn(),
    });

    const fallback = vi.fn(() => true);
    await expect(tryDispatchGroupWorkspaceTextRoute({ text: '/repo /repos/x', chatId: CHAT,
      chatType: 'group', scope: 'chat', regularGroupTopLevel: true, senderOpenId: 'ou_foreign_view_a',
      senderUnionId: 'on_foreign', tenantKey: 'tenant-a', humanProvenance: true }, {
      resolveAuthority: runtime.resolveAuthority, handleRoute: runtime.handleRoute,
      canRunGenericCommand: fallback, replyDenied: vi.fn(),
    })).resolves.toBe('recognized_denied');
    expect(fallback).not.toHaveBeenCalled();
    expect(registeredBots).toEqual([
      expect.objectContaining({ larkAppId: 'app-a', tenantKey: 'tenant-a' }),
    ]);
  });

  it('rejects an envelope union that the receiving app cannot verify', async () => {
    const ds = liveSession();
    const dispatchRepo = vi.fn();
    const runtime = createGroupWorkspaceRouteRuntime({
      larkAppId: APP,
      activeSessions: new Map([[`${APP}:${CHAT}`, ds]]),
      sessionKey: (chatId, appId) => `${appId}:${chatId}`,
      registeredBots: () => [{ larkAppId: APP, tenantKey: ACTOR.tenantKey, resolvedAllowedUsers: ['ou_owner'] }],
      resolveAllowedUser: vi.fn(async () => ACTOR),
      resolveActorUnion: vi.fn(async () => undefined),
      readWorkspace: vi.fn(async () => ({ status: 'available' as const })),
      canSwitchSession: () => true,
      dispatchRepo,
      reply: vi.fn(),
    });
    await expect(runtime.resolveAuthority({ chatId: CHAT, senderOpenId: 'ou_b', senderUnionId: ACTOR.unionId,
      tenantKey: ACTOR.tenantKey, humanProvenance: true })).resolves.toEqual({ status: 'recognized_denied', reason: 'identity_unavailable' });
    expect(dispatchRepo).not.toHaveBeenCalled();
  });

  it('fails closed for a tenant-less callback even after a signed text event', async () => {
    const ds = liveSession();
    const runtime = createGroupWorkspaceRouteRuntime({
      larkAppId: APP, activeSessions: new Map([[`${APP}:${CHAT}`, ds]]), sessionKey: (chatId, appId) => `${appId}:${chatId}`,
      registeredBots: tenantKey => [{ larkAppId: APP, tenantKey, resolvedAllowedUsers: ['ou_owner'] }],
      resolveAllowedUser: vi.fn(async () => ACTOR), resolveActorUnion: vi.fn(async () => ACTOR.unionId),
      readWorkspace: vi.fn(async () => ({ status: 'available' as const })), canSwitchSession: () => true,
      dispatchRepo: vi.fn(), reply: vi.fn(),
    });
    await expect(runtime.resolveAuthority({ chatId: CHAT, senderOpenId: 'ou_user', senderUnionId: ACTOR.unionId,
      tenantKey: ACTOR.tenantKey, humanProvenance: true })).resolves.toMatchObject({ status: 'authorized' });
    await expect(runtime.resolveAuthority({ chatId: CHAT, operatorOpenId: 'ou_user', operatorUnionId: ACTOR.unionId,
      humanProvenance: true })).resolves.toEqual({ status: 'recognized_denied', reason: 'identity_unavailable' });
  });

  it.each([
    ['zh', /解绑未执行/],
    ['en', /Unbind was not executed/],
  ] as const)('localizes the authenticated unbind denial in %s', async (locale, expected) => {
    setDefaultLocale(locale);
    const { runtime, dispatchRepo, reply } = setup();
    await runtime.handleRoute({ kind: 'unbind', source: 'card', chatId: CHAT, actor: ACTOR,
      actorOpenId: 'ou_b', originMessageId: 'om_card', actionId: 'evt_action' });
    expect(dispatchRepo).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(CHAT, expect.stringMatching(expected));
  });
});
