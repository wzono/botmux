import { describe, expect, it, vi } from 'vitest';
import { productionConst } from './helpers/codex-async-answer-function-harness.js';

describe('daemon admitted worker boundary preserves queue authority', () => {
  it.each([true, false, undefined])('forwards queueAfterActiveTurn=%s without enabling steering', async value => {
    const submitBusinessInput = vi.fn(async (..._args: any[]) => true);
    const permitStore = {};
    const boundary = productionConst('src/daemon.ts', 'centralTurnWorkerBoundary', {
      submitBusinessInput, centralTurnPermitStore: permitStore,
    });
    const session = {}, permit = {};
    expect(await boundary.submit(session, 'wake', permit, 'digest', { resume: true, queueAfterActiveTurn: value })).toBe(true);
    const options = submitBusinessInput.mock.calls[0][4];
    if (value) expect(options).toHaveProperty('queueAfterActiveTurn', true);
    else expect(options).not.toHaveProperty('queueAfterActiveTurn');
    expect(options).not.toHaveProperty('codexAppSteerable');
    expect(submitBusinessInput.mock.calls[0][5]).toBe(permitStore);
  });
});
