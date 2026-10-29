import type { DaemonSession } from './types.js';
import type {
  BotAdminIdentityConfig,
  FreshBotAdminUnionSnapshot,
  ResolveBotAllowedUser,
  TenantHumanId,
} from '../services/bot-admin-unions-store.js';
import { loadFreshBotAdminUnionSnapshot } from '../services/bot-admin-unions-store.js';
import type { GroupWorkspaceRouteAuthority, GroupWorkspaceRouteIntent } from './group-workspace-policy.js';

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
}

export type GroupWorkspaceProductionRoute = GroupWorkspaceRouteIntent & {
  source: 'text' | 'card';
  chatId: string;
  actor: TenantHumanId;
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
  canSwitchSession: (session: DaemonSession) => boolean;
  dispatchRepo: (
    session: DaemonSession,
    selection: string,
    context: { actor: TenantHumanId; actorOpenId?: string; messageId?: string },
  ) => Promise<void> | void;
  reply: (chatId: string, message: string) => Promise<void> | void;
  now?: () => number;
}) {
  let snapshot: FreshBotAdminUnionSnapshot | undefined;

  const resolveAuthority = async (
    input: GroupWorkspaceAuthorityInput,
  ): Promise<GroupWorkspaceRouteAuthority | undefined> => {
    const envelopeUnionId = input.senderUnionId ?? input.operatorUnionId;
    const actorOpenId = input.senderOpenId ?? input.operatorOpenId;
    const tenantKey = input.tenantKey;
    if (!tenantKey?.trim() || !actorOpenId || !envelopeUnionId?.startsWith('on_')) return undefined;
    const verifiedUnionId = await options.resolveActorUnion(actorOpenId);
    if (verifiedUnionId !== envelopeUnionId) return undefined;

    snapshot = await loadFreshBotAdminUnionSnapshot({
      registeredBots: options.registeredBots(tenantKey),
      snapshot,
      resolveAllowedUser: options.resolveAllowedUser,
      now: options.now,
    });
    if (!snapshot) return undefined;

    const workspace = await options.readWorkspace(input.chatId);
    if (workspace.status !== 'available') return undefined;
    const session = options.activeSessions.get(options.sessionKey(input.chatId, options.larkAppId));
    const exactSession = session?.larkAppId === options.larkAppId
      && session.chatId === input.chatId
      && session.chatType === 'group'
      && session.scope === 'chat'
      && session.session.status === 'active'
      ? session
      : undefined;
    return {
      actor: { tenantKey, unionId: verifiedUnionId },
      freshSnapshot: snapshot,
      workspaceManagers: workspace.record?.workspaceManagers,
      canSwitchSession: !!exactSession && options.canSwitchSession(exactSession),
    };
  };

  const handleRoute = async (route: GroupWorkspaceProductionRoute): Promise<void> => {
    if (route.kind === 'unbind') {
      await options.reply(route.chatId, '群目录解绑操作尚未接入持久化协调器；本次未写入群目录。');
      return;
    }
    const session = options.activeSessions.get(options.sessionKey(route.chatId, options.larkAppId));
    if (!session
      || session.larkAppId !== options.larkAppId
      || session.chatId !== route.chatId
      || session.chatType !== 'group'
      || session.scope !== 'chat'
      || session.session.status !== 'active'
      || !options.canSwitchSession(session)) {
      await options.reply(route.chatId, '当前群会话不支持安全切换，本次未切换会话，也未写入群目录。');
      return;
    }
    await options.dispatchRepo(session, route.selection, {
      actor: route.actor,
      actorOpenId: route.actorOpenId,
      messageId: route.messageId,
    });
  };

  return { resolveAuthority, handleRoute };
}
