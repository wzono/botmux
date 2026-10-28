import { traexCapacityQueuePosition, traexCapacityQueueVisible } from '../adapters/cli/traex.js';

export interface CapacityCaptureIdentity {
  sessionId: string;
  turnId: string;
  dispatchAttempt?: number;
  revision: number;
}

export interface CapacityWaitObservation {
  type: 'waiting' | 'clear';
  identity: CapacityCaptureIdentity;
  position?: number;
  observedAtMs: number;
}

export function extractTraexLiveCapacityStatus(
  screen: string,
): { state: 'waiting'; position?: number } | null {
  if (!traexCapacityQueueVisible(screen)) return null;
  const position = traexCapacityQueuePosition(screen);
  return { state: 'waiting', ...(position !== undefined ? { position } : {}) };
}

function sameIdentity(left: CapacityCaptureIdentity, right: CapacityCaptureIdentity): boolean {
  return left.sessionId === right.sessionId
    && left.turnId === right.turnId
    && left.dispatchAttempt === right.dispatchAttempt
    && left.revision === right.revision;
}

export function createCapacityWaitTracker() {
  let current: { identity: CapacityCaptureIdentity; position?: number } | undefined;
  return {
    observe(
      captured: CapacityCaptureIdentity,
      currentIdentity: CapacityCaptureIdentity,
      screen: string,
      observedAtMs: number,
    ): CapacityWaitObservation | null {
      if (!sameIdentity(captured, currentIdentity)) return null;
      const status = extractTraexLiveCapacityStatus(screen);
      if (status) {
        if (current && sameIdentity(current.identity, captured) && current.position === status.position) {
          return null;
        }
        current = { identity: { ...captured }, ...(status.position !== undefined ? { position: status.position } : {}) };
        return {
          type: 'waiting', identity: { ...captured }, observedAtMs,
          ...(status.position !== undefined ? { position: status.position } : {}),
        };
      }
      if (!screen || !/^[ \t]*[⋄✧◇✦❖◈◆][^\r\n]*\b(?:Working|Thinking|Generating|Reading|Running|Searching)\b/im.test(screen) || !current
        || !sameIdentity(current.identity, captured)) return null;
      current = undefined;
      return { type: 'clear', identity: { ...captured }, observedAtMs };
    },
  };
}
