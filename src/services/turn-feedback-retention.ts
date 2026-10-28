import type { PersistedTurnFeedback } from '../types.js';
import { desiredReaction, type TurnReactionPolicy } from './turn-feedback-reaction.js';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const SETTLED_MAX = 512;
const DIAGNOSTIC_MAX = 128;

function terminal(record: PersistedTurnFeedback): boolean {
  return record.phase === 'completed' || record.phase === 'failed';
}

function reactionDiagnostic(record: PersistedTurnFeedback): boolean {
  const intent = record.reactionIntent;
  return intent?.stage === 'permanent' && intent.diagnostic !== undefined
    || intent?.stage === 'blocked' && intent.retryExhausted === true;
}

function reminderDiagnostic(record: PersistedTurnFeedback): boolean {
  const reminder = record.reminder;
  return reminder?.closed !== true && !reminder?.closeNextAttemptAt && (
    reminder?.closeDiagnostic === 'card_mismatch'
    || reminder?.closeAttempts === 5 && (reminder.closeDiagnostic === 'unavailable'
      || reminder.closeDiagnostic === 'transport_error')
  );
}

function unresolved(
  record: PersistedTurnFeedback,
  policy: TurnReactionPolicy,
): boolean {
  if (record.reactionIntent) return !reactionDiagnostic(record);
  if (record.attention || record.capacity || record.capacityClearedAt
    || record.capacitySidebandCursor || record.capacityBinding) return true;
  if (record.reminder && record.reminder.closed !== true && !reminderDiagnostic(record)) return true;
  return record.reaction !== undefined
    && record.reaction.type !== desiredReaction(record, policy);
}

type Entry = [string, PersistedTurnFeedback, number];

function newest(left: Entry, right: Entry): number {
  return right[2] - left[2] || left[0].localeCompare(right[0]);
}

export function pruneTurnFeedback(
  records: Readonly<Record<string, PersistedTurnFeedback>>,
  nowMs: number,
  policy: TurnReactionPolicy,
): Record<string, PersistedTurnFeedback> {
  const kept = new Map<string, PersistedTurnFeedback>();
  const settled: Entry[] = [];
  const diagnostics: Entry[] = [];

  for (const [turnId, record] of Object.entries(records)) {
    const updatedAtMs = Date.parse(record.updatedAt);
    if (!terminal(record) || !Number.isFinite(updatedAtMs) || updatedAtMs > nowMs) {
      kept.set(turnId, record);
      continue;
    }
    if (unresolved(record, policy)) {
      kept.set(turnId, record);
      continue;
    }
    if (reactionDiagnostic(record) || reminderDiagnostic(record)) {
      diagnostics.push([turnId, record, updatedAtMs]);
      continue;
    }
    settled.push([turnId, record, updatedAtMs]);
  }

  for (const [turnId, record] of settled
    .filter(([, , updatedAtMs]) => updatedAtMs >= nowMs - RETENTION_MS)
    .sort(newest)
    .slice(0, SETTLED_MAX)) {
    kept.set(turnId, record);
  }
  for (const [turnId, record] of diagnostics
    .filter(([, , updatedAtMs]) => updatedAtMs >= nowMs - RETENTION_MS)
    .sort(newest)
    .slice(0, DIAGNOSTIC_MAX)) {
    kept.set(turnId, record);
  }

  return Object.fromEntries(kept);
}
