import { describe, expect, it } from 'vitest';

import {
  createScheduledTurnRun,
  ScheduledTurnRunError,
} from '../src/core/scheduled-turn-run.js';

describe('scheduled turn run', () => {
  it('binds the generation only after exact worker receipt and settles on exact terminal', async () => {
    const run = createScheduledTurnRun('session-1', 'schedule:task:turn-1');

    expect(run.acceptInput('session-1', 'schedule:task:other', 7)).toBe(false);
    expect(run.acceptInput('session-1', 'schedule:task:turn-1', 7)).toBe(true);
    expect(run.acceptInput('session-1', 'schedule:task:turn-1', 8)).toBe(false);
    expect(run.settleTerminal({
      sessionId: 'session-1', turnId: 'schedule:task:turn-1', workerGeneration: 6,
      status: 'completed',
    })).toBe(false);
    expect(run.settleTerminal({
      sessionId: 'session-1', turnId: 'schedule:task:turn-1', workerGeneration: 7,
      status: 'completed',
    })).toBe(true);

    await expect(run.promise).resolves.toBeUndefined();
  });

  it('rejects worker refusal, crash-loop abandonment, and matching worker exit', async () => {
    const refused = createScheduledTurnRun('session-2', 'schedule:task:turn-2');
    expect(refused.rejectInput('session-2', 'schedule:task:turn-2', 'busy')).toBe(true);
    await expect(refused.promise).rejects.toMatchObject({ code: 'input_rejected' });

    const abandoned = createScheduledTurnRun('session-3', 'schedule:task:turn-3');
    expect(abandoned.abandon('session-3', 'schedule:task:turn-3', 'crash_loop')).toBe(true);
    await expect(abandoned.promise).rejects.toMatchObject({ code: 'abandoned' });

    const preReceiptExit = createScheduledTurnRun('session-pre', 'schedule:task:pre');
    expect(preReceiptExit.rejectWorkerExit('session-pre', 2)).toBe(false);

    const exited = createScheduledTurnRun('session-4', 'schedule:task:turn-4');
    expect(exited.acceptInput('session-4', 'schedule:task:turn-4', 4)).toBe(true);
    expect(exited.rejectWorkerExit('session-4', 5)).toBe(false);
    expect(exited.rejectWorkerExit('session-4', 4)).toBe(true);
    await expect(exited.promise).rejects.toMatchObject({ code: 'worker_exit' });
  });

  it('cancels a dispatch that never reaches worker receipt', async () => {
    const run = createScheduledTurnRun('session-5', 'schedule:task:turn-5');
    run.cancelDispatch(new ScheduledTurnRunError('dispatch_rejected', 'memory gate'));
    await expect(run.promise).rejects.toMatchObject({ code: 'dispatch_rejected' });
  });
});
