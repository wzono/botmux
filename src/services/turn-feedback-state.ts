import {
  reduceCapacityWaitPhase,
  type CapacityWaitEvent,
  type CapacityWaitPhase,
} from './capacity-wait-evidence.js';

export type TurnFeedbackPhase =
  | 'processing'
  | 'capacity_waiting'
  | 'capacity_stale'
  | 'needs_user'
  | 'completed'
  | 'failed';

export interface TurnFeedbackState {
  phase: TurnFeedbackPhase;
  updatedAtMs: number;
  capacity?: CapacityWaitPhase;
}

export type TurnFeedbackEvent =
  | CapacityWaitEvent
  | { type: 'progress'; observedAtMs: number }
  | { type: 'resume'; observedAtMs: number }
  | { type: 'user_resumed'; observedAtMs: number }
  | { type: 'needs_user'; observedAtMs: number }
  | { type: 'completed'; observedAtMs: number }
  | { type: 'failed'; observedAtMs: number };

export function reactionForPhase(phase: TurnFeedbackPhase): string {
  return {
    processing: 'GoGoGo',
    capacity_waiting: 'Coffee',
    capacity_stale: 'Coffee',
    needs_user: 'THINKING',
    completed: 'DONE',
    failed: 'ERROR',
  }[phase];
}

function phaseFromCapacity(state: TurnFeedbackState): TurnFeedbackPhase {
  if (state.phase === 'completed' || state.phase === 'failed' || state.phase === 'needs_user') {
    return state.phase;
  }
  if (state.capacity?.state === 'waiting') return 'capacity_waiting';
  if (state.capacity?.state === 'stale') return 'capacity_stale';
  return 'processing';
}

export function reduceTurnFeedback(
  state: TurnFeedbackState,
  event: TurnFeedbackEvent,
): TurnFeedbackState {
  if (state.phase === 'completed' || state.phase === 'failed') return state;

  if (event.type === 'completed' || event.type === 'failed') {
    return {
      phase: event.type,
      updatedAtMs: Math.max(state.updatedAtMs, event.observedAtMs),
    };
  }

  if (event.type === 'needs_user') {
    if (event.observedAtMs < state.updatedAtMs) return state;
    return { ...state, phase: 'needs_user', updatedAtMs: event.observedAtMs };
  }

  if (event.type === 'progress' || event.type === 'resume') {
    if (event.observedAtMs < state.updatedAtMs) return state;
    return {
      ...state,
      phase: 'processing',
      updatedAtMs: event.observedAtMs,
      capacity: { state: 'cleared', clearedAtMs: event.observedAtMs },
    };
  }

  if (event.type === 'user_resumed') {
    if (event.observedAtMs < state.updatedAtMs) return state;
    const next = { ...state, phase: 'processing' as const, updatedAtMs: event.observedAtMs };
    return { ...next, phase: phaseFromCapacity(next) };
  }

  const eventAtMs = event.type === 'waiting'
    ? event.evidence.observedAtMs
    : event.type === 'stale'
      ? event.nowMs
      : event.observedAtMs;
  if (eventAtMs < state.updatedAtMs) return state;

  const capacity = reduceCapacityWaitPhase(state.capacity, event);
  if (capacity === state.capacity) return state;

  const next = { ...state, capacity, updatedAtMs: eventAtMs };
  return { ...next, phase: phaseFromCapacity(next) };
}
