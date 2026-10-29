/**
 * Shared helper for repinning a topic session's working directory.
 * Extracted from the `/cd` command handler so the upcoming dashboard IPC
 * `cd` route (Task 9) can reuse the exact same daemon-record write path.
 */
import type { Session, SessionWorkingDirSource } from '../types.js';
import type { DaemonSession } from './types.js';
import * as sessionStore from '../services/session-store.js';
import { dashboardEventBus } from './dashboard-events.js';

export type SessionWorkingDirMutation =
  | { workingDir: string; source: 'group'; groupWorkspaceRevision: number; groupWorkspaceDirectoryIdentity?: { dev: string; ino: string } }
  | { workingDir: string; source: Exclude<SessionWorkingDirSource, 'group'>; groupWorkspaceRevision?: never; groupWorkspaceDirectoryIdentity?: never };

const SESSION_WORKING_DIR_SOURCES = new Set<SessionWorkingDirSource>([
  'explicit', 'oncall-explicit', 'oncall-default-auto', 'group',
  'bot-default', 'worktree', 'legacy-unknown',
]);

function assertWorkingDirProvenance(input: {
  source: SessionWorkingDirSource;
  groupWorkspaceRevision?: number;
}): void {
  if (!SESSION_WORKING_DIR_SOURCES.has(input.source)) throw new Error('invalid workingDirSource');
  if (input.source === 'group') {
    if (!Number.isSafeInteger(input.groupWorkspaceRevision) || input.groupWorkspaceRevision! < 0) {
      throw new Error('group cwd provenance requires a safe non-negative revision');
    }
  } else if (input.groupWorkspaceRevision !== undefined) {
    throw new Error('non-group cwd provenance must not carry a group revision');
  }
}

/** Validate persisted metadata and conservatively migrate rows written before provenance existed. */
export function normalizeSessionWorkingDirProvenance<T extends Session>(session: T): T {
  session.workingDirSource ??= 'legacy-unknown';
  assertWorkingDirProvenance({
    source: session.workingDirSource,
    groupWorkspaceRevision: session.groupWorkspaceRevision,
  });
  return session;
}

export function setSessionWorkingDirMetadata(session: Session, mutation: SessionWorkingDirMutation): void {
  assertWorkingDirProvenance(mutation);
  session.workingDir = mutation.workingDir;
  session.workingDirSource = mutation.source;
  session.groupWorkspaceRevision = mutation.source === 'group' ? mutation.groupWorkspaceRevision : undefined;
  session.groupWorkspaceDirectoryIdentity = mutation.source === 'group'
    ? mutation.groupWorkspaceDirectoryIdentity
    : undefined;
  session.riffRepoDirs = undefined;
}

/** Persist cwd and provenance as one session-row mutation, then publish the in-memory/dashboard state. */
export function applySessionWorkingDir(ds: DaemonSession, mutation: SessionWorkingDirMutation): void {
  assertWorkingDirProvenance(mutation);
  const next = { ...ds.session };
  setSessionWorkingDirMetadata(next, mutation);
  sessionStore.updateSession(next);
  Object.assign(ds.session, next);
  ds.workingDir = mutation.workingDir;
  dashboardEventBus.publish({
    type: 'session.update',
    body: {
      sessionId: ds.session.sessionId,
      patch: {
        workingDir: mutation.workingDir,
        workingDirSource: mutation.source,
        groupWorkspaceRevision: mutation.source === 'group' ? mutation.groupWorkspaceRevision : undefined,
      },
    },
  });
}

/**
 * 重钉一个话题会话的工作目录（daemon 记录 = 唯一事实源）：
 * 内存（ds.workingDir / ds.session.workingDir）+ sessions 文件落盘。
 * 注意统一存 resolvedPath（修正 /cd 历史行为：曾存用户原始输入如 "~/x"，
 * 现改为 validateWorkingDir 产出的已展开/已归一化绝对路径）。
 */
export function repinSessionWorkingDir(
  ds: DaemonSession,
  mutation: SessionWorkingDirMutation,
): void {
  applySessionWorkingDir(ds, mutation);
}
