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
