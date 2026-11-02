import type { DaemonSession } from './types.js';
import type {
  BotAdminIdentityConfig,
  FreshBotAdminUnionSnapshot,
  ResolveBotAllowedUser,
  TenantHumanId,
} from '../services/bot-admin-unions-store.js';
import { loadFreshBotAdminUnionSnapshot } from '../services/bot-admin-unions-store.js';
import { canManageGroupWorkspace, type GroupWorkspaceRouteAuthorityResult, type GroupWorkspaceRouteIntent } from './group-workspace-policy.js';

interface WorkspaceAclRead {
  status: 'available' | 'store_unavailable';
  record?: { workspaceManagers?: readonly TenantHumanId[] };
}

export interface GroupWorkspaceAuthorityInput {
  chatId: string;
  senderOpenId?: string;
  senderUnionId?: string;
  operatorOpenId?: string;
  operatorUnionId?: string;
  tenantKey?: string;
  /** Set only by a Lark event path that has already classified the actor as human. */
  humanProvenance?: boolean;
}

export interface GroupWorkspaceSessionActor {
  openId: string;
  unionId: string;
  humanProvenance: true;
}

export type GroupWorkspaceProductionRoute = GroupWorkspaceRouteIntent & {
  source: 'text' | 'card';
  chatId: string;
  actor: TenantHumanId;
  authorityFingerprint?: string;
  actorOpenId?: string;
  messageId?: string;
  originMessageId?: string;
  actionId?: string;
};

export function createGroupWorkspaceRouteRuntime(options: {
  larkAppId: string;
  activeSessions: Map<string, DaemonSession>;
  sessionKey: (chatId: string, larkAppId: string) => string;
  registeredBots: (tenantKey: string) => readonly BotAdminIdentityConfig[];
  resolveAllowedUser: ResolveBotAllowedUser;
  resolveActorUnion: (openId: string) => Promise<string | undefined>;
  readWorkspace: (chatId: string) => Promise<WorkspaceAclRead>;
  canSwitchSession: (session: DaemonSession, actor: GroupWorkspaceSessionActor) => boolean;
  dispatchRepo: (
    session: DaemonSession,
    selection: string,
    context: { actor: TenantHumanId; actorOpenId?: string; messageId?: string },
  ) => Promise<void> | void;
  /** Task 6 dedicated saga entrypoint. When present it owns set/unbind completely. */
  executeGroupWorkspaceRoute?: (route: GroupWorkspaceProductionRoute, session?: DaemonSession) => Promise<void> | void;
  reply: (chatId: string, message: string) => Promise<void> | void;
  now?: () => number;
}) {
  let snapshot: FreshBotAdminUnionSnapshot | undefined;

  const resolveAuthority = async (
    input: GroupWorkspaceAuthorityInput,
  ): Promise<GroupWorkspaceRouteAuthorityResult> => {
    const envelopeUnionId = input.senderUnionId ?? input.operatorUnionId;
    const actorOpenId = input.senderOpenId ?? input.operatorOpenId;
    const tenantKey = input.tenantKey?.trim();
    if (input.humanProvenance !== true
      || !tenantKey
      || !actorOpenId
      || !envelopeUnionId?.startsWith('on_')) return { status: 'recognized_denied', reason: 'identity_unavailable' };
    const verifiedUnionId = await options.resolveActorUnion(actorOpenId);
    if (verifiedUnionId !== envelopeUnionId) return { status: 'recognized_denied', reason: 'identity_unavailable' };

    snapshot = await loadFreshBotAdminUnionSnapshot({
      registeredBots: options.registeredBots(tenantKey),
      snapshot,
      resolveAllowedUser: options.resolveAllowedUser,
      now: options.now,
    });
    if (!snapshot) return { status: 'recognized_denied', reason: 'stale_config' };

    const workspace = await options.readWorkspace(input.chatId);
    if (workspace.status !== 'available') return { status: 'recognized_denied', reason: 'stale_config' };
    const session = options.activeSessions.get(options.sessionKey(input.chatId, options.larkAppId));
    const exactSession = session?.larkAppId === options.larkAppId
      && session.chatId === input.chatId
      && session.chatType === 'group'
      && session.scope === 'chat'
      && session.session.status === 'active'
      ? session
      : undefined;
    const sessionActor: GroupWorkspaceSessionActor = {
      openId: actorOpenId,
      unionId: verifiedUnionId,
      humanProvenance: true,
    };
    return {
      status: 'authorized',
      actor: { tenantKey, unionId: verifiedUnionId },
      configFingerprint: snapshot.configFingerprint,
      freshSnapshot: snapshot,
      workspaceManagers: workspace.record?.workspaceManagers,
      canSwitchSession: !!exactSession && options.canSwitchSession(exactSession, sessionActor),
    };
  };

  const revalidateAuthorityConfiguration = async (
    route: Pick<GroupWorkspaceProductionRoute, 'chatId' | 'actor' | 'authorityFingerprint'>,
  ): Promise<boolean> => {
    const registered = options.registeredBots(route.actor.tenantKey);
    const fresh = await loadFreshBotAdminUnionSnapshot({
      registeredBots: registered,
      resolveAllowedUser: options.resolveAllowedUser,
      now: options.now,
      ttlMs: 1,
    });
    return !!fresh && fresh.configFingerprint === route.authorityFingerprint
      && canManageGroupWorkspace({ actor: route.actor, freshSnapshot: fresh });
  };

  const revalidateAuthority = async (route: Pick<GroupWorkspaceProductionRoute, 'chatId' | 'actor' | 'authorityFingerprint'>): Promise<boolean> => {
    if (!await revalidateAuthorityConfiguration(route)) return false;
    const workspace = await options.readWorkspace(route.chatId);
    return workspace.status === 'available' && (!workspace.record?.workspaceManagers?.length
      || workspace.record.workspaceManagers.some(manager => manager.tenantKey === route.actor.tenantKey
        && manager.unionId === route.actor.unionId));
  };

  const handleRoute = async (route: GroupWorkspaceProductionRoute): Promise<void> => {
    const session = options.activeSessions.get(options.sessionKey(route.chatId, options.larkAppId));
    if (options.executeGroupWorkspaceRoute) {
      await options.executeGroupWorkspaceRoute(route, session);
      return;
    }
    if (route.kind === 'unbind') {
      await options.reply(route.chatId, '群目录解绑操作尚未接入持久化协调器；本次未写入群目录。');
      return;
    }
    if (!session
      || session.larkAppId !== options.larkAppId
      || session.chatId !== route.chatId
      || session.chatType !== 'group'
      || session.scope !== 'chat'
      || session.session.status !== 'active'
      || !route.actorOpenId
      || !options.canSwitchSession(session, {
        openId: route.actorOpenId,
        unionId: route.actor.unionId,
        humanProvenance: true,
      })) {
      await options.reply(route.chatId, '当前群会话不支持安全切换，本次未切换会话，也未写入群目录。');
      return;
    }
    await options.dispatchRepo(session, route.selection, {
      actor: route.actor,
      actorOpenId: route.actorOpenId,
      messageId: route.messageId,
    });
  };

  return { resolveAuthority, revalidateAuthority, revalidateAuthorityConfiguration, handleRoute };
}
