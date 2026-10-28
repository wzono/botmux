import { createHash } from 'node:crypto';
import type { PersistedTurnFeedback, Session } from '../types.js';
import type { TurnFeedbackTarget } from './turn-feedback-reconciler.js';

export interface CapacityReminderDeps {
  read(target: TurnFeedbackTarget): Session;
  commit(mutate: (session: Session) => void): void;
  send(target: TurnFeedbackTarget, row: PersistedTurnFeedback, uuid: string): Promise<string>;
  now(): number;
  thresholds: { interactiveMs: number; backgroundMs: number };
}

export function createCapacityWaitReminder(deps: CapacityReminderDeps) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const keyFor = (target: TurnFeedbackTarget, turnId: string) =>
    JSON.stringify([target.larkAppId, target.session.sessionId, turnId]);

  function cancel(key: string): void {
    const timer = timers.get(key);
    if (timer) clearTimeout(timer);
    timers.delete(key);
  }

  async function fire(target: TurnFeedbackTarget, turnId: string): Promise<void> {
    const key = keyFor(target, turnId);
    timers.delete(key);
    const session = deps.read(target);
    const row = session.turnFeedback?.[turnId];
    if (!row || row.silent || row.requesterIsBot !== false || !row.requesterOpenId
      || row.phase !== 'capacity_waiting' || row.capacity?.state !== 'waiting') return;
    const episodeKey = String(row.capacity.startedAtMs);
    if (row.reminder?.episodeKey === episodeKey
      && (row.reminder.messageId || row.reminder.status === 'ambiguous')) return;
    const uuid = `capacity-${createHash('sha256').update(`${key}:${episodeKey}`).digest('hex').slice(0, 40)}`;
    deps.commit(fresh => {
      const current = fresh.turnFeedback?.[turnId];
      if (current?.capacity?.state === 'waiting'
        && String(current.capacity.startedAtMs) === episodeKey) {
        current.reminder = {
          episodeKey, uuid, status: 'pending', attemptedAt: new Date(deps.now()).toISOString(),
        };
      }
    });
    try {
      const messageId = await deps.send(target, row, uuid);
      deps.commit(fresh => {
        const current = fresh.turnFeedback?.[turnId];
        if (current?.reminder?.uuid === uuid) {
          current.reminder = {
            ...current.reminder, messageId, status: 'sent', sentAt: new Date(deps.now()).toISOString(),
          };
        }
      });
    } catch {
      deps.commit(fresh => {
        const current = fresh.turnFeedback?.[turnId];
        if (current?.reminder?.uuid === uuid) current.reminder.status = 'ambiguous';
      });
    }
  }

  function sync(target: TurnFeedbackTarget, turnId: string): void {
    const key = keyFor(target, turnId);
    cancel(key);
    const session = deps.read(target);
    const row = session.turnFeedback?.[turnId];
    if (!row || row.silent || row.requesterIsBot !== false || !row.requesterOpenId
      || row.phase !== 'capacity_waiting' || row.capacity?.state !== 'waiting') return;
    const episodeKey = String(row.capacity.startedAtMs);
    if (row.reminder?.episodeKey === episodeKey
      && (row.reminder.messageId || row.reminder.status === 'ambiguous')) return;
    const threshold = row.background ? deps.thresholds.backgroundMs : deps.thresholds.interactiveMs;
    const delay = Math.max(0, row.capacity.startedAtMs + threshold - deps.now());
    const timer = setTimeout(() => { void fire(target, turnId); }, delay);
    timer.unref?.();
    timers.set(key, timer);
  }

  function dispose(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  return { sync, dispose };
}
