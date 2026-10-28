import { createHash } from 'node:crypto';
import type { PersistedTurnFeedback, Session } from '../types.js';
import type { TurnFeedbackTarget } from './turn-feedback-reconciler.js';

export interface CapacityReminderDeps {
  read(target: TurnFeedbackTarget): Session;
  commit(target: TurnFeedbackTarget, mutate: (session: Session) => void): void;
  send(target: TurnFeedbackTarget, row: PersistedTurnFeedback, uuid: string): Promise<string>;
  patch(target: TurnFeedbackTarget, row: PersistedTurnFeedback, messageId: string): Promise<void>;
  now(): number;
  thresholds(target: TurnFeedbackTarget): { interactiveMs: number; backgroundMs: number };
}

export function createCapacityWaitReminder(deps: CapacityReminderDeps) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const closeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Set<string>();
  const rerunRequested = new Set<string>();
  const closing = new Set<string>();
  const keyFor = (target: TurnFeedbackTarget, turnId: string) =>
    JSON.stringify([target.larkAppId, target.session.sessionId, turnId]);

  function cancel(key: string): void {
    const timer = timers.get(key);
    if (timer) clearTimeout(timer);
    timers.delete(key);
  }

  async function closePublished(target: TurnFeedbackTarget, turnId: string): Promise<void> {
    const key = keyFor(target, turnId);
    if (inFlight.has(key)) { rerunRequested.add(key); return; }
    if (closing.has(key)) return;
    const row = deps.read(target).turnFeedback?.[turnId];
    const messageId = row?.reminder?.messageId;
    if (!row || !messageId || row.reminder?.closed) return;
    if (row.phase === 'capacity_waiting' || row.phase === 'capacity_stale') return;
    deps.commit(target, fresh => {
      const current = fresh.turnFeedback?.[turnId];
      if (current?.reminder?.messageId === messageId) {
        current.reminder.closeStatus = 'pending';
        current.reminder.closeAttemptedAt = new Date(deps.now()).toISOString();
      }
    });
    closing.add(key);
    try {
      await deps.patch(target, row, messageId);
      deps.commit(target, fresh => {
        const current = fresh.turnFeedback?.[turnId];
        if (current?.reminder?.messageId === messageId) {
          current.reminder.closed = true;
          delete current.reminder.closeStatus;
          delete current.reminder.closeAttemptedAt;
        }
      });
    } catch {
      deps.commit(target, fresh => {
        const current = fresh.turnFeedback?.[turnId];
        if (current?.reminder?.messageId === messageId) current.reminder.closeStatus = 'ambiguous';
      });
      const fresh = deps.read(target).turnFeedback?.[turnId];
      if (fresh?.reminder?.messageId === messageId && fresh.reminder.closed !== true
        && fresh.phase !== 'capacity_waiting' && fresh.phase !== 'capacity_stale'
        && !closeTimers.has(key)) {
        const timer = setTimeout(() => {
          closeTimers.delete(key);
          void closePublished(target, turnId);
        }, 1_000);
        timer.unref?.();
        closeTimers.set(key, timer);
      }
    } finally {
      closing.delete(key);
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
