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

export type GroupWorkspaceCwdSource =
  | 'explicit'
  | 'oncall-explicit'
  | 'group'
  | 'oncall-default-auto'
  | 'bot-default';

export type GroupWorkspaceLayer =
  | { status: 'usable'; workingDir: string; revision: number; directoryIdentity?: { dev: string; ino: string } }
  | { status: 'invalid' | 'inaccessible'; workingDir: string; revision: number }
  | { status: 'unbound' }
  | { status: 'store-unavailable' };

export type GroupWorkspaceCwdResolution =
  | { status: 'selected'; workingDir: string; source: GroupWorkspaceCwdSource; groupWorkspaceRevision?: number; groupWorkspaceDirectoryIdentity?: { dev: string; ino: string } }
  | { status: 'invalid' | 'inaccessible'; workingDir: string; groupWorkspaceRevision: number }
  | { status: 'store-unavailable' }
  | { status: 'picker' };

type OncallWorkspace = { workingDir: string; provenance?: 'oncall-explicit' | 'oncall-default-auto' };

/** Complete new-session precedence. Group failures are terminal, never absence. */
export function resolveGroupWorkspaceCwd(input: {
  explicitWorkingDir?: string;
  oncall?: OncallWorkspace;
  group: GroupWorkspaceLayer;
  botDefaultWorkingDir?: string;
}): GroupWorkspaceCwdResolution;
/** Compatibility seam for callers that resolve only the historical oncall/group layers. */
export function resolveGroupWorkspaceCwd(input: {
  oncall?: OncallWorkspace;
  groupWorkingDir?: string;
  groupWorkspaceRevision?: number;
}): { workingDir: string; source: Extract<GroupWorkspaceCwdSource, 'oncall-explicit' | 'group' | 'oncall-default-auto'>; groupWorkspaceRevision?: number } | undefined;
export function resolveGroupWorkspaceCwd(input: {
  explicitWorkingDir?: string;
  oncall?: OncallWorkspace;
  group?: GroupWorkspaceLayer;
  groupWorkingDir?: string;
  groupWorkspaceRevision?: number;
  botDefaultWorkingDir?: string;
}): GroupWorkspaceCwdResolution | { workingDir: string; source: Extract<GroupWorkspaceCwdSource, 'oncall-explicit' | 'group' | 'oncall-default-auto'>; groupWorkspaceRevision?: number } | undefined {
  const oncallIsExplicit = input.oncall && input.oncall.provenance !== 'oncall-default-auto';
  if (!input.group) {
    if (oncallIsExplicit) return { workingDir: input.oncall!.workingDir, source: 'oncall-explicit' };
    if (input.groupWorkingDir && Number.isSafeInteger(input.groupWorkspaceRevision)) {
      return { workingDir: input.groupWorkingDir, source: 'group', groupWorkspaceRevision: input.groupWorkspaceRevision };
    }
    if (input.oncall) return { workingDir: input.oncall.workingDir, source: 'oncall-default-auto' };
    return undefined;
  }
  if (input.explicitWorkingDir) return { status: 'selected', workingDir: input.explicitWorkingDir, source: 'explicit' };
  if (oncallIsExplicit) return { status: 'selected', workingDir: input.oncall!.workingDir, source: 'oncall-explicit' };
  if (input.group.status === 'usable') {
    return {
      status: 'selected', workingDir: input.group.workingDir, source: 'group',
      groupWorkspaceRevision: input.group.revision,
      groupWorkspaceDirectoryIdentity: input.group.directoryIdentity,
    };
  }
  if (input.group.status === 'invalid' || input.group.status === 'inaccessible') {
    return { status: input.group.status, workingDir: input.group.workingDir, groupWorkspaceRevision: input.group.revision };
  }
  if (input.group.status === 'store-unavailable') return { status: 'store-unavailable' };
  if (input.oncall) return { status: 'selected', workingDir: input.oncall.workingDir, source: 'oncall-default-auto' };
  if (input.botDefaultWorkingDir) return { status: 'selected', workingDir: input.botDefaultWorkingDir, source: 'bot-default' };
  return { status: 'picker' };
}

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
  const kind = input.repoKey === 'repo_switch'
    ? 'set'
    : input.repoKey === 'group_workspace_unbind'
      ? 'unbind'
      : undefined;
  if (!kind
    || input.chatType !== 'group'
    || (kind === 'set' && !input.selection?.trim())
    || !input.actionId
    || !input.callbackChatId
    || input.callbackChatId !== input.chatId
    || input.rootId !== input.chatId
    || !input.cardMessageId
    || input.cardMessageId !== input.currentRepoCardMessageId) return undefined;
  return kind === 'unbind'
    ? { kind }
    : { kind, selection: input.selection!.trim() };
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
