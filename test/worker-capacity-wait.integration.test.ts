import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createCapacityWaitTracker } from '../src/services/worker-capacity-wait.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const queued = readFileSync(
  join(process.cwd(), 'test/fixtures/capacity-wait/traex-current.txt'),
  'utf8',
);
const negative = readFileSync(
  join(process.cwd(), 'test/fixtures/capacity-wait/negative.txt'),
  'utf8',
);

function harness() {
  const send = vi.fn();
  const scope: Record<string, any> = {
    sessionId: 'session-a',
    currentBotmuxTurnId: 'turn-a',
    currentBotmuxDispatchAttempt: 2,
    captureRevision: 9,
    lastInitConfig: { cliId: 'traex' },
    capacityWaitTracker: createCapacityWaitTracker(),
    send,
  };
  scope.currentCapacityCaptureIdentity = loadWorkerFunction(
    'currentCapacityCaptureIdentity',
    scope,
  );
  scope.publishTraexCapacityObservation = loadWorkerFunction(
    'publishTraexCapacityObservation',
    scope,
  );
  return { scope, send };
}

describe('TraeX worker capacity viewport wiring', () => {
  it('publishes the exact captured identity and rejects a frame after the turn changes', () => {
    const { scope, send } = harness();
    const captured = scope.currentCapacityCaptureIdentity();

    scope.publishTraexCapacityObservation(captured, queued, 100);
    expect(send).toHaveBeenCalledExactlyOnceWith({
      type: 'capacity_wait',
      sessionId: 'session-a',
      turnId: 'turn-a',
      dispatchAttempt: 2,
      source: 'traex-viewport',
      state: 'waiting',
      position: 1590,
      observedAtMs: 100,
      revision: 9,
    });

    scope.currentBotmuxTurnId = 'turn-b';
    scope.currentBotmuxDispatchAttempt = 3;
    scope.captureRevision = 10;
    scope.publishTraexCapacityObservation(captured, queued, 101);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not synthesize waiting or clear from prose and silence', () => {
    const { scope, send } = harness();
    const captured = scope.currentCapacityCaptureIdentity();

    scope.publishTraexCapacityObservation(captured, negative, 100);
    scope.publishTraexCapacityObservation(captured, '', 101);

    expect(send).not.toHaveBeenCalled();
  });
});
