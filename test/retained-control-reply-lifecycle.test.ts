import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import { __testOnly_setupWorkerHandlers, initWorkerPool } from '../src/core/worker-pool.js';
import { registerBot } from '../src/bot-registry.js';
import * as sessionStore from '../src/services/session-store.js';
import { TurnPermitStore } from '../src/services/turn-permit-store.js';
import { config } from '../src/config.js';

vi.mock('@larksuiteoapi/node-sdk', () => ({ Client: class {}, WSClient: class {}, EventDispatcher: class {}, LoggerLevel: { info: 1 } }));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));

describe('retained control reply lifecycle', () => {
  registerBot({ larkAppId: 'app', larkAppSecret: 'secret', cliId: 'claude-code' });
  it('ignores wrong digest without receipt, then exact ACK records and releases authority', async () => {
    sessionStore.init('app');
    initWorkerPool({ sessionReply: vi.fn(async () => ''), getSessionWorkingDir: () => process.cwd(), getActiveCount: () => 1, closeSession: vi.fn() });
    const worker = Object.assign(new EventEmitter(), { killed: false, connected: true, send: vi.fn(), pid: 1 });
    const ds = { session: { sessionId: 's', rootMessageId: 'r', chatId: 'c', title: 't', status: 'active', createdAt: '', workerGeneration: 7 },
      worker, workerGeneration: 7, larkAppId: 'app', chatId: 'c', chatType: 'group', scope: 'thread', hasHistory: true,
      retainedControlReplyWorkers: new Map([['ask', { worker, generation: 7, controlDispatchId: 'd', controlReplyDigest: 'right', expiresAt: Date.now() + 1000 }]]),
    } as unknown as DaemonSession;
    __testOnly_setupWorkerHandlers(ds, worker as never, { ready: true, failureNotified: false }, 7);
    const ipc = worker.listeners('message')[0] as (msg: unknown) => Promise<void>;
    await ipc({ type: 'turn_input_committed', turnId: 'd', controlDispatchId: 'd', controlReplyDigest: 'wrong' });
    expect(ds.session.controlDispatchReceipts?.d).toBeUndefined();
    expect(ds.retainedControlReplyWorkers?.has('ask')).toBe(true);
    await ipc({ type: 'turn_input_committed', turnId: 'd', controlDispatchId: 'd', controlReplyDigest: 'right' });
    expect(ds.session.controlDispatchReceipts?.d?.replyDigest).toBe('right');
    expect(ds.retainedControlReplyWorkers?.has('ask')).toBe(false);
  });

  it('does not let an unrelated retained reply suppress a valid current-worker ACK', async () => {
    sessionStore.init('app');
    initWorkerPool({ sessionReply: vi.fn(async () => ''), getSessionWorkingDir: () => process.cwd(), getActiveCount: () => 1, closeSession: vi.fn() });
    const current = Object.assign(new EventEmitter(), { killed: false, connected: true, send: vi.fn(), pid: 3 });
    const other = Object.assign(new EventEmitter(), { killed: false, connected: true, send: vi.fn(), pid: 4 });
    const ds = { session: { sessionId: 's3', rootMessageId: 'r', chatId: 'c', title: 't', status: 'active', createdAt: '', workerGeneration: 8 },
      worker: current, workerGeneration: 8, larkAppId: 'app', chatId: 'c', chatType: 'group', scope: 'thread', hasHistory: true,
      retainedControlReplyWorkers: new Map([['unrelated', { worker: other, generation: 7, controlDispatchId: 'old', controlReplyDigest: 'old-digest', expiresAt: Date.now() + 1000 }]]),
    } as unknown as DaemonSession;
    __testOnly_setupWorkerHandlers(ds, current as never, { ready: true, failureNotified: false }, 8);
    const ipc = current.listeners('message')[0] as (msg: unknown) => Promise<void>;
    await ipc({ type: 'turn_input_committed', turnId: 'current', controlDispatchId: 'current', controlReplyDigest: 'current-digest' });
    expect(ds.session.controlDispatchReceipts?.current).toMatchObject({ replyDigest: 'current-digest', workerGeneration: 8 });
    expect(ds.retainedControlReplyWorkers?.has('unrelated')).toBe(true);
  });

  it('does not let a same-worker retained reply suppress another exact dispatch ACK', async () => {
    sessionStore.init('app');
    initWorkerPool({ sessionReply: vi.fn(async () => ''), getSessionWorkingDir: () => process.cwd(), getActiveCount: () => 1, closeSession: vi.fn() });
    const worker = Object.assign(new EventEmitter(), { killed: false, connected: true, send: vi.fn(), pid: 5 });
    const ds = { session: { sessionId: 's4', rootMessageId: 'r', chatId: 'c', title: 't', status: 'active', createdAt: '', workerGeneration: 9 },
      worker, workerGeneration: 9, larkAppId: 'app', chatId: 'c', chatType: 'group', scope: 'thread', hasHistory: true,
      retainedControlReplyWorkers: new Map([['ask-a', { worker, generation: 9, controlDispatchId: 'dispatch-a', controlReplyDigest: 'digest-a', expiresAt: Date.now() + 1000 }]]),
    } as unknown as DaemonSession;
    __testOnly_setupWorkerHandlers(ds, worker as never, { ready: true, failureNotified: false }, 9);
    const ipc = worker.listeners('message')[0] as (msg: unknown) => Promise<void>;
    await ipc({ type: 'turn_input_committed', turnId: 'dispatch-b', controlDispatchId: 'dispatch-b', controlReplyDigest: 'digest-b' });
    expect(ds.session.controlDispatchReceipts?.['dispatch-b']).toMatchObject({ replyDigest: 'digest-b', workerGeneration: 9 });
    expect(ds.retainedControlReplyWorkers?.has('ask-a')).toBe(true);
    await ipc({ type: 'turn_input_committed', turnId: 'dispatch-a', controlDispatchId: 'dispatch-a', controlReplyDigest: 'wrong' });
    expect(ds.session.controlDispatchReceipts?.['dispatch-a']).toBeUndefined();
    expect(ds.retainedControlReplyWorkers?.has('ask-a')).toBe(true);
  });

  it('accepts an exact retained old-worker ACK after same-session worker rebind', async () => {
    sessionStore.init('app');
    initWorkerPool({ sessionReply: vi.fn(async () => ''), getSessionWorkingDir: () => process.cwd(), getActiveCount: () => 1, closeSession: vi.fn() });
    const oldWorker = Object.assign(new EventEmitter(), { killed: false, connected: true, send: vi.fn(), pid: 6 });
    const replacement = Object.assign(new EventEmitter(), { killed: false, connected: true, send: vi.fn(), pid: 7 });
    const permitStore = new TurnPermitStore(config.session.dataDir);
    const permit = await permitStore.issueControlReply({ sessionId: 's5', originalTurnId: 'original',
      wait: { kind: 'ask', askId: 'ask' }, expectedGeneration: 9,
      workspace: { path: process.cwd(), dev: '1', ino: '2' }, expiresAt: Date.now() + 1000 });
    expect((await permitStore.beginControlReplyDispatch(permit, 'exact', {
      sessionId: 's5', originalTurnId: 'original', wait: { kind: 'ask', askId: 'ask' },
      workerGeneration: 9, workspace: { path: process.cwd(), dev: '1', ino: '2' },
      originalState: 'needs_user', authorized: true,
    })).status).toBe('acquired');
    const ds = { session: { sessionId: 's5', rootMessageId: 'r', chatId: 'c', title: 't', status: 'active', createdAt: '', workerGeneration: 9 },
      worker: oldWorker, workerGeneration: 9, larkAppId: 'app', chatId: 'c', chatType: 'group', scope: 'thread', hasHistory: true,
      retainedControlReplyWorkers: new Map([['ask', { worker: oldWorker, generation: 9, controlDispatchId: permit.controlDispatchId, controlReplyDigest: 'exact', expiresAt: permit.expiresAt }]]),
    } as unknown as DaemonSession;
    __testOnly_setupWorkerHandlers(ds, oldWorker as never, { ready: true, failureNotified: false }, 9);
    ds.worker = replacement as never; ds.workerGeneration = 10; ds.session.workerGeneration = 10;
    const ipc = oldWorker.listeners('message')[0] as (msg: unknown) => Promise<void>;
    await ipc({ type: 'turn_input_committed', turnId: permit.controlDispatchId,
      controlDispatchId: permit.controlDispatchId, controlReplyDigest: 'exact' });
    expect(ds.session.controlDispatchReceipts?.[permit.controlDispatchId]).toMatchObject({ replyDigest: 'exact', workerGeneration: 9 });
    await vi.waitFor(() => expect(ds.retainedControlReplyWorkers?.has('ask')).toBe(false));
    expect((await permitStore.beginControlReplyDispatch(permit, 'exact', {
      sessionId: 's5', originalTurnId: 'original', wait: { kind: 'ask', askId: 'ask' },
      workerGeneration: 9, workspace: { path: process.cwd(), dev: '1', ino: '2' },
      originalState: 'needs_user', authorized: true,
    })).status).toBe('delivered');
  });

  it('cleans retained authority on disconnect without waiting for exit', () => {
    const worker = Object.assign(new EventEmitter(), { killed: false, connected: true, send: vi.fn(), pid: 2 });
    const ds = { session: { sessionId: 's2', rootMessageId: 'r', chatId: 'c', title: 't', status: 'active', createdAt: '', workerGeneration: 7 },
      worker, workerGeneration: 7, larkAppId: 'app', chatId: 'c', chatType: 'group', scope: 'thread', hasHistory: true,
      retainedControlReplyWorkers: new Map([['ask', { worker, generation: 7, controlDispatchId: 'd', controlReplyDigest: 'right', expiresAt: Date.now() + 1000 }]]),
    } as unknown as DaemonSession;
    __testOnly_setupWorkerHandlers(ds, worker as never, { ready: true, failureNotified: false }, 7);
    worker.emit('disconnect');
    expect(ds.retainedControlReplyWorkers?.size).toBe(0);
  });
});
