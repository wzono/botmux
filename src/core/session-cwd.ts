/**
 * Shared helper for repinning a topic session's working directory.
 * Extracted from the `/cd` command handler so the upcoming dashboard IPC
 * `cd` route (Task 9) can reuse the exact same daemon-record write path.
 */
import { WORKSPACE_SCHEMA_VERSION, type Session, type SessionWorkingDirSource, type WorkspaceIdentity } from '../types.js';
import type { DaemonSession } from './types.js';
import * as sessionStore from '../services/session-store.js';
import { dashboardEventBus } from './dashboard-events.js';

export type SessionWorkingDirMutation =
  | { workingDir: string; source: 'group'; groupWorkspaceRevision: number; groupWorkspaceIdentity: WorkspaceIdentity }
  | { workingDir: string; source: Exclude<SessionWorkingDirSource, 'group'>; groupWorkspaceRevision?: never; groupWorkspaceDirectoryIdentity?: never };

export type GroupWorkspaceFollowJournal = NonNullable<Session['groupWorkspaceFollow']>;

type FollowSession = Session;

export interface GroupWorkspaceFollowDeps {
  isIdle(ds: DaemonSession): boolean;
  supportsReplacement(ds: DaemonSession): boolean;
  isWorkerLive(ds: DaemonSession): boolean;
  persist(input: ({ journal?: GroupWorkspaceFollowJournal; phase?: 'complete' | GroupWorkspaceFollowJournal['phase'] }
    & Partial<SessionWorkingDirMutation> & { workerGeneration?: number; expectedJournalRevision: number | null })): boolean;
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

const runningGroupWorkspaceFollows = new WeakSet<object>();

type GroupWorkspaceReadForFollow =
  | { status: 'store_unavailable' }
  | { status: 'available'; record?: {
    revision: number;
    directory: { kind: 'unbound' } | { kind: 'bound'; workingDir: string };
    workspaceIdentity?: WorkspaceIdentity;
  } };

export type GroupWorkspaceFollowTargetResolution =
  | { kind: 'continue' }
  | { kind: 'store_unavailable' }
  | { kind: 'follow'; target: { workingDir: string; revision: number; workspaceIdentity?: WorkspaceIdentity } };

/**
 * Once a follow journal exists, its target is frozen durable intent. A later
 * group unbind changes only new-session selection; it cannot make recovery
 * admit a turn while the persisted session is workerless or still on old cwd.
 */
export function resolveGroupWorkspaceFollowTarget(input: {
  journal?: GroupWorkspaceFollowJournal;
  group: GroupWorkspaceReadForFollow;
  currentRevision?: number;
}): GroupWorkspaceFollowTargetResolution {
  if (input.journal) {
    return { kind: 'follow', target: {
      workingDir: input.journal.targetWorkingDir,
      revision: input.journal.targetRevision,
      workspaceIdentity: input.journal.targetWorkspaceIdentity!,
    } };
  }
  if (input.group.status === 'store_unavailable') return { kind: 'store_unavailable' };
  const record = input.group.record;
  if (!record || record.directory.kind !== 'bound'
      || record.revision <= (input.currentRevision ?? -1)) return { kind: 'continue' };
  return { kind: 'follow', target: {
    workingDir: record.directory.workingDir,
    revision: record.revision,
    workspaceIdentity: record.workspaceIdentity,
  } };
}

/** Crash-resumable replacement at an admitted business-turn boundary. */
export async function runGroupWorkspaceSessionFollow(
  ds: DaemonSession,
  target: { workingDir: string; revision: number; workspaceIdentity: WorkspaceIdentity },
  deps: GroupWorkspaceFollowDeps,
): Promise<GroupWorkspaceFollowResult> {
  const session = ds.session as FollowSession;
  if (ds.scope !== 'chat' || session.workingDirSource !== 'group') return { kind: 'unchanged' };
  if (!session.groupWorkspaceFollow
      && session.groupWorkspaceRevision === target.revision
      && session.workingDir === target.workingDir) return { kind: 'unchanged' };
  // A dormant local session has no live generation to protect from replacement.
  // It can durably adopt the newer binding and spawn the blank replacement now;
  // only a live worker must prove the ordinary idle boundary first.
  if (!session.groupWorkspaceFollow && deps.isWorkerLive(ds) && !deps.isIdle(ds)) return { kind: 'deferred' };
  let notified = false;
  const fail = (error: unknown): GroupWorkspaceFollowResult => {
    if (!notified) { notified = true; deps.notice('failed'); }
    return { kind: 'failed', error: error instanceof Error ? error.message : String(error) };
  };
  if (ds.adoptedFrom || !deps.supportsReplacement(ds)) return fail('worker replacement unsupported');
  if (runningGroupWorkspaceFollows.has(session)) return { kind: 'deferred' };
  runningGroupWorkspaceFollows.add(session);

  const previousGeneration = session.workerGeneration ?? 0;
  let journal: GroupWorkspaceFollowJournal = session.groupWorkspaceFollow?.targetWorkingDir === target.workingDir
    && session.groupWorkspaceFollow.targetRevision === target.revision
    ? session.groupWorkspaceFollow
    : { schemaVersion: WORKSPACE_SCHEMA_VERSION, journalRevision: 0,
        targetWorkingDir: target.workingDir, targetRevision: target.revision,
        targetWorkspaceIdentity: target.workspaceIdentity,
        targetDirectoryIdentity: { dev: target.workspaceIdentity.dev, ino: target.workspaceIdentity.ino },
        previousRevision: session.groupWorkspaceRevision ?? -1,
        previousGeneration, nextGeneration: previousGeneration + 1, phase: 'prepared' };
  try {
    if (!session.groupWorkspaceFollow
        && !deps.persist({ journal, phase: journal.phase, expectedJournalRevision: null })) return { kind: 'deferred' };
    if (journal.phase === 'prepared') {
      if (!await deps.retire(ds)) return fail('old worker retirement unverified');
      if (session.workingDirSource !== 'group'
          || session.groupWorkspaceRevision !== journal.previousRevision
          || (session.workerGeneration ?? 0) !== journal.previousGeneration) {
        return fail('session changed during worker replacement');
      }
      const next = { ...journal, journalRevision: journal.journalRevision! + 1, phase: 'old_exited' as const };
      if (!deps.persist({ journal: next, phase: next.phase,
        expectedJournalRevision: journal.journalRevision! })) return { kind: 'deferred' };
      journal = next;
    }
    if (journal.phase === 'old_exited') {
      const next = { ...journal, journalRevision: journal.journalRevision! + 1, phase: 'persisted' as const };
      if (!deps.persist({ workingDir: target.workingDir, source: 'group',
        groupWorkspaceRevision: target.revision,
        groupWorkspaceIdentity: journal.targetWorkspaceIdentity!,
        journal: next, expectedJournalRevision: journal.journalRevision! })) return { kind: 'deferred' };
      setSessionWorkingDirMetadata(session, { workingDir: target.workingDir, source: 'group',
        groupWorkspaceRevision: target.revision,
        groupWorkspaceIdentity: journal.targetWorkspaceIdentity! });
      ds.workingDir = target.workingDir;
      journal = next;
    }
    // A crash may happen after forkWorker durably reserves the generation but
    // before this journal reaches `spawned`. Reconcile that exact reservation
    // before any new spawn; otherwise forkWorker would reserve N+1 and start it
    // before the mismatch became visible.
    if (journal.phase === 'persisted'
        && (session.workerGeneration ?? 0) === journal.nextGeneration) {
      const next = { ...journal, journalRevision: journal.journalRevision! + 1, phase: 'spawned' as const };
      if (!deps.persist({ journal: next, phase: next.phase,
        expectedJournalRevision: journal.journalRevision! })) return { kind: 'deferred' };
      journal = next;
    }
    if (journal.phase === 'spawned' && !deps.isWorkerLive(ds)) {
      // The replacement was durably spawned by the prior daemon, but no process
      // survived this boot. Rebase the reservation onto one fresh generation;
      // persisting `persisted` first makes a second crash repeat this exact step,
      // never overlap the vanished generation.
      const previousGeneration = Math.max(session.workerGeneration ?? 0, journal.nextGeneration);
      const next = { ...journal, journalRevision: journal.journalRevision! + 1,
        previousGeneration, nextGeneration: previousGeneration + 1, phase: 'persisted' as const };
      if (!deps.persist({ journal: next, phase: next.phase,
        expectedJournalRevision: journal.journalRevision! })) return { kind: 'deferred' };
      journal = next;
    }
    if (journal.phase === 'persisted') {
      let reservedGeneration: number | undefined;
      if (!deps.spawn(ds, generation => { reservedGeneration = generation; })) return fail('replacement worker spawn refused');
      if (reservedGeneration !== journal.nextGeneration) return fail('replacement worker generation mismatch');
      const next = { ...journal, journalRevision: journal.journalRevision! + 1, phase: 'spawned' as const };
      if (!deps.persist({ journal: next, phase: next.phase,
        expectedJournalRevision: journal.journalRevision! })) return { kind: 'deferred' };
      journal = next;
    }
    const ready = await deps.awaitReady(ds);
    if (!ready.ready) return fail('replacement worker not ready');
    if (ready.workingDir !== target.workingDir) return fail('replacement worker cwd mismatch');
    if (!deps.persist({ journal: undefined, phase: 'complete',
      expectedJournalRevision: journal.journalRevision! })) return { kind: 'deferred' };
    session.groupWorkspaceFollow = undefined;
    deps.notice('migrated');
    return { kind: 'migrated' };
  } catch (error) {
    return fail(error);
  } finally {
    runningGroupWorkspaceFollows.delete(session);
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

export function assertGroupWorkspaceSessionExecutable(session: Session): void {
  if (session.groupWorkspaceQuarantine?.kind === 'known_group_identity_unprovable') {
    throw new Error('known_group_identity_unprovable');
  }
}

export function repairKnownGroupWorkspaceSession(input: {
  session: Session;
  authorized: boolean;
  operationId: string;
  currentRevision: number;
  currentIdentity: WorkspaceIdentity;
}): { status: 'repaired'; supersedingEvent: { operationId: string; prior: NonNullable<Session['groupWorkspaceQuarantine']> } }
  | { status: 'unauthorized' | 'not_quarantined' | 'proof_mismatch' } {
  const prior = input.session.groupWorkspaceQuarantine;
  if (!prior) return { status: 'not_quarantined' };
  if (!input.authorized) return { status: 'unauthorized' };
  if (input.session.workingDir !== input.currentIdentity.path
    || input.currentRevision < 0 || !input.operationId.trim()) return { status: 'proof_mismatch' };
  input.session.workspaceSchemaVersion = WORKSPACE_SCHEMA_VERSION;
  input.session.workingDirSource = 'group';
  input.session.groupWorkspaceRevision = input.currentRevision;
  input.session.groupWorkspaceIdentity = structuredClone(input.currentIdentity);
  input.session.groupWorkspaceDirectoryIdentity = { dev: input.currentIdentity.dev, ino: input.currentIdentity.ino };
  delete input.session.groupWorkspaceQuarantine;
  return { status: 'repaired', supersedingEvent: { operationId: input.operationId, prior: structuredClone(prior) } };
}

export function setSessionWorkingDirMetadata(session: Session, mutation: SessionWorkingDirMutation): void {
  assertWorkingDirProvenance(mutation);
  session.workingDir = mutation.workingDir;
  session.workingDirSource = mutation.source;
  session.groupWorkspaceRevision = mutation.source === 'group' ? mutation.groupWorkspaceRevision : undefined;
  session.workspaceSchemaVersion = mutation.source === 'group' ? WORKSPACE_SCHEMA_VERSION : undefined;
  session.groupWorkspaceIdentity = mutation.source === 'group' ? mutation.groupWorkspaceIdentity : undefined;
  session.groupWorkspaceDirectoryIdentity = mutation.source === 'group'
    ? { dev: mutation.groupWorkspaceIdentity.dev, ino: mutation.groupWorkspaceIdentity.ino }
    : undefined;
  session.riffRepoDirs = undefined;
}

export function proveGroupWorkspaceSessionReplacement(input: {
  current: DaemonSession | undefined;
  larkAppId: string;
  chatId: string;
  previousSessionId: string;
  previousGeneration: number;
  ownerOpenId?: string;
  targetWorkingDir: string;
  workspaceIdentity: WorkspaceIdentity;
  observedWorkspaceIdentity?: WorkspaceIdentity;
}): { status: 'committed'; generation: number } | { status: 'unknown' } {
  const current = input.current;
  const generation = current?.workerGeneration ?? current?.session.workerGeneration ?? 0;
  const identity = current?.session.groupWorkspaceIdentity ?? input.observedWorkspaceIdentity;
  if (!current
    || current.larkAppId !== input.larkAppId
    || current.chatId !== input.chatId
    || current.session.sessionId === input.previousSessionId
    || current.session.ownerOpenId !== input.ownerOpenId
    || generation !== input.previousGeneration + 1
    || current.session.workingDir !== input.targetWorkingDir
    || !identity
    || identity.path !== input.workspaceIdentity.path
    || identity.dev !== input.workspaceIdentity.dev
    || identity.ino !== input.workspaceIdentity.ino) return { status: 'unknown' };
  return { status: 'committed', generation };
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
