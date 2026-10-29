import type {
  FreshBotAdminUnionSnapshot,
  TenantHumanId,
} from '../services/bot-admin-unions-store.js';

export interface BotWorkspaceActor {
  kind: 'bot';
  tenantKey?: string;
  openId?: string;
}

export type GroupWorkspaceActor = TenantHumanId | BotWorkspaceActor;

export type GroupWorkspaceRouteIntent =
  | { kind: 'set'; selection: string }
  | { kind: 'unbind' };

export interface GroupWorkspaceRouteAuthority {
  actor: TenantHumanId;
  freshSnapshot: FreshBotAdminUnionSnapshot;
  workspaceManagers?: readonly TenantHumanId[];
  /** A set operation also replaces the receiving Bot's current session. */
  canSwitchSession: boolean;
}

export function classifyGroupWorkspaceTextRoute(input: {
  text: string;
  chatType: 'group' | 'p2p';
  scope: 'chat' | 'thread';
  regularGroupTopLevel?: boolean;
}): GroupWorkspaceRouteIntent | undefined {
  if (input.chatType !== 'group' || input.scope !== 'chat' || input.regularGroupTopLevel !== true) return undefined;
  const match = /^\/repo(?:\s+([\s\S]*))?$/i.exec(input.text.trim());
  const argument = match?.[1]?.trim();
  if (!argument) return undefined;
  if (argument.toLowerCase() === 'unbind') return { kind: 'unbind' };
  const first = argument.split(/\s+/, 1)[0]?.toLowerCase();
  if (first === 'wt' || first === 'worktree' || first === 'here' || first === 'show') return undefined;
  return { kind: 'set', selection: argument };
}

export function classifyGroupWorkspaceCardRoute(input: {
  repoKey?: string;
  selection?: string;
  chatId: string;
  callbackChatId?: string;
  rootId?: string;
  chatType: 'group' | 'p2p';
  cardMessageId?: string;
  currentRepoCardMessageId?: string;
  actionId?: string;
}): GroupWorkspaceRouteIntent | undefined {
  if (input.repoKey !== 'repo_switch'
    || input.chatType !== 'group'
    || !input.selection?.trim()
    || !input.actionId
    || !input.callbackChatId
    || input.callbackChatId !== input.chatId
    || input.rootId !== input.chatId
    || !input.cardMessageId
    || input.cardMessageId !== input.currentRepoCardMessageId) return undefined;
  return { kind: 'set', selection: input.selection.trim() };
}

export function authorizeGroupWorkspaceRoute(
  authority: GroupWorkspaceRouteAuthority | undefined,
): authority is GroupWorkspaceRouteAuthority {
  return !!authority && canManageGroupWorkspace({
    actor: authority.actor,
    freshSnapshot: authority.freshSnapshot,
    workspaceManagers: authority.workspaceManagers,
  });
}

function isTenantHumanId(actor: GroupWorkspaceActor | undefined): actor is TenantHumanId {
  return !!actor
    && !('kind' in actor)
    && typeof actor.tenantKey === 'string'
    && actor.tenantKey.length > 0
    && typeof actor.unionId === 'string'
    && actor.unionId.startsWith('on_');
}

function sameTenantHuman(left: TenantHumanId, right: TenantHumanId): boolean {
  return left.tenantKey === right.tenantKey && left.unionId === right.unionId;
}

/** Pure fail-closed authorization for host-local group workspace mutations. */
export function canManageGroupWorkspace(options: {
  actor: GroupWorkspaceActor | undefined;
  freshSnapshot: FreshBotAdminUnionSnapshot | undefined;
  workspaceManagers?: readonly TenantHumanId[];
}): boolean {
  if (!isTenantHumanId(options.actor) || !options.freshSnapshot) return false;
  const managers = options.workspaceManagers?.length
    ? options.workspaceManagers
    : options.freshSnapshot.admins;
  return managers.some(manager => sameTenantHuman(options.actor as TenantHumanId, manager));
}
