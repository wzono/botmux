import type { WorkerToDaemon } from '../types.js';

export type ScheduledTurnRunErrorCode =
  | 'dispatch_rejected'
  | 'input_rejected'
  | 'turn_failed'
  | 'worker_exit'
  | 'abandoned';

export class ScheduledTurnRunError extends Error {
  constructor(readonly code: ScheduledTurnRunErrorCode, message: string) {
    super(message);
    this.name = 'ScheduledTurnRunError';
  }
}

type Terminal = Pick<
  Extract<WorkerToDaemon, { type: 'turn_terminal' }>,
  'turnId' | 'status' | 'errorCode'
> & { sessionId: string; workerGeneration: number };

export interface ScheduledTurnRun {
  readonly sessionId: string;
  readonly turnId: string;
  readonly promise: Promise<void>;
  acceptInput(sessionId: string, turnId: string, workerGeneration: number): boolean;
  rejectInput(sessionId: string, turnId: string, reason: string): boolean;
  settleTerminal(terminal: Terminal): boolean;
  rejectWorkerExit(sessionId: string, workerGeneration: number): boolean;
  abandon(sessionId: string, turnId: string, reason: string): boolean;
  cancelDispatch(error: ScheduledTurnRunError): void;
}

export function createScheduledTurnRun(sessionId: string, turnId: string): ScheduledTurnRun {
  let workerGeneration: number | undefined;
  let settled = false;
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  // Dispatch may be cancelled before the caller reaches its await.
  void promise.catch(() => undefined);

  const finish = (error?: Error): boolean => {
    if (settled) return false;
    settled = true;
    if (error) reject(error);
    else resolve();
    return true;
  };
  const matchesTurn = (candidateSessionId: string, candidateTurnId: string): boolean =>
    candidateSessionId === sessionId && candidateTurnId === turnId;

  return {
    sessionId,
    turnId,
    promise,
    acceptInput(candidateSessionId, candidateTurnId, generation) {
      if (settled || !matchesTurn(candidateSessionId, candidateTurnId)) return false;
      if (!Number.isSafeInteger(generation) || generation <= 0) {
        throw new RangeError('workerGeneration must be a positive integer');
      }
      if (workerGeneration !== undefined) return workerGeneration === generation;
      workerGeneration = generation;
      return true;
    },
    rejectInput(candidateSessionId, candidateTurnId, reason) {
      if (!matchesTurn(candidateSessionId, candidateTurnId)) return false;
      return finish(new ScheduledTurnRunError(
        'input_rejected',
        `scheduled turn input rejected: ${reason}`,
      ));
    },
    settleTerminal(terminal) {
      if (!matchesTurn(terminal.sessionId, terminal.turnId)
        || workerGeneration !== terminal.workerGeneration) return false;
      return terminal.status === 'completed'
        ? finish()
        : finish(new ScheduledTurnRunError(
            'turn_failed',
            `scheduled turn ${terminal.status}: ${terminal.errorCode ?? terminal.turnId}`,
          ));
    },
    rejectWorkerExit(candidateSessionId, generation) {
      if (candidateSessionId !== sessionId
        || workerGeneration === undefined
        || workerGeneration !== generation) return false;
      return finish(new ScheduledTurnRunError(
        'worker_exit',
        `scheduled turn worker exited before terminal: ${turnId}`,
      ));
    },
    abandon(candidateSessionId, candidateTurnId, reason) {
      if (!matchesTurn(candidateSessionId, candidateTurnId)) return false;
      return finish(new ScheduledTurnRunError(
        'abandoned',
        `scheduled turn abandoned: ${reason}`,
      ));
    },
    cancelDispatch(error) {
      finish(error);
    },
  };
}
