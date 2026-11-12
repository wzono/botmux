import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { config } from '../src/config.js';
import { controllerForSession, type SessionController } from '../src/core/session-controller.js';
import { dispatchAdmittedBusinessTurn } from '../src/core/admitted-turn-dispatch.js';
import { submitBusinessInput, initWorkerPool, setActiveSessionsRegistry } from '../src/core/worker-pool.js';
import { TurnPermitStore } from '../src/services/turn-permit-store.js';
import { __testOnly_resetBotRegistry, registerBot } from '../src/bot-registry.js';
import type { DaemonSession } from '../src/core/types.js';

let root: string;
let previousDataDir: string;
let controller: SessionController;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'busy-probe-data-'));
  previousDataDir = config.session.dataDir;
  config.session.dataDir = root;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-12T00:00:00Z'));
  __testOnly_resetBotRegistry();
  initWorkerPool({ sessionReply: vi.fn(async () => ''), getSessionWorkingDir: ds => ds.workingDir!, getActiveCount: () => 1, closeSession: vi.fn() });
});
afterEach(() => {
  setActiveSessionsRegistry(undefined);
  controller?.store.close();
  __testOnly_resetBotRegistry();
  config.session.dataDir = previousDataDir;
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function fixture(cliId = 'codex') {
  const appId = 'cli_busy_probe';
  registerBot({ larkAppId: appId, larkAppSecret: 'probe-only', cliId } as never);
  const worker = Object.assign(new EventEmitter(), { killed: false, connected: true, send: vi.fn((_message: unknown) => true), pid: 99111, stdout: new EventEmitter(), stderr: new EventEmitter() });
  const ds = {
    larkAppId: appId, chatId: 'oc_probe', scope: 'chat', chatType: 'group', worker,
    workerPort: null, workerToken: null, spawnedAt: Date.now(), lastMessageAt: Date.now(), hasHistory: false,
    session: { sessionId: 'busy-probe', larkAppId: appId, chatId: 'oc_probe', rootMessageId: 'oc_probe', scope: 'chat', status: 'active', workingDir: root, workingDirSource: 'explicit', workerGeneration: 1, backendType: 'tmux', cliId },
    workingDir: root, workerGeneration: 1, lastWorkerReadyCwd: root, lastScreenStatus: 'working',
  } as unknown as DaemonSession;
  controller = controllerForSession(ds, true)!;
  const bootstrap = controller.bindWorker(1);
  controller.store.apply(controller.ref, { type: 'worker_online', worker: bootstrap.worker });
  ds.initConfig = { backendType: 'tmux', cliId, sessionContract: bootstrap } as never;
  const runtime = controller.bindRuntime('binding', bootstrap.worker, { backend: 'tmux', physicalId: 'probe:1', proof: 'process_start' });
  controller.store.apply(controller.ref, { type: 'runtime_ready', runtime: runtime.ref });
  const active = controller.admitInput('original');
  controller.store.apply(controller.ref, { type: 'runtime_busy', runtime: runtime.ref });
  const store = new TurnPermitStore(root);
  const dispatch = (turnId = 'correction', resource?: { acquire(): Promise<boolean> }) => dispatchAdmittedBusinessTurn({
    ds, turnId, payload: 'please correct this task', options: { resume: true, codexAppSteerable: true }, permitStore: store, resource,
    boundary: { reserveGeneration: () => 2, forkBlank: async () => 'rejected', submit: (ds, payload, permit, digest, options) => submitBusinessInput(ds, payload, permit, digest, options, store) },
  });
  return { worker, ds, store, dispatch, bootstrap, runtime, active };
}
describe('busy correction through the real worker boundary', () => {
  it.each(['codex', 'claude-code'])('sends %s correction while the original execution remains active', async cliId => {
    const f = fixture(cliId);
    expect(await f.dispatch()).toBe(true);
    expect(f.worker.send).toHaveBeenCalledOnce();
    expect(f.worker.send.mock.calls[0][0]).toMatchObject({ type: 'message', turnId: 'correction', codexAppSteerable: true });
    expect(controller.store.execution(controller.ref, f.active.executionId)?.terminal).toBeUndefined();
    expect(f.ds.cliReady).toBe(false);
  });
  it.each(['cancel', 'restart', 'suspend', 'close'] as const)('refuses %s during resource wait and recovers after failed-before-effect', async kind => {
    const f = fixture();
    const entered = deferred(); const release = deferred();
    const pending = f.dispatch('correction', { acquire: async () => { entered.release(); await release.promise; return true; } });
    await entered.promise;
    vi.setSystemTime(Date.now() + 500);
    const operation = controller.beginControl(kind, undefined, kind === 'cancel' ? f.active : undefined).operation;
    release.release();
    expect(await pending).toBe(false);
    expect(f.worker.send).not.toHaveBeenCalled();
    controller.controlResult(operation.operationId, 'failed_before_effect');
    expect(await f.dispatch()).toBe(true);
    expect(f.worker.send).toHaveBeenCalledOnce();
  });
  it('retries once when permit persisted but submission throws before IPC', async () => {
    const f = fixture();
    const consume = f.store.consumeBusiness.bind(f.store);
    let failOnce = true;
    vi.spyOn(f.store, 'consumeBusiness').mockImplementation(async (...args) => {
      const result = await consume(...args);
      if (failOnce) { failOnce = false; throw new Error('injected post-consume failure'); }
      return result;
    });
    expect(await f.dispatch()).toBe(false);
    expect(f.worker.send).not.toHaveBeenCalled();
    expect(await f.store.listDispatching()).toEqual([]);
    expect(await f.dispatch()).toBe(true);
    expect(f.worker.send).toHaveBeenCalledOnce();
  });
  it('rejects an expired resource wait before IPC', async () => {
    const f = fixture();
    expect(await f.dispatch('late', { acquire: async () => { vi.setSystemTime(Date.now() + 120_000); return true; } })).toBe(false);
    expect(f.worker.send).not.toHaveBeenCalled();
    expect(await f.store.listDispatching()).toEqual([]);
  });
  it.each(['cancel', 'restart', 'suspend', 'close', 'runtime-replacement'] as const)('refuses %s during the real permit consumption await', async change => {
    const f = fixture();
    const entered = deferred(); const release = deferred();
    const consume = f.store.consumeBusiness.bind(f.store);
    vi.spyOn(f.store, 'consumeBusiness').mockImplementation(async (...args) => {
      const result = await consume(...args); entered.release(); await release.promise; return result;
    });
    const pending = f.dispatch();
    await entered.promise;
    vi.setSystemTime(Date.now() + 500);
    if (change !== 'runtime-replacement') controller.beginControl(change, undefined, change === 'cancel' ? f.active : undefined);
    else {
      const replacement = controller.bindRuntime('replacement', f.bootstrap.worker, { backend: 'tmux', physicalId: 'probe:2', proof: 'process_start' });
      controller.store.apply(controller.ref, { type: 'runtime_ready', runtime: replacement.ref });
    }
    release.release();
    const accepted = await pending;
    expect(accepted).toBe(false);
    expect(f.worker.send).not.toHaveBeenCalled();
    expect(await f.store.listDispatching()).toEqual([]);
  });
});
