import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import { __testOnly_setupWorkerHandlers, initWorkerPool } from '../src/core/worker-pool.js';
import { registerBot } from '../src/bot-registry.js';
import * as sessionStore from '../src/services/session-store.js';

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
