import { describe, expect, it, vi } from 'vitest';
import { loadWorkerMessageHandler } from './helpers/worker-function-harness.js';

function harness(current: boolean) {
  const write = vi.fn(() => true);
  const send = vi.fn();
  const scope = {
    lastInitConfig: { cliId: 'codex-app', adoptMode: false },
    backend: { write }, codexAppControlProven: true,
    isCodexAppCliId: () => true, isFlushing: false, commandLineWritesPending: 0,
    cliRestartInProgress: false, shouldHoldCodexRunnerInput: () => false,
    codexRunnerFreshness: 'current', canWriteTerminalBytes: () => current,
    send, Buffer,
  };
  return { handle: loadWorkerMessageHandler('codex_app_effort', scope), write, send };
}

describe('Codex App effort terminal workspace fence', () => {
  it('rejects the direct backend write when the terminal fence is stale', async () => {
    const h = harness(false);
    await h.handle({ type: 'codex_app_effort', requestId: 'r', effort: 'high' });
    expect(h.write).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledWith({ type: 'codex_app_effort_result', requestId: 'r', status: 'unavailable' });
  });

  it('writes the frame once while the fence is current', async () => {
    const h = harness(true);
    await h.handle({ type: 'codex_app_effort', requestId: 'r', effort: 'high' });
    expect(h.write).toHaveBeenCalledOnce();
  });
});
