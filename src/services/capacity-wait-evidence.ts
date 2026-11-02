export type CapacityWaitEvidence = {
  kind: 'waiting';
  position?: number;
  observedAtMs: number;
  source: 'pty' | 'structured-event';
};

export type CapacityWaitPhase =
  | {
      state: 'waiting';
      position?: number;
      startedAtMs: number;
      updatedAtMs: number;
      source: CapacityWaitEvidence['source'];
    }
  | {
      state: 'stale';
      startedAtMs: number;
      updatedAtMs: number;
      source: CapacityWaitEvidence['source'];
    }
  | { state: 'cleared'; clearedAtMs: number };

export type CapacityWaitEvent =
  | { type: 'waiting'; evidence: CapacityWaitEvidence }
  | { type: 'stale'; observedAtMs: number; nowMs: number }
  | { type: 'cleared'; observedAtMs: number };

const STALE_AFTER_MS = 60_000;

function normalizedPosition(position: number | undefined): number | undefined {
  return Number.isSafeInteger(position) && position !== undefined && position > 0
    ? position
    : undefined;
}

/** Reduces explicit observations only; silence cannot change the phase. */
export function reduceCapacityWaitPhase(
  phase: CapacityWaitPhase | undefined,
  event: CapacityWaitEvent,
): CapacityWaitPhase | undefined {
  if (event.type === 'waiting') {
    const { observedAtMs, source } = event.evidence;
    const lastObservedAtMs = phase?.state === 'cleared' ? phase.clearedAtMs : phase?.updatedAtMs;
    if (lastObservedAtMs !== undefined && observedAtMs <= lastObservedAtMs) return phase;

    const position = normalizedPosition(event.evidence.position);
    return {
      state: 'waiting',
      startedAtMs: phase && phase.state !== 'cleared' ? phase.startedAtMs : observedAtMs,
      updatedAtMs: observedAtMs,
      source,
      ...(position === undefined ? {} : { position }),
    };
  }

  if (event.type === 'stale') {
    if (phase?.state !== 'waiting') return phase;
    if (phase.updatedAtMs !== event.observedAtMs) return phase;
    if (event.nowMs - event.observedAtMs < STALE_AFTER_MS) return phase;

    return {
      state: 'stale',
      startedAtMs: phase.startedAtMs,
      updatedAtMs: phase.updatedAtMs,
      source: phase.source,
    };
  }

  const lastObservedAtMs = phase?.state === 'cleared' ? phase.clearedAtMs : phase?.updatedAtMs;
  if (lastObservedAtMs !== undefined && event.observedAtMs <= lastObservedAtMs) return phase;
  return { state: 'cleared', clearedAtMs: event.observedAtMs };
}
