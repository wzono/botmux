import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import type { DaemonSession } from '../src/core/types.js';
import { activeSessionKey } from '../src/core/types.js';
import { dispatchAdmittedBusinessTurn, frozenSessionWorkspace } from '../src/core/admitted-turn-dispatch.js';
import { createWorkspaceBusinessDispatcher } from '../src/core/workspace-business-dispatcher.js';
import {
  __testOnly_setupWorkerHandlers,
  initWorkerPool,
  setActiveSessionsRegistry,
  submitBusinessInput,
} from '../src/core/worker-pool.js';
import { TurnPermitStore } from '../src/services/turn-permit-store.js';
import { __testOnly_resetBotRegistry, registerBot } from '../src/bot-registry.js';

const roots = new Set<string>();
beforeEach(() => {
  __testOnly_resetBotRegistry();
  for (const larkAppId of ['app-a', 'app-b']) registerBot({ larkAppId, larkAppSecret: 'secret', cliId: 'claude-code' });
});
afterEach(() => {
  setActiveSessionsRegistry(undefined);
  __testOnly_resetBotRegistry();
  vi.restoreAllMocks();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function identity(path: string) {
  const canonical = realpathSync(path);
  const stat = statSync(canonical, { bigint: true });
  return { path: canonical, dev: String(stat.dev), ino: String(stat.ino) };
}

function fakeWorker(): ChildProcess {
  const worker = new EventEmitter() as ChildProcess;
  Object.assign(worker, {
    killed: false,
    connected: true,
    pid: Math.floor(Math.random() * 10_000) + 10_000,
    send: vi.fn(() => true),
    kill: vi.fn(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  return worker;
}

function session(root: string, appId: string, suffix: string) {
  const dir = join(root, `workspace-${suffix}`);
  mkdirSync(dir);
  const workspace = identity(dir);
  const worker = fakeWorker();
  const ds = {
    session: {
      sessionId: `session-${suffix}`, larkAppId: appId, chatId: 'oc_architecture', rootMessageId: 'oc_architecture',
      status: 'active', scope: 'chat', createdAt: new Date().toISOString(), backendType: 'pty',
      workingDir: workspace.path, workingDirSource: 'group', workspaceSchemaVersion: 2,
      groupWorkspaceRevision: 1, groupWorkspaceIdentity: workspace, workerGeneration: 1,
    },
    worker, workerPort: null, workerToken: null, larkAppId: appId, chatId: 'oc_architecture',
    chatType: 'group', scope: 'chat', spawnedAt: Date.now(), lastMessageAt: Date.now(), hasHistory: false,
    workingDir: workspace.path, initConfig: { backendType: 'pty' }, workerGeneration: 1,
    workerReady: true, cliReady: true, lastWorkerReadyCwd: workspace.path, lastScreenStatus: 'idle',
  } as DaemonSession;
  return { ds, worker, workspace };
}

function authenticDispatcher(input: {
  store: TurnPermitStore;
  follow: (ds: DaemonSession) => Promise<'continue' | 'stop'>;
}) {
  return createWorkspaceBusinessDispatcher({
    runExclusive: async (_turn, run) => run(),
    freeze: frozenSessionWorkspace,
    follow: input.follow,
    dispatch: turn => dispatchAdmittedBusinessTurn({
      ds: turn.ds, turnId: turn.turnId, payload: turn.payload, options: turn.options,
      permitStore: input.store,
      boundary: {
        reserveGeneration: () => { throw new Error('existing worker expected'); },
        forkBlank: async () => 'rejected',
        submit: (ds, payload, permit, digest, options) =>
          submitBusinessInput(ds, payload, permit, digest, options, input.store),
      },
      ...(turn.markAttempting ? { resource: { markAttempting: turn.markAttempting } } : {}),
    }),
  });
}

async function waitForPermitSettlement(store: TurnPermitStore, turnIds: readonly string[], timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pending = await store.listDispatching();
    if (turnIds.every(turnId => !pending.some(row => row.permit.turnId === turnId))) return;
    if (Date.now() >= deadline) {
      throw new Error(`permit ACK settlement timed out: ${pending.map(row => row.permit.turnId).join(',')}`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('group workspace authentic production admission E2E', () => {
  it.each(['consume', 'markAttempting'] as const)(
    'rejects workspace changes across the %s await without stranding a durable dispatch', async phase => {
      for (const change of ['inode', 'path', 'runtime-path', 'source', 'revision', 'worker-cwd']) {
        const root = mkdtempSync(join(tmpdir(), 'workspace-identity-race-'));
        roots.add(root);
        const store = new TurnPermitStore(join(root, 'data'));
        const { ds, worker, workspace } = session(root, 'app-a', change);
        initWorkerPool({ sessionReply: vi.fn(async () => ''), getSessionWorkingDir: current => current.workingDir!,
          getActiveCount: () => 1, closeSession: vi.fn() });
        const other = join(root, 'other'); mkdirSync(other);
        let release!: () => void;
        let entered!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        const reached = new Promise<void>(resolve => { entered = resolve; });
        const consume = store.consumeBusiness.bind(store);
        if (phase === 'consume') vi.spyOn(store, 'consumeBusiness').mockImplementation(async (...args) => {
          const result = await consume(...args);
          entered(); await blocked; return result;
        });
        const dispatcher = authenticDispatcher({ store, follow: async () => 'continue' });
        const pending = dispatcher({ ds, turnId: 'changed-workspace', payload: 'must not send',
          options: { resume: false }, expectedWorkspace: { workspace, groupRevision: 1 },
          markAttempting: async () => {
            if (phase === 'markAttempting') { entered(); await blocked; }
            return true;
          } });
        await reached;
        if (change === 'inode') { renameSync(workspace.path, workspace.path + '-old'); mkdirSync(workspace.path); }
        if (change === 'path') ds.session.workingDir = other;
        if (change === 'runtime-path') ds.workingDir = other;
        if (change === 'source') ds.session.workingDirSource = 'explicit';
        if (change === 'revision') ds.session.groupWorkspaceRevision = 2;
        if (change === 'worker-cwd') ds.lastWorkerReadyCwd = other;
        release();
        expect(await pending, phase + ':' + change).toBe(false);
        expect(worker.send, phase + ':' + change).not.toHaveBeenCalled();
        expect(await store.listDispatching(), phase + ':' + change).toEqual([]);
      }
    },
  );

  it.each(['closed', 'session-replaced', 'worker-replaced', 'generation-changed'] as const)(
    'refuses business IPC if %s during asynchronous permit consumption', async change => {
      const root = mkdtempSync(join(tmpdir(), 'workspace-permit-race-'));
      roots.add(root);
      const { ds, worker, workspace } = session(root, 'app-a', 'race');
      const registry = new Map([[activeSessionKey(ds), ds]]);
      setActiveSessionsRegistry(registry);
      let release!: () => void;
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const consumeBusiness = vi.fn(async () => {
        await blocked;
        return { status: 'acquired' as const };
      });
      const permit = { sessionId: ds.session.sessionId, workerGeneration: 1, turnId: 'race-turn',
        workspace, groupRevision: 1, expiresAt: Date.now() + 60_000 } as Parameters<typeof submitBusinessInput>[2];
      const abortBusinessDispatch = vi.fn(async () => ({ status: 'retry' as const }));
      const pending = submitBusinessInput(ds, 'must not dispatch', permit, 'digest', {}, {
        consumeBusiness,
        abortBusinessDispatch,
        acknowledgeBusinessDelivery: vi.fn(),
      } as Parameters<typeof submitBusinessInput>[5]);
      expect(consumeBusiness).toHaveBeenCalledOnce();
      if (change === 'closed') ds.session.status = 'closed';
      if (change === 'session-replaced') registry.set(activeSessionKey(ds), { ...ds });
      if (change === 'worker-replaced') ds.worker = fakeWorker();
      if (change === 'generation-changed') ds.workerGeneration = ds.session.workerGeneration = 2;
      release();
      expect(await pending).toBe(false);
      expect(abortBusinessDispatch).toHaveBeenCalledOnce();
      expect(worker.send).not.toHaveBeenCalled();
      if (change === 'worker-replaced') expect(ds.worker?.send).not.toHaveBeenCalled();
    },
  );

  it('delivers two Bots through follow, actual worker IPC, exact ACK and durable permits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workspace-architecture-authentic-'));
    roots.add(root);
    const store = new TurnPermitStore(join(root, 'data'));
    const followed: string[] = [];
    initWorkerPool({ sessionReply: vi.fn(async () => ''), getSessionWorkingDir: ds => ds.workingDir!,
      getActiveCount: () => 2, closeSession: vi.fn(async () => true) });
    const dispatcher = authenticDispatcher({ store, follow: async ds => { followed.push(ds.session.sessionId); return 'continue'; } });
    const bots = [session(root, 'app-a', 'a'), session(root, 'app-b', 'b')];
    for (const { ds, worker, workspace } of bots) {
      __testOnly_setupWorkerHandlers(ds, worker, { ready: true, failureNotified: false }, 1);
      const turnId = `turn-${ds.larkAppId}`;
      expect(await dispatcher({ ds, turnId, payload: `payload-${ds.larkAppId}`, options: { resume: false },
        expectedWorkspace: { workspace, groupRevision: 1 }, markAttempting: async () => true })).toBe(true);
      expect(vi.mocked(worker.send as any).mock.calls.at(-1)?.[0]).toMatchObject({ type: 'message', turnId });
      worker.emit('message', { type: 'turn_input_committed', turnId });
    }
    await waitForPermitSettlement(store, ['turn-app-a', 'turn-app-b']);
    expect(followed).toEqual(['session-a', 'session-b']);
    expect(await store.listDispatching()).toEqual([]);
  });

  it('fails closed when the daemon follow gate is removed from the successful path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workspace-architecture-follow-'));
    roots.add(root);
    const store = new TurnPermitStore(join(root, 'data'));
    const { ds, worker, workspace } = session(root, 'app-a', 'follow');
    initWorkerPool({ sessionReply: vi.fn(async () => ''), getSessionWorkingDir: current => current.workingDir!,
      getActiveCount: () => 1, closeSession: vi.fn(async () => true) });
    __testOnly_setupWorkerHandlers(ds, worker, { ready: true, failureNotified: false }, 1);
    const dispatcher = authenticDispatcher({ store, follow: async () => 'stop' });
    expect(await dispatcher({ ds, turnId: 'turn-follow-stop', payload: 'blocked', options: { resume: false },
      expectedWorkspace: { workspace, groupRevision: 1 } })).toBe(false);
    expect(worker.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'message' }));
    expect(await store.listDispatching()).toEqual([]);
  });

  it('keeps delivery unsettled when the worker omits the exact commit ACK', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workspace-architecture-ack-'));
    roots.add(root);
    const store = new TurnPermitStore(join(root, 'data'));
    const { ds, worker, workspace } = session(root, 'app-a', 'ack');
    initWorkerPool({ sessionReply: vi.fn(async () => ''), getSessionWorkingDir: current => current.workingDir!,
      getActiveCount: () => 1, closeSession: vi.fn(async () => true) });
    __testOnly_setupWorkerHandlers(ds, worker, { ready: true, failureNotified: false }, 1);
    const dispatcher = authenticDispatcher({ store, follow: async () => 'continue' });
    expect(await dispatcher({ ds, turnId: 'turn-no-ack', payload: 'pending', options: { resume: false },
      expectedWorkspace: { workspace, groupRevision: 1 } })).toBe(true);
    expect(await store.listDispatching()).toEqual([
      expect.objectContaining({ permit: expect.objectContaining({ turnId: 'turn-no-ack', workspace }) }),
    ]);
  });
});
