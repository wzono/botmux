import { createHash } from 'node:crypto';
import type { PersistedTurnFeedback, Session } from '../types.js';
import type { TurnFeedbackTarget } from './turn-feedback-reconciler.js';

export interface CapacityReminderDeps {
  read(target: TurnFeedbackTarget): Session;
  commit(target: TurnFeedbackTarget, mutate: (session: Session) => void): void;
  send(target: TurnFeedbackTarget, row: PersistedTurnFeedback, uuid: string): Promise<string>;
  patch(target: TurnFeedbackTarget, row: PersistedTurnFeedback, messageId: string): Promise<
    { kind: 'patched' | 'already_gone' | 'card_mismatch' | 'unavailable' }
  >;
  now(): number;
  thresholds(target: TurnFeedbackTarget): { interactiveMs: number; backgroundMs: number };
}

export const CAPACITY_REMINDER_CLOSE_MAX_ATTEMPTS = 5;

export function createCapacityWaitReminder(deps: CapacityReminderDeps) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const closeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Set<string>();
  const rerunRequested = new Set<string>();
  const closing = new Set<string>();
  const intentFailures = new Map<string, number>();
  const keyFor = (target: TurnFeedbackTarget, turnId: string) =>
    JSON.stringify([target.larkAppId, target.session.sessionId, turnId]);

  function cancel(key: string): void {
    const timer = timers.get(key);
    if (timer) clearTimeout(timer);
    timers.delete(key);
  }

  function closeRetryDelay(attempts: number): number {
    return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempts - 1));
  }

  function scheduleCloseRetry(target: TurnFeedbackTarget, turnId: string, delay: number): void {
    const key = keyFor(target, turnId);
    const prior = closeTimers.get(key);
    if (prior) clearTimeout(prior);
    const timer = setTimeout(() => {
      closeTimers.delete(key);
      void closePublished(target, turnId);
    }, delay);
    timer.unref?.();
    closeTimers.set(key, timer);
  }

  async function closePublished(target: TurnFeedbackTarget, turnId: string): Promise<void> {
    const key = keyFor(target, turnId);
    if (inFlight.has(key)) { rerunRequested.add(key); return; }
    if (closing.has(key)) return;
    const row = deps.read(target).turnFeedback?.[turnId];
    const messageId = row?.reminder?.messageId;
    if (!row || !messageId || row.reminder?.closed) return;
    if (row.phase === 'capacity_waiting' || row.phase === 'capacity_stale') return;
    const reminder = row.reminder!;
    const attempts = reminder.closeAttempts ?? 0;
    if (reminder.closeDiagnostic === 'card_mismatch' && !reminder.closeNextAttemptAt) return;
    if (attempts >= CAPACITY_REMINDER_CLOSE_MAX_ATTEMPTS) return;
    const nextAttemptAt = reminder.closeNextAttemptAt
      ? Date.parse(reminder.closeNextAttemptAt) : undefined;
    if (nextAttemptAt !== undefined && Number.isFinite(nextAttemptAt) && nextAttemptAt > deps.now()) {
      scheduleCloseRetry(target, turnId, nextAttemptAt - deps.now());
      return;
    }
    const currentAttempt = attempts + 1;
    try {
      deps.commit(target, fresh => {
        const current = fresh.turnFeedback?.[turnId];
        if (current?.reminder?.messageId === messageId) {
          current.reminder.closeStatus = 'pending';
          current.reminder.closeAttempts = currentAttempt;
          current.reminder.closeAttemptedAt = new Date(deps.now()).toISOString();
          delete current.reminder.closeNextAttemptAt;
          delete current.reminder.closeDiagnostic;
        }
      });
    } catch {
      const failures = (intentFailures.get(key) ?? 0) + 1;
      intentFailures.set(key, failures);
      if (failures < CAPACITY_REMINDER_CLOSE_MAX_ATTEMPTS) scheduleCloseRetry(target, turnId, closeRetryDelay(failures));
      return;
    }
    intentFailures.delete(key);
    closing.add(key);
    try {
      const outcome = await deps.patch(target, row, messageId);
      if (outcome.kind === 'patched' || outcome.kind === 'already_gone') {
        deps.commit(target, fresh => {
          const current = fresh.turnFeedback?.[turnId];
          if (current?.reminder?.messageId === messageId) {
            current.reminder.closed = true;
            delete current.reminder.closeStatus;
            delete current.reminder.closeAttemptedAt;
            delete current.reminder.closeAttempts;
            delete current.reminder.closeNextAttemptAt;
            delete current.reminder.closeDiagnostic;
          }
        });
      } else {
        throw Object.assign(new Error(`capacity reminder close ${outcome.kind}`), { diagnostic: outcome.kind });
      }
    } catch (error) {
      const diagnostic = (error as { diagnostic?: unknown }).diagnostic === 'card_mismatch'
        ? 'card_mismatch' as const
        : (error as { diagnostic?: unknown }).diagnostic === 'unavailable'
          ? 'unavailable' as const
          : 'transport_error' as const;
      const retryable = diagnostic !== 'card_mismatch'
        && currentAttempt < CAPACITY_REMINDER_CLOSE_MAX_ATTEMPTS;
      const retryAt = retryable ? deps.now() + closeRetryDelay(currentAttempt) : undefined;
      deps.commit(target, fresh => {
        const current = fresh.turnFeedback?.[turnId];
        if (current?.reminder?.messageId === messageId) {
          current.reminder.closeStatus = 'ambiguous';
          current.reminder.closeDiagnostic = diagnostic;
          if (retryAt !== undefined) current.reminder.closeNextAttemptAt = new Date(retryAt).toISOString();
          else delete current.reminder.closeNextAttemptAt;
        }
      });
      const fresh = deps.read(target).turnFeedback?.[turnId];
      if (fresh?.reminder?.messageId === messageId && fresh.reminder.closed !== true
        && fresh.phase !== 'capacity_waiting' && fresh.phase !== 'capacity_stale'
        && retryAt !== undefined) {
        scheduleCloseRetry(target, turnId, Math.max(0, retryAt - deps.now()));
      }
    } finally {
      closing.delete(key);
      const fresh = deps.read(target).turnFeedback?.[turnId]?.reminder;
      if (fresh?.closed !== true && fresh?.closeNextAttemptAt) {
        const retryAt = Date.parse(fresh.closeNextAttemptAt);
        if (Number.isFinite(retryAt)) scheduleCloseRetry(target, turnId, Math.max(0, retryAt - deps.now()));
      }
    }
  }

  async function fire(target: TurnFeedbackTarget, turnId: string): Promise<void> {
    const key = keyFor(target, turnId);
    timers.delete(key);
    const session = deps.read(target);
    const row = session.turnFeedback?.[turnId];
    if (!row
      || (row.phase !== 'capacity_waiting' && row.phase !== 'capacity_stale')
      || (row.capacity?.state !== 'waiting' && row.capacity?.state !== 'stale')) {
      void closePublished(target, turnId);
      return;
    }
    const closeTimer = closeTimers.get(key);
    if (closeTimer) clearTimeout(closeTimer);
    closeTimers.delete(key);
    if (row.reminder?.closeStatus || row.reminder?.closeAttemptedAt) {
      deps.commit(target, fresh => {
        const current = fresh.turnFeedback?.[turnId]?.reminder;
        if (!current) return;
        delete current.closeStatus;
        delete current.closeAttemptedAt;
        delete current.closeAttempts;
        delete current.closeNextAttemptAt;
        delete current.closeDiagnostic;
      });
    }
    if (row.reminderSilent || row.requesterIsBot !== false || !row.requesterOpenId) return;
    const episodeKey = String(row.capacity.startedAtMs);
    if (inFlight.has(key)) { rerunRequested.add(key); return; }
    if (row.reminder?.episodeKey === episodeKey
      && (row.reminder.messageId || row.reminder.status === 'ambiguous')) return;
    const uuid = `capacity-${createHash('sha256').update(`${key}:${episodeKey}`).digest('hex').slice(0, 40)}`;
    deps.commit(target, fresh => {
      const current = fresh.turnFeedback?.[turnId];
      if ((current?.capacity?.state === 'waiting' || current?.capacity?.state === 'stale')
        && String(current.capacity.startedAtMs) === episodeKey) {
        current.reminder = {
          episodeKey, uuid, status: 'pending', attemptedAt: new Date(deps.now()).toISOString(),
        };
      }
    });
    const persisted = deps.read(target).turnFeedback?.[turnId]?.reminder;
    if (persisted?.uuid !== uuid || persisted.status !== 'pending') return;
    inFlight.add(key);
    try {
      const messageId = await deps.send(target, row, uuid);
      deps.commit(target, fresh => {
        const current = fresh.turnFeedback?.[turnId];
        if (current?.reminder?.uuid === uuid) {
          current.reminder = {
            ...current.reminder, messageId, status: 'sent', sentAt: new Date(deps.now()).toISOString(),
          };
        }
      });
    } catch {
      deps.commit(target, fresh => {
        const current = fresh.turnFeedback?.[turnId];
        if (current?.reminder?.uuid === uuid) current.reminder.status = 'ambiguous';
      });
    } finally {
      inFlight.delete(key);
      if (rerunRequested.delete(key)) sync(target, turnId);
    }
  }

  function sync(target: TurnFeedbackTarget, turnId: string): void {
    const key = keyFor(target, turnId);
    cancel(key);
    const session = deps.read(target);
    const row = session.turnFeedback?.[turnId];
    if (!row
      || (row.phase !== 'capacity_waiting' && row.phase !== 'capacity_stale')
      || (row.capacity?.state !== 'waiting' && row.capacity?.state !== 'stale')) {
      void closePublished(target, turnId);
      return;
    }
    if (row.reminderSilent || row.requesterIsBot !== false || !row.requesterOpenId) return;
    const episodeKey = String(row.capacity.startedAtMs);
    if (inFlight.has(key)) { rerunRequested.add(key); return; }
    if (row.reminder?.episodeKey === episodeKey
      && (row.reminder.messageId || row.reminder.status === 'ambiguous')) return;
    const thresholds = deps.thresholds(target);
    const threshold = row.background ? thresholds.backgroundMs : thresholds.interactiveMs;
    const delay = Math.max(0, row.capacity.startedAtMs + threshold - deps.now());
    const timer = setTimeout(() => { void fire(target, turnId); }, delay);
    timer.unref?.();
    timers.set(key, timer);
  }

  function dispose(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    for (const timer of closeTimers.values()) clearTimeout(timer);
    timers.clear();
    closeTimers.clear();
    intentFailures.clear();
  }

  function restore(targets: Iterable<TurnFeedbackTarget>): void {
    for (const target of targets) {
      for (const row of Object.values(deps.read(target).turnFeedback ?? {})) {
        if (row.reminder?.messageId && row.reminder.closed !== true) sync(target, row.turnId);
      }
    }
  }

  return { sync, restore, dispose };
}
