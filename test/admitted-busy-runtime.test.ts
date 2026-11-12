import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { dispatchAdmittedBusinessTurn } from '../src/core/admitted-turn-dispatch.js';
import { controllerForSession, type SessionController } from '../src/core/session-controller.js';
import type { DaemonSession } from '../src/core/types.js';
import { TurnPermitStore } from '../src/services/turn-permit-store.js';

let directory: string;
let previousDataDir: string;
let controller: SessionController;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'admitted-busy-runtime-'));
  previousDataDir = config.session.dataDir;
  config.session.dataDir = directory;
});

afterEach(() => {
  controller?.store.close();
  config.session.dataDir = previousDataDir;
  rmSync(directory, { recursive: true, force: true });
});

function fixture(cliId = 'codex') {
  const ds = {
    larkAppId: 'cli_busy_admission',
    session: {
      sessionId: 'busy-admission', status: 'active', workingDir: directory,
      workingDirSource: 'explicit', workerGeneration: 1, backendType: 'tmux', cliId,
    },
    workingDir: directory, workerGeneration: 1, worker: { killed: false },
    lastWorkerReadyCwd: directory,
  } as unknown as DaemonSession;
  controller = controllerForSession(ds, true)!;
  const bootstrap = controller.bindWorker(1);
  controller.store.apply(controller.ref, { type: 'worker_online', worker: bootstrap.worker });
  ds.initConfig = { cliId, backendType: 'tmux', sessionContract: bootstrap } as never;
  const runtime = controller.bindRuntime('binding', bootstrap.worker, {
    backend: 'tmux', physicalId: 'fixture:1', proof: 'process_start',
  });
  const ready = () => controller.store.apply(controller.ref, { type: 'runtime_ready', runtime: runtime.ref });
  const busy = () => controller.store.apply(controller.ref, { type: 'runtime_busy', runtime: runtime.ref });
  const submit = vi.fn(async () => true);
  const forkBlank = vi.fn(async () => 'rejected' as const);
  const permitStore = new TurnPermitStore(directory);
  const dispatch = (resource?: { acquire(): Promise<boolean> }) => dispatchAdmittedBusinessTurn({
    ds, turnId: 'om_correction', payload: { content: 'correct the current task' },
    options: { resume: true, codexAppSteerable: true },
    boundary: { reserveGeneration: () => 2, forkBlank, submit }, permitStore, resource,
  });
  return { ds, bootstrap, runtime, ready, busy, submit, forkBlank, dispatch };
}

describe('business input during an active native turn', () => {
  it.each(['codex', 'claude-code'])('delivers a %s correction while the same initialized runtime is busy', async cliId => {
    const f = fixture(cliId);
    f.ready();
    const active = controller.admitInput('om_original');
    f.busy();
    expect(f.ds.workerReady).toBe(true);
    expect(f.ds.cliReady).toBe(false);

    expect(await f.dispatch()).toBe(true);
    expect(f.submit).toHaveBeenCalledOnce();
    const args = f.submit.mock.calls[0] as unknown as unknown[];
    expect(args[1]).toEqual({ content: 'correct the current task' });
    expect(args[2]).toMatchObject({ turnId: 'om_correction', workerGeneration: 1 });
    expect(args[4]).toEqual({ resume: true, codexAppSteerable: true });
    expect(f.forkBlank).not.toHaveBeenCalled();
    expect(controller.store.execution(controller.ref, active.executionId)?.terminal).toBeUndefined();
    expect(f.ds.cliReady).toBe(false);
  });

  it('still delivers to an idle runtime', async () => {
    const f = fixture(); f.ready();
    expect(await f.dispatch()).toBe(true);
    expect(f.submit).toHaveBeenCalledOnce();
  });

  it('does not treat a runtime that has never reached its prompt as busy and ready', async () => {
    const f = fixture();
    expect(f.ds.workerReady).toBe(true);
    expect(await f.dispatch()).toBe(false);
    expect(f.submit).not.toHaveBeenCalled();
  });

  it.each([true, false])('refuses a lost runtime, confirmed=%s', async confirmed => {
    const f = fixture(); f.ready(); f.busy();
    controller.store.apply(controller.ref, { type: 'runtime_lost', runtime: f.runtime.ref, confirmed });
    expect(await f.dispatch()).toBe(false);
    expect(f.submit).not.toHaveBeenCalled();
  });

  it.each(['restart', 'suspend', 'close'] as const)('refuses input during %s', async kind => {
    const f = fixture(); f.ready(); f.busy();
    controller.beginControl(kind);
    expect(await f.dispatch()).toBe(false);
    expect(f.submit).not.toHaveBeenCalled();
  });

  it('does not drop the worker workspace proof for busy input', async () => {
    const f = fixture(); f.ready(); f.busy();
    f.ds.lastWorkerReadyCwd = tmpdir();
    expect(await f.dispatch()).toBe(false);
    expect(f.submit).not.toHaveBeenCalled();
  });

  it('rechecks an intervening control operation before submission', async () => {
    const f = fixture(); f.ready();
    expect(await f.dispatch({ acquire: async () => {
      controller.beginControl('close');
      return true;
    } })).toBe(false);
    expect(f.submit).not.toHaveBeenCalled();
  });

  it('does not reuse a readiness proof after a runtime replacement on the same worker', async () => {
    const f = fixture(); f.ready();
    expect(await f.dispatch({ acquire: async () => {
      const replacement = controller.bindRuntime('replacement', f.bootstrap.worker, {
        backend: 'tmux', physicalId: 'fixture:2', proof: 'process_start',
      });
      controller.store.apply(controller.ref, { type: 'runtime_ready', runtime: replacement.ref });
      return true;
    } })).toBe(false);
    expect(f.submit).not.toHaveBeenCalled();
  });
});
