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

export type GroupWorkspaceFollowJournal = NonNullable<Session['groupWorkspaceFollow']>;

type FollowSession = Session;

export interface GroupWorkspaceFollowDeps {
  isIdle(ds: DaemonSession): boolean;
  supportsReplacement(ds: DaemonSession): boolean;
  isWorkerLive(ds: DaemonSession): boolean;
  persist(input: ({ journal?: GroupWorkspaceFollowJournal; phase?: 'complete' | GroupWorkspaceFollowJournal['phase'] }
    & Partial<SessionWorkingDirMutation> & { workerGeneration?: number })): void;
  /** Retire the exact old local worker and its PTY/persistent backing, then prove exit. */
  retire(ds: DaemonSession): Promise<boolean>;
  spawn(ds: DaemonSession, onGenerationReserved: (generation: number) => void): boolean;
  awaitReady(ds: DaemonSession): Promise<{ ready: boolean; workingDir?: string }>;
  notice(kind: 'migrated' | 'failed'): void;
}

export type GroupWorkspaceFollowResult =
  | { kind: 'unchanged' }
  | { kind: 'deferred' }
  | { kind: 'migrated' }
  | { kind: 'failed'; error: string };

/** Crash-resumable replacement at an admitted business-turn boundary. */
export async function runGroupWorkspaceSessionFollow(
  ds: DaemonSession,
  target: { workingDir: string; revision: number; directoryIdentity?: { dev: string; ino: string } },
  deps: GroupWorkspaceFollowDeps,
): Promise<GroupWorkspaceFollowResult> {
  const session = ds.session as FollowSession;
  if (ds.scope !== 'chat' || session.workingDirSource !== 'group') return { kind: 'unchanged' };
  if (!session.groupWorkspaceFollow
      && session.groupWorkspaceRevision === target.revision
      && session.workingDir === target.workingDir) return { kind: 'unchanged' };
  if (!session.groupWorkspaceFollow && !deps.isIdle(ds)) return { kind: 'deferred' };
  let notified = false;
  const fail = (error: unknown): GroupWorkspaceFollowResult => {
    if (!notified) { notified = true; deps.notice('failed'); }
    return { kind: 'failed', error: error instanceof Error ? error.message : String(error) };
  };
  if (ds.adoptedFrom || !deps.supportsReplacement(ds)) return fail('worker replacement unsupported');

  const previousGeneration = session.workerGeneration ?? 0;
  const journal: GroupWorkspaceFollowJournal = session.groupWorkspaceFollow?.targetWorkingDir === target.workingDir
    && session.groupWorkspaceFollow.targetRevision === target.revision
    ? session.groupWorkspaceFollow
    : { targetWorkingDir: target.workingDir, targetRevision: target.revision,
        targetDirectoryIdentity: target.directoryIdentity,
        previousRevision: session.groupWorkspaceRevision ?? -1,
        previousGeneration, nextGeneration: previousGeneration + 1, phase: 'prepared' };
  try {
    if (!session.groupWorkspaceFollow) deps.persist({ journal, phase: journal.phase });
    if (journal.phase === 'prepared') {
      if (!await deps.retire(ds)) return fail('old worker retirement unverified');
      if (session.workingDirSource !== 'group'
          || session.groupWorkspaceRevision !== journal.previousRevision
          || (session.workerGeneration ?? 0) !== journal.previousGeneration) {
        return fail('session changed during worker replacement');
      }
      journal.phase = 'old_exited';
      deps.persist({ journal, phase: journal.phase });
    }
    if (journal.phase === 'old_exited') {
      deps.persist({ workingDir: target.workingDir, source: 'group',
        groupWorkspaceRevision: target.revision,
        groupWorkspaceDirectoryIdentity: journal.targetDirectoryIdentity,
        journal: { ...journal, phase: 'persisted' } });
      setSessionWorkingDirMetadata(session, { workingDir: target.workingDir, source: 'group',
        groupWorkspaceRevision: target.revision,
        groupWorkspaceDirectoryIdentity: journal.targetDirectoryIdentity });
      ds.workingDir = target.workingDir;
      journal.phase = 'persisted';
    }
    // A crash may happen after forkWorker durably reserves the generation but
    // before this journal reaches `spawned`. Reconcile that exact reservation
    // before any new spawn; otherwise forkWorker would reserve N+1 and start it
    // before the mismatch became visible.
    if (journal.phase === 'persisted'
        && (session.workerGeneration ?? 0) === journal.nextGeneration) {
      journal.phase = 'spawned';
      deps.persist({ journal, phase: journal.phase });
    }
    if (journal.phase === 'spawned' && !deps.isWorkerLive(ds)) {
      // The replacement was durably spawned by the prior daemon, but no process
      // survived this boot. Rebase the reservation onto one fresh generation;
      // persisting `persisted` first makes a second crash repeat this exact step,
      // never overlap the vanished generation.
      journal.previousGeneration = Math.max(session.workerGeneration ?? 0, journal.nextGeneration);
      journal.nextGeneration = journal.previousGeneration + 1;
      journal.phase = 'persisted';
      deps.persist({ journal, phase: journal.phase });
    }
    if (journal.phase === 'persisted') {
      let reservedGeneration: number | undefined;
      if (!deps.spawn(ds, generation => { reservedGeneration = generation; })) return fail('replacement worker spawn refused');
      if (reservedGeneration !== journal.nextGeneration) return fail('replacement worker generation mismatch');
      journal.phase = 'spawned';
      deps.persist({ journal, phase: journal.phase });
    }
    const ready = await deps.awaitReady(ds);
    if (!ready.ready) return fail('replacement worker not ready');
    if (ready.workingDir !== target.workingDir) return fail('replacement worker cwd mismatch');
    deps.persist({ journal: undefined, phase: 'complete' });
    session.groupWorkspaceFollow = undefined;
    deps.notice('migrated');
    return { kind: 'migrated' };
  } catch (error) {
    return fail(error);
  }
}

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
