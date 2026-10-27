/**
 * Two-phase turn reactions (auto-on for card-off sessions, i.e. streaming card disabled):
 *   - noteTurnReceived(ds, msgId): react 冲! (GoGoGo) the instant a user message
 *     is accepted for the session, tracked per-message in ds.pendingAckReactions.
 *   - finishTurnReactions(ds): when the worker next goes idle, flip every pending
 *     ✋ to ✅ (DONE) and clear the list.
 *
 * Binding the "received" reaction to the message (not a worker status edge) is
 * what makes type-ahead / busy-batched messages each get their own reaction —
 * the regression this test locks (Codex review of the patch-removal change).
 *
 * Run:  pnpm vitest run test/turn-reactions.test.ts
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const mocks = vi.hoisted(() => ({
  addReaction: vi.fn(),
  addReactionOnce: vi.fn(),
  removeReaction: vi.fn(),
  removeReactionDetailed: vi.fn(),
  listOwnReactionsDetailed: vi.fn(),
  updateMessage: vi.fn(),
  publishTurnCliIdentity: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return {
    ...actual,
    addReaction: mocks.addReaction,
    addReactionOnce: mocks.addReactionOnce,
    removeReaction: mocks.removeReaction,
    removeReactionDetailed: mocks.removeReactionDetailed,
    listOwnReactionsDetailed: mocks.listOwnReactionsDetailed,
    updateMessage: mocks.updateMessage,
  };
});

vi.mock('../src/core/turn-cli-identity.js', async () => {
  const actual = await vi.importActual<any>('../src/core/turn-cli-identity.js');
  return { ...actual, publishTurnCliIdentity: mocks.publishTurnCliIdentity };
});

import { getBot, registerBot } from '../src/bot-registry.js';
import {
  noteTurnReceived,
  __testOnly_activeSessions as activeSessions,
  __testOnly_restoreSessionsAndScheduleStartupRecovery as startupRecovery,
} from '../src/daemon.js';
import * as sessionStore from '../src/services/session-store.js';
import { beginReplyTargetTurn } from '../src/core/reply-target.js';
import {
  initWorkerPool,
  __testOnly_finishTurnReactions as finishTurnReactions,
  __testOnly_setupWorkerHandlers,
  __testOnly_setSuspendBackingVerifier,
  __testOnly_setSuspendPreparationVerifier,
  suspendWorker,
} from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import { activeSessionKey } from '../src/core/types.js';
import { turnFeedbackReconciler } from '../src/services/turn-feedback-reconciler.js';
import {
  readTurnFeedbackTerminalOutbox,
  writeTurnFeedbackTerminalOutbox,
  type TurnFeedbackTerminalRecord,
} from '../src/services/turn-feedback-terminal-outbox.js';

const APP = 'reaction_app';
const providerOwn = new Map<string, Array<{ id: string; type: string }>>();

function terminalOutboxRecord(
  ds: DaemonSession,
  patch: Partial<TurnFeedbackTerminalRecord> = {},
): TurnFeedbackTerminalRecord {
  return {
    version: 1, terminalRequestId: '33333333-3333-4333-8333-333333333333',
    ownerAppId: APP, sessionId: ds.session.sessionId, turnId: 'turn-replay',
    workerGeneration: ds.session.workerGeneration ?? 7, status: 'completed',
    savedAtMs: Date.now(), ...patch,
  };
}

function writeLiveTerminalOutbox(
  ds: DaemonSession,
  terminal: { terminalRequestId: string; turnId: string; status: TurnFeedbackTerminalRecord['status']; dispatchAttempt?: number; completedAtMs?: number; durationMs?: number },
): TurnFeedbackTerminalRecord {
  const value = terminalOutboxRecord(ds, {
    terminalRequestId: terminal.terminalRequestId, turnId: terminal.turnId,
    status: terminal.status, workerGeneration: ds.workerGeneration!,
    ...(terminal.dispatchAttempt !== undefined ? { dispatchAttempt: terminal.dispatchAttempt } : {}),
    ...(terminal.completedAtMs !== undefined ? { completedAtMs: terminal.completedAtMs } : {}),
    ...(terminal.durationMs !== undefined ? { durationMs: terminal.durationMs } : {}),
  });
  writeTurnFeedbackTerminalOutbox(process.env.SESSION_DATA_DIR!, value);
  return value;
}

function makeWorker() {
  const worker = new EventEmitter() as any;
  worker.killed = false;
  worker.connected = true;
  worker.send = vi.fn();
  worker.kill = vi.fn();
  worker.pid = 4242;
  worker.stdout = new EventEmitter();
  worker.stderr = new EventEmitter();
  return worker;
}

function makeDs(over: Partial<DaemonSession> = {}): DaemonSession {
  // status:'active' is required by the screen_update handler's ownsLifecycleMutation
  // guard (added with the ZMX lifecycle-ownership work). Without it every
  // screen_update breaks before lastScreenStatus updates, so the behavioral
  // working→idle / working→limited flip tests below never see a real edge.
  const session = sessionStore.createSession(
    'oc_x',
    'om_root-' + Math.random().toString(36).slice(2),
    'reaction fixture',
    'group',
    'chat',
  );
  const { session: sessionPatch, ...runtimePatch } = over;
  if (sessionPatch) {
    const { sessionId: _ignoredSessionId, ...persistedPatch } = sessionPatch;
    Object.assign(session, persistedPatch);
    sessionStore.updateSession(session);
  }
  return { session, larkAppId: APP, chatId: 'oc_x', scope: 'chat', ...runtimePatch } as unknown as DaemonSession;
}

// Reactions are auto-on for card-off sessions, so the gate is driven by
// disableStreamingCard (streaming card on → no reactions; off → reactions).
function registerWith(reactionsOn: boolean, opts: { silentTurnReactions?: boolean; receivedReactionEmoji?: string; doneReactionEmoji?: string; replyCardMode?: 'legacy' | 'unified'; triggerUserAuth?: boolean } = {}) {
  registerBot({
    larkAppId: APP,
    larkAppSecret: 's',
    cliId: 'claude-code',
    allowedUsers: ['ou_o'],
    disableStreamingCard: reactionsOn || undefined,
    replyCardMode: opts.replyCardMode,
    silentTurnReactions: opts.silentTurnReactions || undefined,
    receivedReactionEmoji: opts.receivedReactionEmoji,
    doneReactionEmoji: opts.doneReactionEmoji,
    triggerUserAuth: opts.triggerUserAuth
      ? { enabled: true, tools: ['lark-cli'] }
      : undefined,
  });
}

describe('two-phase turn reactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SESSION_DATA_DIR = mkdtempSync(join(tmpdir(), 'botmux-react-'));
    sessionStore.init(APP);
    mocks.addReaction.mockImplementation(async (_app: string, msgId: string) => `rid_${msgId}`);
    mocks.removeReaction.mockResolvedValue(undefined);
    providerOwn.clear();
    mocks.listOwnReactionsDetailed.mockImplementation(async (_app: string, msgId: string) => ({
      status: 'ok', items: structuredClone(providerOwn.get(msgId) ?? []),
    }));
    mocks.addReactionOnce.mockImplementation(async (_app: string, msgId: string, type: string) => {
      const item = { id: `rid_${msgId}_${type}`, type };
      providerOwn.set(msgId, [...(providerOwn.get(msgId) ?? []), item]);
      return { status: 'created', id: item.id };
    });
    mocks.removeReactionDetailed.mockImplementation(async (_app: string, msgId: string, id: string) => {
      providerOwn.set(msgId, (providerOwn.get(msgId) ?? []).filter(item => item.id !== id));
      return 'deleted';
    });
    mocks.publishTurnCliIdentity.mockResolvedValue([]);
    mocks.updateMessage.mockResolvedValue(undefined);
    activeSessions.clear();
  });

  afterEach(() => {
    sessionStore.__testOnly_setBeforeRowPersist(undefined);
  });

  it('streaming card on (default): no reaction on receipt', async () => {
    registerWith(false);
    const ds = makeDs();
    await noteTurnReceived(ds, 'om_a');
    expect(mocks.addReaction).not.toHaveBeenCalled();
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_a).toMatchObject({
      version: 1, turnId: 'om_a', messageId: 'om_a', phase: 'processing',
    });
    expect(ds.pendingAckReactions ?? []).toEqual([]);
    expect(ds.turnReceivedAtMs).toBeUndefined();
    getBot(APP).config.showReplyTiming = true;
    await noteTurnReceived(ds, 'om_b', undefined, undefined, 'om_actual_turn');
    expect(ds.turnReceivedAtMs?.get('om_actual_turn')).toEqual(expect.any(Number));
    expect(ds.turnReceivedAtMs?.has('om_b')).toBe(false);
  });

  it.each([true, false])('unified replies retain the independent status-card reaction gate (off=%s)', async statusOff => {
    registerWith(statusOff, { replyCardMode: 'unified' });
    const ds = makeDs();
    await noteTurnReceived(ds, 'om_status_toggle');
    expect(mocks.addReactionOnce).toHaveBeenCalledTimes(statusOff ? 1 : 0);
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_status_toggle)
      .toMatchObject(statusOff
        ? { reaction: { type: 'GoGoGo' } }
        : { silent: true, phase: 'processing' });
  });

  it('Plan B: a meeting-agent session reacts to plain user turns like any card-off session', async () => {
    registerWith(true);
    const ds = makeDs({
      pendingAckReactions: [{ messageId: 'om_old', reactionId: 'rid_old' }],
    });
    // The vcMeetingReceiver marker is now pure delivery metadata. A plain user
    // message (no stamped meeting @mention origin) is an ordinary turn, so it
    // gets the ✋ on receipt and its pending ✋ settle to ✅ on idle.
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app',
      meetingId: 'meeting-1',
      memberId: 'member-1',
      memberEpoch: 1,
    };

    await noteTurnReceived(ds, 'om_new');
    await finishTurnReactions(ds);

    // ✋ added on the new user message; the stale + new pending entries settle.
    expect(mocks.addReaction).toHaveBeenCalled();
    expect(mocks.removeReaction).toHaveBeenCalled();
    expect(ds.pendingAckReactions).toEqual([]);
  });

  it('reacts 冲! (GoGoGo) on each accepted message and dedups by message id', async () => {
    registerWith(true);
    const ds = makeDs();
    mocks.addReactionOnce.mockImplementationOnce(async (_app: string, msgId: string, type: string) => {
      expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_a).toMatchObject({
        turnId: 'om_a', messageId: 'om_a', phase: 'processing',
        reactionOperation: { phase: 'add_pending', desiredType: 'GoGoGo' },
      });
      providerOwn.set(msgId, [{ id: `rid_${msgId}_${type}`, type }]);
      return { status: 'created', id: `rid_${msgId}_${type}` };
    });
    await noteTurnReceived(ds, 'om_a');
    const firstAdmission = structuredClone(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_a);
    await noteTurnReceived(ds, 'om_a'); // same message — must not double-react
    await noteTurnReceived(ds, 'om_b');
    expect(mocks.addReactionOnce).toHaveBeenCalledTimes(2);
    expect(mocks.addReactionOnce).toHaveBeenCalledWith(APP, 'om_a', 'GoGoGo');
    expect(mocks.addReactionOnce).toHaveBeenCalledWith(APP, 'om_b', 'GoGoGo');
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_a).toEqual(firstAdmission);
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_b)
      .toMatchObject({ reaction: { type: 'GoGoGo' } });
    expect(Object.keys(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback ?? {})).toEqual(['om_a', 'om_b']);
  });

  it('commits reaction intent before the provider write and duplicate admission never writes twice', async () => {
    registerWith(true);
    const ds = makeDs();
    mocks.addReactionOnce.mockImplementationOnce(async (_app: string, messageId: string, type: string) => {
      expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_journal)
        .toMatchObject({
          reactionReconcilePending: true,
          reactionOperation: { messageId, desiredType: type, phase: 'add_pending' },
        });
      providerOwn.set(messageId, [{ id: 'rid_journal', type }]);
      return { status: 'created', id: 'rid_journal' };
    });

    await noteTurnReceived(ds, 'om_journal');
    await noteTurnReceived(ds, 'om_journal');

    expect(mocks.addReaction).not.toHaveBeenCalled();
    expect(mocks.addReactionOnce).toHaveBeenCalledTimes(1);
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_journal)
      .toMatchObject({ reaction: { id: 'rid_journal', type: 'GoGoGo' } });
  });

  it.each([
    ['completed', 'DONE'],
    ['failed', 'ERROR'],
    ['cancelled', 'ERROR'],
    ['ambiguous', 'ERROR'],
  ] as const)('current worker terminal %s converges the exact durable turn to %s', async (status, emoji) => {
    registerWith(true);
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const worker = makeWorker();
    const ds = makeDs({ worker });
    ds.workerGeneration = 3;
    ds.session.workerGeneration = 3;
    await noteTurnReceived(ds, 'om_terminal', undefined, undefined, 'turn-terminal');
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', {
      type: 'turn_terminal',
      sessionId: ds.session.sessionId,
      turnId: 'turn-terminal',
      status,
      completedAtMs: Date.now(),
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.['turn-terminal'])
      .toMatchObject({
        phase: status === 'completed' ? 'completed' : 'failed',
        reaction: { type: emoji },
      });
    expect(mocks.addReaction).not.toHaveBeenCalled();
  });

  it('stale worker and mismatched session terminal receipts do not terminalize feedback', async () => {
    registerWith(true);
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const worker = makeWorker();
    const ds = makeDs({ worker });
    ds.workerGeneration = 3;
    ds.session.workerGeneration = 3;
    await noteTurnReceived(ds, 'om_guarded', undefined, undefined, 'turn-guarded');
    __testOnly_setupWorkerHandlers(ds, worker);
    const replacement = makeWorker();
    ds.worker = replacement;
    __testOnly_setupWorkerHandlers(ds, replacement);

    worker.emit('message', {
      type: 'turn_terminal', sessionId: ds.session.sessionId,
      turnId: 'turn-guarded', status: 'completed',
    });
    replacement.emit('message', {
      type: 'turn_terminal', sessionId: 'wrong-session',
      turnId: 'turn-guarded', status: 'completed',
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.['turn-guarded'])
      .toMatchObject({ phase: 'processing', reaction: { type: 'GoGoGo' } });
  });

  it('ACKs terminal only after durable commit; retry succeeds without duplicate lifecycle effects', async () => {
    registerWith(true);
    const onTurnTerminal = vi.fn();
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'), getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1, closeSession: vi.fn(), onTurnTerminal,
    });
    const worker = makeWorker();
    const ds = makeDs({ worker });
    ds.workerGeneration = 3;
    ds.session.workerGeneration = 3;
    await noteTurnReceived(ds, 'om_ack', undefined, undefined, 'turn-ack');
    __testOnly_setupWorkerHandlers(ds, worker);
    const terminal = {
      type: 'turn_terminal',
      terminalRequestId: '11111111-1111-4111-8111-111111111111',
      sessionId: ds.session.sessionId, turnId: 'turn-ack', status: 'completed',
    } as const;
    const durable = writeLiveTerminalOutbox(ds, terminal);
    let fail = true;
    sessionStore.__testOnly_setBeforeRowPersist(() => {
      if (fail) { fail = false; throw new Error('terminal store offline'); }
    });

    worker.emit('message', terminal);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'turn_terminal_persisted', terminalRequestId: terminal.terminalRequestId, result: 'retry',
    }));
    expect(onTurnTerminal).not.toHaveBeenCalled();
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.['turn-ack'].phase)
      .toBe('processing');

    sessionStore.__testOnly_setBeforeRowPersist(undefined);
    worker.emit('message', terminal);
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'turn_terminal_persisted', terminalRequestId: terminal.terminalRequestId, result: 'committed',
    }));
    expect(onTurnTerminal).toHaveBeenCalledTimes(1);
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.['turn-ack'].phase)
      .toBe('completed');

    const providerWrites = mocks.addReactionOnce.mock.calls.length
      + mocks.removeReactionDetailed.mock.calls.length;
    worker.emit('message', terminal);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(onTurnTerminal).toHaveBeenCalledTimes(1);
    expect(mocks.addReactionOnce.mock.calls.length + mocks.removeReactionDetailed.mock.calls.length)
      .toBe(providerWrites);
  });

  it('runs lifecycle once even when the first committed ACK transport throws', async () => {
    registerWith(true);
    const onTurnTerminal = vi.fn();
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'), getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1, closeSession: vi.fn(), onTurnTerminal,
    });
    const worker = makeWorker();
    const ds = makeDs({ worker });
    ds.workerGeneration = 12;
    ds.session.workerGeneration = 12;
    await noteTurnReceived(ds, 'om_ack_throw', undefined, undefined, 'turn-ack-throw');
    __testOnly_setupWorkerHandlers(ds, worker);
    const terminal = {
      type: 'turn_terminal', terminalRequestId: '77777777-7777-4777-8777-777777777777',
      sessionId: ds.session.sessionId, turnId: 'turn-ack-throw', status: 'completed',
    } as const;
    const durable = writeLiveTerminalOutbox(ds, terminal);
    let ackThrows = true;
    worker.send.mockImplementation((message: any) => {
      if (message?.type === 'turn_terminal_persisted' && ackThrows) {
        ackThrows = false;
        throw new Error('ACK transport lost');
      }
    });

    worker.emit('message', terminal);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(onTurnTerminal).toHaveBeenCalledTimes(1);
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.['turn-ack-throw'].phase)
      .toBe('completed');

    worker.emit('message', terminal);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(onTurnTerminal).toHaveBeenCalledTimes(1);
    expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'turn_terminal_persisted', result: 'committed',
    }));
  });

  it('forged terminal request without an exact outbox stops before lifecycle', async () => {
    registerWith(true);
    const onTurnTerminal = vi.fn();
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'), getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1, closeSession: vi.fn(), onTurnTerminal,
    });
    const worker = makeWorker();
    const ds = makeDs({ worker });
    ds.workerGeneration = 13;
    ds.session.workerGeneration = 13;
    await noteTurnReceived(ds, 'om_forged', undefined, undefined, 'turn-forged');
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', {
      type: 'turn_terminal', terminalRequestId: '88888888-8888-4888-8888-888888888888',
      sessionId: ds.session.sessionId, turnId: 'turn-forged', status: 'completed',
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'turn_terminal_persisted', result: 'conflict',
    }));
    expect(onTurnTerminal).not.toHaveBeenCalled();
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.['turn-forged'].phase)
      .toBe('processing');
  });

  it('durable terminal receipt rejects a new request with a conflicting raw status', async () => {
    registerWith(true);
    const onTurnTerminal = vi.fn();
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'), getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1, closeSession: vi.fn(), onTurnTerminal,
    });
    const worker = makeWorker();
    const ds = makeDs({ worker });
    ds.workerGeneration = 14;
    ds.session.workerGeneration = 14;
    await noteTurnReceived(ds, 'om_receipt', undefined, undefined, 'turn-receipt');
    __testOnly_setupWorkerHandlers(ds, worker);
    const completed = {
      type: 'turn_terminal', terminalRequestId: '99999999-9999-4999-8999-999999999999',
      sessionId: ds.session.sessionId, turnId: 'turn-receipt', status: 'completed',
    } as const;
    writeLiveTerminalOutbox(ds, completed);
    worker.emit('message', completed);
    await new Promise(resolve => setTimeout(resolve, 0));
    const conflicting = {
      ...completed, terminalRequestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: 'failed' as const,
    };
    writeLiveTerminalOutbox(ds, conflicting);
    worker.emit('message', conflicting);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({
      terminalRequestId: conflicting.terminalRequestId, result: 'conflict',
    }));
    expect(onTurnTerminal).toHaveBeenCalledTimes(1);
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.['turn-receipt'])
      .toMatchObject({ phase: 'completed', terminalReceipt: { status: 'completed' } });
  });

  it('refuses idle suspension while this worker owns an uncommitted terminal', async () => {
    registerWith(true);
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'), getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1, closeSession: vi.fn(),
    });
    const worker = makeWorker();
    const ds = makeDs({ worker, initConfig: { backendType: 'tmux' } as any });
    ds.workerGeneration = 5;
    ds.session.workerGeneration = 5;
    await noteTurnReceived(ds, 'om_suspend', undefined, undefined, 'turn-suspend');
    __testOnly_setupWorkerHandlers(ds, worker);
    const terminal = {
      type: 'turn_terminal', terminalRequestId: '55555555-5555-4555-8555-555555555555',
      sessionId: ds.session.sessionId, turnId: 'turn-suspend', status: 'completed',
    } as const;
    const durable = writeLiveTerminalOutbox(ds, terminal);
    let fail = true;
    sessionStore.__testOnly_setBeforeRowPersist(() => {
      if (fail) { fail = false; throw new Error('terminal unavailable'); }
    });
    __testOnly_setSuspendBackingVerifier(() => true);
    try {
      worker.emit('message', terminal);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(suspendWorker(ds, 'idle_timeout')).toBe(false);
      expect(ds.worker).toBe(worker);

      sessionStore.__testOnly_setBeforeRowPersist(undefined);
      worker.emit('message', terminal);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(suspendWorker(ds, 'idle_timeout')).toBe(true);
      expect(readTurnFeedbackTerminalOutbox(process.env.SESSION_DATA_DIR!, durable)).toBeUndefined();
    } finally {
      sessionStore.__testOnly_setBeforeRowPersist(undefined);
      __testOnly_setSuspendBackingVerifier();
    }
  });

  it('same terminal request with a different status ACKs conflict and never mutates', async () => {
    registerWith(true);
    const onTurnTerminal = vi.fn();
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'), getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1, closeSession: vi.fn(), onTurnTerminal,
    });
    const worker = makeWorker();
    const ds = makeDs({ worker });
    ds.workerGeneration = 4;
    ds.session.workerGeneration = 4;
    await noteTurnReceived(ds, 'om_conflict', undefined, undefined, 'turn-conflict');
    __testOnly_setupWorkerHandlers(ds, worker);
    const base = {
      type: 'turn_terminal', terminalRequestId: '22222222-2222-4222-8222-222222222222',
      sessionId: ds.session.sessionId, turnId: 'turn-conflict',
    } as const;
    writeLiveTerminalOutbox(ds, { ...base, status: 'completed' });
    worker.emit('message', { ...base, status: 'completed' });
    await new Promise(resolve => setTimeout(resolve, 0));
    worker.emit('message', { ...base, status: 'failed' });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'turn_terminal_persisted', terminalRequestId: base.terminalRequestId, result: 'conflict',
    }));
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.['turn-conflict'].phase)
      .toBe('completed');
    expect(onTurnTerminal).toHaveBeenCalledTimes(1);
  });

  it('rejects a terminal from an older dispatch attempt without mutating feedback', async () => {
    registerWith(true);
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'), getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1, closeSession: vi.fn(),
    });
    const worker = makeWorker();
    const ds = makeDs({ worker });
    ds.workerGeneration = 6;
    ds.session.workerGeneration = 6;
    ds.turnDispatchAttemptHighWater = { turnId: 'turn-attempt', dispatchAttempt: 3 };
    await noteTurnReceived(ds, 'om_attempt', undefined, undefined, 'turn-attempt');
    __testOnly_setupWorkerHandlers(ds, worker);

    const staleTerminal = {
      type: 'turn_terminal', terminalRequestId: '66666666-6666-4666-8666-666666666666',
      sessionId: ds.session.sessionId, turnId: 'turn-attempt', dispatchAttempt: 2,
      status: 'completed',
    } as const;
    writeLiveTerminalOutbox(ds, staleTerminal);
    worker.emit('message', staleTerminal);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'turn_terminal_persisted', result: 'conflict', dispatchAttempt: 2,
    }));
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.['turn-attempt'].phase)
      .toBe('processing');
  });

  it('rejects a terminal missing dispatch attempt when live high-water proves one', async () => {
    registerWith(true);
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'), getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1, closeSession: vi.fn(),
    });
    const worker = makeWorker();
    const ds = makeDs({ worker });
    ds.workerGeneration = 15; ds.session.workerGeneration = 15;
    ds.turnDispatchAttemptHighWater = { turnId: 'turn-missing-attempt', dispatchAttempt: 1 };
    await noteTurnReceived(ds, 'om_missing_attempt', undefined, undefined, 'turn-missing-attempt');
    __testOnly_setupWorkerHandlers(ds, worker);
    const terminal = {
      type: 'turn_terminal', terminalRequestId: 'afafafaf-afaf-4faf-8faf-afafafafafaf',
      sessionId: ds.session.sessionId, turnId: 'turn-missing-attempt', status: 'completed',
    } as const;
    writeLiveTerminalOutbox(ds, terminal);
    worker.emit('message', terminal);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({ result: 'conflict' }));
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.['turn-missing-attempt'].phase)
      .toBe('processing');
  });

  it('legacy idle reaction finalizer ignores feedback-owned turns', async () => {
    registerWith(true);
    const ds = makeDs();
    await noteTurnReceived(ds, 'om_owned');
    ds.pendingAckReactions = [{ messageId: 'om_owned', reactionId: 'legacy-id' }];
    mocks.addReaction.mockClear();
    mocks.removeReaction.mockClear();

    await finishTurnReactions(ds);

    expect(mocks.addReaction).not.toHaveBeenCalled();
    expect(mocks.removeReaction).not.toHaveBeenCalled();
    expect(ds.pendingAckReactions).toEqual([]);
  });

  it.each(['active', 'closed'] as const)('actual startup adopts %s add ACK without duplicate CREATE', async status => {
    registerWith(true);
    const ds = makeDs();
    ds.session.status = status;
    ds.session.turnFeedback = {
      'turn-startup': {
        version: 1, turnId: 'turn-startup', messageId: 'om_startup',
        phase: status === 'closed' ? 'failed' : 'processing',
        updatedAt: new Date().toISOString(), reactionReconcilePending: true,
        reactionOperation: {
          opId: `op-${status}`, messageId: 'om_startup',
          desiredType: status === 'closed' ? 'ERROR' : 'GoGoGo',
          createdAt: new Date().toISOString(), phase: 'add_pending',
        },
      },
    };
    sessionStore.updateSession(ds.session);
    providerOwn.set('om_startup', [{
      id: 'provider-ack', type: status === 'closed' ? 'ERROR' : 'GoGoGo',
    }]);

    const run = () => startupRecovery({
      larkAppId: APP,
      restoreSessions: async () => {
        if (status === 'active') activeSessions.set(activeSessionKey(ds), ds);
        return [];
      },
      markSessionsRestored: vi.fn(),
      driveRestoredXpiGroup: vi.fn(),
      driveRestoredPrincipalLane: vi.fn(),
    });
    await run();
    await run();

    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.['turn-startup'])
      .toMatchObject({ reaction: { id: 'provider-ack' } });
    expect(mocks.addReactionOnce).not.toHaveBeenCalled();
    expect(mocks.listOwnReactionsDetailed).toHaveBeenCalledTimes(1);
    if (status === 'closed') {
      expect(activeSessions.size).toBe(0);
      expect(mocks.updateMessage).not.toHaveBeenCalled();
    }
  });

  it.each(['remove_pending', 'cleanup_pending'] as const)('actual closed startup resumes %s idempotently', async phase => {
    registerWith(true);
    const ds = makeDs();
    ds.session.status = 'closed';
    ds.session.turnFeedback = {
      repair: {
        version: 1, turnId: 'repair', messageId: 'om_repair', phase: 'failed',
        updatedAt: new Date().toISOString(), reactionReconcilePending: true,
        reaction: phase === 'remove_pending'
          ? { id: 'old', type: 'GoGoGo' }
          : { id: 'a', type: 'ERROR' },
        reactionOperation: phase === 'remove_pending'
          ? {
              opId: 'op-remove', messageId: 'om_repair', desiredType: 'ERROR',
              createdAt: new Date().toISOString(), phase, old: { id: 'old', type: 'GoGoGo' },
            }
          : {
              opId: 'op-cleanup', messageId: 'om_repair', desiredType: 'ERROR',
              createdAt: new Date().toISOString(), phase, adopted: { id: 'a', type: 'ERROR' },
              duplicateIds: ['z'],
            },
      },
    };
    sessionStore.updateSession(ds.session);
    providerOwn.set('om_repair', phase === 'remove_pending'
      ? []
      : [{ id: 'a', type: 'ERROR' }]);
    const run = () => startupRecovery({
      larkAppId: APP, restoreSessions: async () => [], markSessionsRestored: vi.fn(),
      driveRestoredXpiGroup: vi.fn(), driveRestoredPrincipalLane: vi.fn(),
    });

    await run();
    const creates = mocks.addReactionOnce.mock.calls.length;
    const deletes = mocks.removeReactionDetailed.mock.calls.length;
    await run();

    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.repair)
      .toMatchObject({ phase: 'failed', reaction: { type: 'ERROR' } });
    expect(mocks.addReactionOnce).toHaveBeenCalledTimes(creates);
    expect(mocks.removeReactionDetailed).toHaveBeenCalledTimes(deletes);
    expect(activeSessions.size).toBe(0);
  });

  it('actual closed startup clears gone journal once and never recreates', async () => {
    registerWith(true);
    const ds = makeDs();
    ds.session.status = 'closed';
    ds.session.turnFeedback = { gone: {
      version: 1, turnId: 'gone', messageId: 'om_gone', phase: 'failed',
      updatedAt: new Date().toISOString(), reactionReconcilePending: true,
      reactionOperation: {
        opId: 'op-gone', messageId: 'om_gone', desiredType: 'ERROR',
        createdAt: new Date().toISOString(), phase: 'add_pending',
      },
    } };
    sessionStore.updateSession(ds.session);
    mocks.listOwnReactionsDetailed.mockResolvedValue({ status: 'gone' });
    const run = () => startupRecovery({
      larkAppId: APP, restoreSessions: async () => [], markSessionsRestored: vi.fn(),
      driveRestoredXpiGroup: vi.fn(), driveRestoredPrincipalLane: vi.fn(),
    });

    await run();
    await run();

    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.gone)
      .toMatchObject({ reactionMessageGone: true });
    expect(mocks.listOwnReactionsDetailed).toHaveBeenCalledTimes(1);
    expect(mocks.addReactionOnce).not.toHaveBeenCalled();
    expect(activeSessions.size).toBe(0);
  });

  it('closed startup terminalizes placeholders but preserves reaction and reminder obligations', async () => {
    registerWith(true);
    const ds = makeDs();
    ds.session.status = 'closed';
    ds.session.turnFeedback = { repair: {
      version: 1, turnId: 'repair', messageId: 'om_closed', phase: 'processing',
      updatedAt: new Date().toISOString(), reaction: { id: 'old', type: 'GoGoGo' },
      reactionReconcilePending: true, capacityClearedAt: new Date().toISOString(),
      capacity: { state: 'waiting', source: 'pty', startedAtMs: Date.now(), updatedAtMs: Date.now() },
      attention: { state: 'needs_user', promptNonce: 'ask', dispatchAttempt: 1, workerGeneration: 2, openedAtMs: Date.now() },
      reminder: { status: 'pending', uuid: 'reminder-uuid' },
    } };
    sessionStore.updateSession(ds.session);
    providerOwn.set('om_closed', [{ id: 'old', type: 'GoGoGo' }]);

    await startupRecovery({
      larkAppId: APP, restoreSessions: async () => [], markSessionsRestored: vi.fn(),
      driveRestoredXpiGroup: vi.fn(), driveRestoredPrincipalLane: vi.fn(),
    });

    const repaired = sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.repair;
    expect(repaired).toMatchObject({
      phase: 'failed', reaction: { type: 'ERROR' },
      reminder: { status: 'pending', uuid: 'reminder-uuid' },
    });
    expect(repaired?.capacity).toBeUndefined();
    expect(repaired?.capacityClearedAt).toBeUndefined();
    expect(repaired?.attention).toBeUndefined();
    expect(repaired?.reactionOperation).toBeUndefined();
    expect(repaired?.reactionReconcilePending).toBeUndefined();
    expect(mocks.updateMessage).not.toHaveBeenCalled();
    expect(activeSessions.size).toBe(0);
  });

  it('closed startup skips a clean terminal reaction', async () => {
    registerWith(true);
    const ds = makeDs();
    ds.session.status = 'closed';
    ds.session.turnFeedback = { clean: {
      version: 1, turnId: 'clean', messageId: 'om_clean', phase: 'failed',
      updatedAt: new Date().toISOString(), reaction: { id: 'error', type: 'ERROR' },
    } };
    sessionStore.updateSession(ds.session);

    await startupRecovery({
      larkAppId: APP, restoreSessions: async () => [], markSessionsRestored: vi.fn(),
      driveRestoredXpiGroup: vi.fn(), driveRestoredPrincipalLane: vi.fn(),
    });

    expect(mocks.listOwnReactionsDetailed).not.toHaveBeenCalled();
    expect(mocks.addReactionOnce).not.toHaveBeenCalled();
    expect(mocks.removeReactionDetailed).not.toHaveBeenCalled();
    expect(activeSessions.size).toBe(0);
  });

  it.each(['active', 'closed'] as const)('startup replays %s terminal outbox before worker restore without active/card side effects', async status => {
    registerWith(true);
    const ds = makeDs();
    ds.session.status = status;
    ds.session.workerGeneration = 7;
    ds.session.turnFeedback = { 'turn-replay': {
      version: 1, turnId: 'turn-replay', messageId: 'om_replay', phase: 'processing',
      updatedAt: new Date().toISOString(), reaction: { id: 'old', type: 'GoGoGo' },
    } };
    sessionStore.updateSession(ds.session);
    providerOwn.set('om_replay', [{ id: 'old', type: 'GoGoGo' }]);
    const record = terminalOutboxRecord(ds);
    writeTurnFeedbackTerminalOutbox(process.env.SESSION_DATA_DIR!, record);
    const restoreSessions = vi.fn(async () => []);

    await startupRecovery({
      larkAppId: APP, restoreSessions, markSessionsRestored: vi.fn(),
      driveRestoredXpiGroup: vi.fn(), driveRestoredPrincipalLane: vi.fn(),
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(restoreSessions).toHaveBeenCalledTimes(1);
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.['turn-replay'])
      .toMatchObject({ phase: 'completed', reaction: { type: 'DONE' } });
    expect(readTurnFeedbackTerminalOutbox(process.env.SESSION_DATA_DIR!, record)).toBeUndefined();
    expect(activeSessions.size).toBe(0);
    expect(mocks.updateMessage).not.toHaveBeenCalled();
  });

  it('startup retains outbox when the Session is missing and fail-closes stale/conflicting generation', async () => {
    registerWith(true);
    const missing = terminalOutboxRecord({ session: { sessionId: 'missing' } } as DaemonSession, {
      sessionId: 'missing', workerGeneration: 2,
    });
    writeTurnFeedbackTerminalOutbox(process.env.SESSION_DATA_DIR!, missing);
    const ds = makeDs();
    ds.session.workerGeneration = 9;
    ds.session.turnFeedback = { 'turn-replay': {
      version: 1, turnId: 'turn-replay', messageId: 'om_replay', phase: 'processing',
      updatedAt: new Date().toISOString(),
    } };
    sessionStore.updateSession(ds.session);
    const stale = terminalOutboxRecord(ds, { workerGeneration: 8 });
    writeTurnFeedbackTerminalOutbox(process.env.SESSION_DATA_DIR!, stale);

    await startupRecovery({
      larkAppId: APP, restoreSessions: async () => [], markSessionsRestored: vi.fn(),
      driveRestoredXpiGroup: vi.fn(), driveRestoredPrincipalLane: vi.fn(),
    });

    expect(readTurnFeedbackTerminalOutbox(process.env.SESSION_DATA_DIR!, missing)).toEqual(missing);
    expect(readTurnFeedbackTerminalOutbox(process.env.SESSION_DATA_DIR!, stale)).toEqual(stale);
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.['turn-replay'].phase)
      .toBe('processing');
  });

  it('startup replays an attempted terminal only with exact durable attempt evidence', async () => {
    registerWith(true);
    const ds = makeDs();
    ds.session.workerGeneration = 10;
    ds.session.queuedActivationTurnId = 'turn-replay';
    ds.session.queuedActivationDispatchAttempt = 4;
    ds.session.turnFeedback = { 'turn-replay': {
      version: 1, turnId: 'turn-replay', messageId: 'om_replay', phase: 'processing',
      updatedAt: new Date().toISOString(), reaction: { id: 'old', type: 'GoGoGo' },
    } };
    sessionStore.updateSession(ds.session);
    providerOwn.set('om_replay', [{ id: 'old', type: 'GoGoGo' }]);
    const record = terminalOutboxRecord(ds, { workerGeneration: 10, dispatchAttempt: 4 });
    writeTurnFeedbackTerminalOutbox(process.env.SESSION_DATA_DIR!, record);

    await startupRecovery({
      larkAppId: APP, restoreSessions: async () => [], markSessionsRestored: vi.fn(),
      driveRestoredXpiGroup: vi.fn(), driveRestoredPrincipalLane: vi.fn(),
    });

    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.['turn-replay'].phase)
      .toBe('completed');
    expect(readTurnFeedbackTerminalOutbox(process.env.SESSION_DATA_DIR!, record)).toBeUndefined();
  });

  it('startup retains a terminal missing dispatch attempt when durable binding requires one', async () => {
    registerWith(true);
    const ds = makeDs();
    ds.session.workerGeneration = 16;
    ds.session.turnFeedback = { 'turn-replay': {
      version: 1, turnId: 'turn-replay', messageId: 'om_replay', phase: 'processing',
      updatedAt: new Date().toISOString(),
      capacityBinding: {
        adapter: 'codex', nativeTurnId: 'native', dispatchAttempt: 5, workerGeneration: 16,
      },
    } };
    sessionStore.updateSession(ds.session);
    const record = terminalOutboxRecord(ds, { workerGeneration: 16, dispatchAttempt: undefined });
    writeTurnFeedbackTerminalOutbox(process.env.SESSION_DATA_DIR!, record);

    await startupRecovery({
      larkAppId: APP, restoreSessions: async () => [], markSessionsRestored: vi.fn(),
      driveRestoredXpiGroup: vi.fn(), driveRestoredPrincipalLane: vi.fn(),
    });

    expect(readTurnFeedbackTerminalOutbox(process.env.SESSION_DATA_DIR!, record)).toEqual(record);
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.['turn-replay'].phase)
      .toBe('processing');
  });

  it('startup retains an attempted terminal when no durable source proves its attempt', async () => {
    registerWith(true);
    const ds = makeDs();
    ds.session.workerGeneration = 17;
    ds.session.turnFeedback = { 'turn-replay': {
      version: 1, turnId: 'turn-replay', messageId: 'om_replay', phase: 'processing',
      updatedAt: new Date().toISOString(),
    } };
    sessionStore.updateSession(ds.session);
    const record = terminalOutboxRecord(ds, { workerGeneration: 17, dispatchAttempt: 2 });
    writeTurnFeedbackTerminalOutbox(process.env.SESSION_DATA_DIR!, record);
    await startupRecovery({
      larkAppId: APP, restoreSessions: async () => [], markSessionsRestored: vi.fn(),
      driveRestoredXpiGroup: vi.fn(), driveRestoredPrincipalLane: vi.fn(),
    });
    expect(readTurnFeedbackTerminalOutbox(process.env.SESSION_DATA_DIR!, record)).toEqual(record);
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.['turn-replay'].phase)
      .toBe('processing');
  });

  it('refuses suspension before IPC handling when current worker outbox is already durable', async () => {
    registerWith(true);
    const worker = makeWorker();
    const ds = makeDs({ worker, initConfig: { backendType: 'tmux' } as any });
    ds.workerGeneration = 18; ds.session.workerGeneration = 18;
    const record = terminalOutboxRecord(ds, {
      terminalRequestId: 'efefefef-efef-4fef-8fef-efefefefefef',
      workerGeneration: 18, turnId: 'turn-pre-handler',
    });
    writeTurnFeedbackTerminalOutbox(process.env.SESSION_DATA_DIR!, record);
    __testOnly_setSuspendBackingVerifier(() => true);
    try {
      expect(suspendWorker(ds, 'idle_timeout')).toBe(false);
      expect(ds.worker).toBe(worker);
    } finally {
      __testOnly_setSuspendBackingVerifier();
    }
  });

  it('fences same-generation terminal persistence before backing destruction begins', () => {
    registerWith(true);
    const worker = makeWorker();
    const ds = makeDs({ worker, initConfig: { backendType: 'tmux' } as any });
    ds.workerGeneration = 21; ds.session.workerGeneration = 21;
    const late = terminalOutboxRecord(ds, {
      terminalRequestId: 'f2f2f2f2-f2f2-42f2-82f2-f2f2f2f2f2f2',
      workerGeneration: 21, turnId: 'turn-after-fence',
    });
    const destroy = vi.fn(() => true);
    __testOnly_setSuspendBackingVerifier(destroy);
    __testOnly_setSuspendPreparationVerifier(() => {
      writeTurnFeedbackTerminalOutbox(process.env.SESSION_DATA_DIR!, late);
      return true;
    });
    try {
      expect(suspendWorker(ds, 'idle_timeout')).toBe(false);
      expect(ds.worker).toBe(worker);
      expect(destroy).not.toHaveBeenCalled();
      expect(readTurnFeedbackTerminalOutbox(process.env.SESSION_DATA_DIR!, late)).toEqual(late);
    } finally {
      __testOnly_setSuspendPreparationVerifier();
      __testOnly_setSuspendBackingVerifier();
    }
  });

  it('cleans 513 exact-receipt lost-ACK records without exhausting outbox capacity', () => {
    registerWith(true);
    __testOnly_setSuspendBackingVerifier(() => true);
    try {
      for (let index = 0; index < 513; index += 1) {
        const worker = makeWorker();
        const generation = index + 30;
        const ds = makeDs({ worker, initConfig: { backendType: 'tmux' } as any });
        ds.workerGeneration = generation; ds.session.workerGeneration = generation;
        const suffix = index.toString(16).padStart(12, '0');
        const turnId = `turn-lost-ack-${index}`;
        const durable = terminalOutboxRecord(ds, {
          terminalRequestId: `abababab-abab-4bab-8bab-${suffix}`,
          workerGeneration: generation, turnId,
        });
        writeTurnFeedbackTerminalOutbox(process.env.SESSION_DATA_DIR!, durable);
        ds.session.turnFeedback = { [turnId]: {
          version: 1, turnId, messageId: `om_${index}`, phase: 'completed',
          updatedAt: new Date().toISOString(),
          terminalReceipt: {
            version: 1, terminalRequestId: durable.terminalRequestId,
            workerGeneration: generation, status: durable.status, savedAtMs: durable.savedAtMs,
          },
        } };
        expect(suspendWorker(ds, 'idle_timeout')).toBe(true);
        expect(readTurnFeedbackTerminalOutbox(process.env.SESSION_DATA_DIR!, durable)).toBeUndefined();
      }
    } finally {
      __testOnly_setSuspendBackingVerifier();
    }
  });

  it('allows suspension when a durable terminal belongs to an older worker generation', () => {
    registerWith(true);
    const worker = makeWorker();
    const ds = makeDs({ worker, initConfig: { backendType: 'tmux' } as any });
    ds.workerGeneration = 19; ds.session.workerGeneration = 19;
    writeTurnFeedbackTerminalOutbox(process.env.SESSION_DATA_DIR!, terminalOutboxRecord(ds, {
      terminalRequestId: 'f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0',
      workerGeneration: 18, turnId: 'turn-old-generation',
    }));
    __testOnly_setSuspendBackingVerifier(() => true);
    try {
      expect(suspendWorker(ds, 'idle_timeout')).toBe(true);
    } finally {
      __testOnly_setSuspendBackingVerifier();
    }
  });

  it('refuses suspension when the current worker outbox cannot be validated', () => {
    registerWith(true);
    const worker = makeWorker();
    const ds = makeDs({ worker, initConfig: { backendType: 'tmux' } as any });
    ds.workerGeneration = 20; ds.session.workerGeneration = 20;
    const record = terminalOutboxRecord(ds, {
      terminalRequestId: 'f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1',
      workerGeneration: 20, turnId: 'turn-malformed',
    });
    writeTurnFeedbackTerminalOutbox(process.env.SESSION_DATA_DIR!, record);
    writeFileSync(join(
      process.env.SESSION_DATA_DIR!, 'turn-feedback-terminal-outbox', APP,
      ds.session.sessionId, '20', `${record.terminalRequestId}.json`,
    ), '{malformed');
    __testOnly_setSuspendBackingVerifier(() => true);
    try {
      expect(suspendWorker(ds, 'idle_timeout')).toBe(false);
      expect(ds.worker).toBe(worker);
    } finally {
      __testOnly_setSuspendBackingVerifier();
    }
  });

  it('can use Get as the received reaction for substitute turns', async () => {
    registerWith(true);
    const ds = makeDs();

    await noteTurnReceived(ds, 'om_sub', undefined, undefined, undefined, 'Get');

    expect(mocks.addReactionOnce).toHaveBeenCalledWith(APP, 'om_sub', 'Get');
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_sub)
      .toMatchObject({ receivedReactionEmoji: 'Get', reaction: { type: 'Get' } });
  });

  it('substitute turn is card-off even when streaming card is globally enabled', async () => {
    registerWith(false);
    const ds = makeDs();
    const currentReplyTarget = {
      rootMessageId: 'om_trigger', turnId: 'om_a', updatedAt: new Date().toISOString(), substitute: true,
    };
    ds.currentReplyTarget = currentReplyTarget;
    ds.session.currentReplyTarget = currentReplyTarget;

    await noteTurnReceived(ds, 'om_a');

    expect(mocks.addReactionOnce).toHaveBeenCalledWith(APP, 'om_a', 'GoGoGo');
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_a)
      .toMatchObject({ reaction: { type: 'GoGoGo' } });
  });

  it('queued substitute turn A stays card-off after normal turn B overwrote the slot (per-turn gate)', async () => {
    registerWith(false);
    const ds = makeDs({
      // Slot points at the LATEST turn (normal B); the executing turn A is a
      // substitute turn recorded in the per-turn map.
      currentReplyTarget: { rootMessageId: 'om_b', turnId: 'om_b', updatedAt: new Date().toISOString() },
      session: {
        sessionId: 'sess-ab', chatId: 'oc_x', rootMessageId: 'om_root',
        replyTargets: {
          om_a: { rootMessageId: 'om_trigger_a', updatedAt: new Date().toISOString(), substitute: true },
          om_b: { rootMessageId: 'om_b', updatedAt: new Date().toISOString() },
        },
      },
    });

    await noteTurnReceived(ds, 'om_a');

    expect(mocks.addReactionOnce).toHaveBeenCalledWith(APP, 'om_a', 'GoGoGo');
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_a)
      .toMatchObject({ reaction: { type: 'GoGoGo' } });
  });

  it('reverse order: normal turn A keeps its card after substitute turn B overwrote the slot', async () => {
    registerWith(false);
    const ds = makeDs({
      currentReplyTarget: { rootMessageId: 'om_trigger_b', turnId: 'om_b', updatedAt: new Date().toISOString(), substitute: true },
      session: {
        sessionId: 'sess-ba', chatId: 'oc_x', rootMessageId: 'om_root',
        replyTargets: {
          om_a: { rootMessageId: 'om_a', updatedAt: new Date().toISOString() },
          om_b: { rootMessageId: 'om_trigger_b', updatedAt: new Date().toISOString(), substitute: true },
        },
      },
    });

    await noteTurnReceived(ds, 'om_a');

    // Normal turn A is card-on → no ack reaction for it, even though the slot
    // currently belongs to substitute turn B.
    expect(mocks.addReaction).not.toHaveBeenCalled();
    expect(ds.pendingAckReactions ?? []).toEqual([]);
  });

  it('a later non-substitute turn in the same session gets the streaming card back (no session latch)', async () => {
    registerWith(false);
    const ds = makeDs({
      // A direct @bot turn overwrote the reply target: substitute flag gone.
      currentReplyTarget: { rootMessageId: 'om_direct', turnId: 'om_b', updatedAt: new Date().toISOString() },
    });

    await noteTurnReceived(ds, 'om_b');

    expect(mocks.addReaction).not.toHaveBeenCalled();
    expect(ds.pendingAckReactions ?? []).toEqual([]);
  });

  it('silentTurnReactions suppresses receipt reactions in card-off sessions', async () => {
    registerWith(true, { silentTurnReactions: true });
    const ds = makeDs();

    await noteTurnReceived(ds, 'om_a');

    expect(mocks.addReaction).not.toHaveBeenCalled();
    expect(ds.pendingAckReactions ?? []).toEqual([]);
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_a).toMatchObject({ turnId: 'om_a' });
  });

  it('silentTurnReactions is a no-op when the streaming card is on (gate order)', async () => {
    // Card-on already early-returns before the silent gate, so the flag must not
    // perturb card-on behavior — same outcome as a plain card-on session.
    registerWith(false, { silentTurnReactions: true });
    const ds = makeDs();

    await noteTurnReceived(ds, 'om_a');

    expect(mocks.addReaction).not.toHaveBeenCalled();
    expect(ds.pendingAckReactions ?? []).toEqual([]);
  });

  it('skips non-message ids (doc-comment id / chat anchor cannot carry a reaction)', async () => {
    registerWith(true);
    const ds = makeDs();
    await noteTurnReceived(ds, 'comment_123');
    await noteTurnReceived(ds, 'oc_chat');
    expect(mocks.addReaction).not.toHaveBeenCalled();
    expect(ds.pendingAckReactions ?? []).toEqual([]);
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback).toMatchObject({
      comment_123: { turnId: 'comment_123', messageId: 'comment_123' },
      oc_chat: { turnId: 'oc_chat', messageId: 'oc_chat' },
    });
  });

  it('keys feedback by explicit turn id when one trigger message routes two turns', async () => {
    registerWith(false);
    const ds = makeDs();

    await noteTurnReceived(ds, 'om_shared', undefined, undefined, 'turn-a');
    await noteTurnReceived(ds, 'om_shared', undefined, undefined, 'turn-b');

    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback).toMatchObject({
      'turn-a': { turnId: 'turn-a', messageId: 'om_shared' },
      'turn-b': { turnId: 'turn-b', messageId: 'om_shared' },
    });
    expect(mocks.addReaction).not.toHaveBeenCalled();
  });

  it.each([
    ['human', false],
    ['unknown', undefined],
  ] as const)('captures a live-only %s requester without dropping its reply target', async (_label, requesterIsBot) => {
    registerWith(false);
    const ds = makeDs();
    const liveReplyTarget = {
      updatedAt: new Date().toISOString(),
      senderOpenId: 'ou_live_requester',
      participants: [{
        openId: 'ou_live_requester',
        ...(requesterIsBot === undefined ? {} : { isBot: requesterIsBot }),
      }],
    };
    ds.session.replyTargets = { turn_live: liveReplyTarget };

    await noteTurnReceived(ds, 'om_live_trigger', undefined, undefined, 'turn_live');

    const durable = sessionStore.getSessionFresh(ds.session.sessionId);
    expect(durable?.turnFeedback?.turn_live).toMatchObject({
      turnId: 'turn_live',
      messageId: 'om_live_trigger',
      requesterOpenId: 'ou_live_requester',
    });
    if (requesterIsBot === undefined) {
      expect(durable?.turnFeedback?.turn_live).not.toHaveProperty('requesterIsBot');
    } else {
      expect(durable?.turnFeedback?.turn_live?.requesterIsBot).toBe(requesterIsBot);
    }
    expect(ds.session.replyTargets?.turn_live).toEqual(liveReplyTarget);
    expect(durable?.replyTargets?.turn_live).toEqual(liveReplyTarget);
  });

  it('atomically retains the queued-message exact routing snapshot created before admission', async () => {
    registerWith(false);
    const ds = makeDs();
    const turnId = 'om_queued_turn';
    const updatedAt = '2026-10-27T09:00:00.000Z';
    ds.session.quoteTargetId = 'om_previous_trigger';
    ds.session.quoteTargetSenderOpenId = 'ou_previous';
    ds.session.quoteTargetSenderIsBot = true;
    beginReplyTargetTurn(ds, 'om_previous_topic', 'turn-previous', '2026-10-27T08:59:00.000Z', {
      senderOpenId: 'ou_previous',
      participants: [{ openId: 'ou_previous', isBot: true }],
      inThread: true,
    });
    sessionStore.updateSession(ds.session);
    ds.session.quoteTargetId = turnId;
    ds.session.quoteTargetSenderOpenId = 'ou_queued_human';
    ds.session.quoteTargetSenderIsBot = false;
    beginReplyTargetTurn(ds, 'om_queued_topic', turnId, updatedAt, {
      senderOpenId: 'ou_queued_human',
      participants: [{ openId: 'ou_queued_human', isBot: false }],
      inThread: true,
    });
    const expected = {
      replyTarget: structuredClone(ds.session.replyTargets?.[turnId]),
      replyContext: structuredClone(ds.session.turnReplyContexts?.[turnId]),
      current: structuredClone(ds.session.currentReplyTarget),
      alias: structuredClone(ds.session.replyThreadAliases?.om_queued_topic),
    };

    await noteTurnReceived(ds, turnId, undefined, undefined, turnId);

    const durable = sessionStore.getSessionFresh(ds.session.sessionId);
    for (const session of [ds.session, durable]) {
      expect(session?.replyTargets?.[turnId]).toEqual(expected.replyTarget);
      expect(session?.turnReplyContexts?.[turnId]).toEqual(expected.replyContext);
      expect(session?.currentReplyTarget).toEqual(expected.current);
      expect(session?.replyThreadAliases?.om_queued_topic).toEqual(expected.alias);
      expect(session).toMatchObject({
        quoteTargetId: turnId,
        quoteTargetSenderOpenId: 'ou_queued_human',
        quoteTargetSenderIsBot: false,
      });
    }
    expect(durable?.turnFeedback?.[turnId]).toMatchObject({
      turnId, requesterOpenId: 'ou_queued_human', requesterIsBot: false,
    });
  });

  it('atomically retains an Ask document turn routing and comment association', async () => {
    registerWith(false);
    const ds = makeDs();
    const turnId = 'codex-async-answer-fixture';
    const updatedAt = '2026-10-27T09:05:00.000Z';
    ds.session.quoteTargetId = 'om_async_origin';
    ds.session.quoteTargetSenderOpenId = 'ou_answerer';
    ds.session.quoteTargetSenderIsBot = false;
    beginReplyTargetTurn(ds, 'om_ask_topic', turnId, updatedAt, {
      senderOpenId: 'ou_answerer',
      participants: [{ openId: 'ou_answerer', isBot: false }],
      inThread: true,
    });
    (ds.session.docCommentTargets ??= {})[turnId] = {
      fileToken: 'doccn_fixture',
      fileType: 'docx',
      commentId: 'comment_fixture',
      replyToOpenId: 'ou_answerer',
      replyToName: 'Answerer',
      turnId,
    };
    const expected = {
      replyTarget: structuredClone(ds.session.replyTargets?.[turnId]),
      replyContext: structuredClone(ds.session.turnReplyContexts?.[turnId]),
      current: structuredClone(ds.session.currentReplyTarget),
      alias: structuredClone(ds.session.replyThreadAliases?.om_ask_topic),
      document: structuredClone(ds.session.docCommentTargets[turnId]),
    };

    await noteTurnReceived(ds, turnId, undefined, undefined, turnId);

    const durable = sessionStore.getSessionFresh(ds.session.sessionId);
    for (const session of [ds.session, durable]) {
      expect(session?.replyTargets?.[turnId]).toEqual(expected.replyTarget);
      expect(session?.turnReplyContexts?.[turnId]).toEqual(expected.replyContext);
      expect(session?.currentReplyTarget).toEqual(expected.current);
      expect(session?.replyThreadAliases?.om_ask_topic).toEqual(expected.alias);
      expect(session?.docCommentTargets?.[turnId]).toEqual(expected.document);
      expect(session).toMatchObject({
        quoteTargetId: 'om_async_origin',
        quoteTargetSenderOpenId: 'ou_answerer',
        quoteTargetSenderIsBot: false,
      });
    }
    expect(durable?.turnFeedback?.[turnId]).toMatchObject({
      turnId, requesterOpenId: 'ou_answerer', requesterIsBot: false,
    });
  });

  it('merges exact turn maps without overwriting newer durable routing slots', async () => {
    registerWith(false);
    const ds = makeDs();
    ds.session.quoteTargetId = 'om_newer_trigger';
    ds.session.quoteTargetSenderOpenId = 'ou_newer';
    ds.session.quoteTargetSenderIsBot = true;
    beginReplyTargetTurn(ds, 'om_newer_topic', 'turn-newer', '2026-10-27T09:10:00.000Z', {
      senderOpenId: 'ou_newer',
      participants: [{ openId: 'ou_newer', isBot: true }],
      inThread: true,
    });
    sessionStore.updateSession(ds.session);

    const turnId = 'turn-live-old-slot';
    ds.session.quoteTargetId = 'om_live_origin';
    ds.session.quoteTargetSenderOpenId = 'ou_live';
    ds.session.quoteTargetSenderIsBot = false;
    beginReplyTargetTurn(ds, 'om_live_topic', turnId, '2026-10-27T09:09:00.000Z', {
      senderOpenId: 'ou_live',
      participants: [{ openId: 'ou_live', isBot: false }],
      inThread: true,
    });
    (ds.session.docCommentTargets ??= {})[turnId] = {
      fileToken: 'doccn_live', fileType: 'docx', commentId: 'comment_live', turnId,
    };

    await noteTurnReceived(ds, turnId, undefined, undefined, turnId);

    const durable = sessionStore.getSessionFresh(ds.session.sessionId);
    expect(durable?.replyTargets?.[turnId]).toBeDefined();
    expect(durable?.turnReplyContexts?.[turnId]).toBeDefined();
    expect(durable?.replyThreadAliases?.om_live_topic).toBeDefined();
    expect(durable?.docCommentTargets?.[turnId]).toBeDefined();
    expect(durable?.currentReplyTarget?.turnId).toBe('turn-newer');
    expect(durable).toMatchObject({
      quoteTargetId: 'om_newer_trigger',
      quoteTargetSenderOpenId: 'ou_newer',
      quoteTargetSenderIsBot: true,
    });
  });

  it('selects newer durable routing and requester over stale live state for the same turn', async () => {
    registerWith(true);
    const ds = makeDs();
    const turnId = 'om_same_turn';

    ds.session.quoteTargetId = turnId;
    ds.session.quoteTargetSenderOpenId = 'ou_new';
    ds.session.quoteTargetSenderIsBot = true;
    beginReplyTargetTurn(ds, 'om_new_root', turnId, '2026-10-27T10:00:00.000Z', {
      senderOpenId: 'ou_new',
      participants: [{ openId: 'ou_new', isBot: true }],
      inThread: true,
    });
    const durableWinner = {
      replyTarget: structuredClone(ds.session.replyTargets?.[turnId]),
      replyContext: structuredClone(ds.session.turnReplyContexts?.[turnId]),
      current: structuredClone(ds.session.currentReplyTarget),
    };
    sessionStore.updateSession(ds.session);

    ds.session.quoteTargetId = turnId;
    ds.session.quoteTargetSenderOpenId = 'ou_old';
    ds.session.quoteTargetSenderIsBot = false;
    beginReplyTargetTurn(ds, 'om_old_root', turnId, '2026-10-27T09:00:00.000Z', {
      senderOpenId: 'ou_old',
      participants: [{ openId: 'ou_old', isBot: false }],
      inThread: true,
    });

    await noteTurnReceived(ds, turnId, undefined, undefined, turnId);
    await noteTurnReceived(ds, turnId, undefined, undefined, turnId);

    const durable = sessionStore.getSessionFresh(ds.session.sessionId);
    expect(durable?.replyTargets?.[turnId]).toEqual(durableWinner.replyTarget);
    expect(durable?.turnReplyContexts?.[turnId]).toEqual(durableWinner.replyContext);
    expect(durable?.currentReplyTarget).toEqual(durableWinner.current);
    expect(durable).toMatchObject({
      quoteTargetId: turnId,
      quoteTargetSenderOpenId: 'ou_new',
      quoteTargetSenderIsBot: true,
    });
    expect(durable?.turnFeedback?.[turnId]).toMatchObject({
      turnId,
      messageId: turnId,
      requesterOpenId: 'ou_new',
      requesterIsBot: true,
    });
    expect(ds.currentReplyTarget).toEqual(durable?.currentReplyTarget);
    expect(ds.replyThreadAliases).toEqual(durable?.replyThreadAliases);
    expect(mocks.addReactionOnce).toHaveBeenCalledTimes(1);
    expect(durable?.turnFeedback?.[turnId]).toMatchObject({ reaction: { type: 'GoGoGo' } });
  });

  it('keeps one durable winner on an equal-time conflicting live route', async () => {
    registerWith(false);
    const ds = makeDs();
    const turnId = 'om_equal_conflict';
    const updatedAt = '2026-10-27T10:00:00.000Z';
    ds.session.replyTargets = {
      [turnId]: {
        rootMessageId: 'om_durable_root', updatedAt, senderOpenId: 'ou_durable',
        participants: [{ openId: 'ou_durable', isBot: true }],
      },
    };
    ds.session.currentReplyTarget = { rootMessageId: 'om_durable_root', turnId, updatedAt };
    ds.session.quoteTargetId = turnId;
    ds.session.quoteTargetSenderOpenId = 'ou_durable';
    ds.session.quoteTargetSenderIsBot = true;
    sessionStore.updateSession(ds.session);

    ds.session.quoteTargetId = turnId;
    ds.session.quoteTargetSenderOpenId = 'ou_live';
    ds.session.quoteTargetSenderIsBot = false;
    beginReplyTargetTurn(ds, 'om_live_root', turnId, updatedAt, {
      senderOpenId: 'ou_live', participants: [{ openId: 'ou_live', isBot: false }], inThread: true,
    });
    (ds.session.docCommentTargets ??= {})[turnId] = {
      fileToken: 'doccn_losing', fileType: 'docx', commentId: 'comment_losing', turnId,
    };

    await noteTurnReceived(ds, turnId);

    const durable = sessionStore.getSessionFresh(ds.session.sessionId);
    expect(durable?.replyTargets?.[turnId]).toMatchObject({
      rootMessageId: 'om_durable_root', updatedAt, senderOpenId: 'ou_durable',
      participants: [{ openId: 'ou_durable', isBot: true }],
    });
    expect(durable?.currentReplyTarget).toEqual({ rootMessageId: 'om_durable_root', turnId, updatedAt });
    expect(durable).toMatchObject({
      quoteTargetId: turnId, quoteTargetSenderOpenId: 'ou_durable', quoteTargetSenderIsBot: true,
    });
    expect(durable?.turnFeedback?.[turnId]).toMatchObject({
      requesterOpenId: 'ou_durable', requesterIsBot: true,
    });
    expect(durable?.turnReplyContexts?.[turnId]).toBeUndefined();
    expect(durable?.docCommentTargets?.[turnId]).toBeUndefined();
    expect(durable?.replyThreadAliases?.om_live_root).toBeUndefined();
    expect(ds.currentReplyTarget).toEqual(durable?.currentReplyTarget);
    expect(ds.replyThreadAliases).toEqual(durable?.replyThreadAliases);
  });

  it('does not backfill absent metadata from an equal-time equivalent live route', async () => {
    registerWith(false);
    const ds = makeDs();
    const turnId = 'om_equal_equivalent';
    const updatedAt = '2026-10-27T10:05:00.000Z';
    const durableTarget = {
      rootMessageId: 'om_same_root', updatedAt, senderOpenId: 'ou_same',
      participants: [{ openId: 'ou_same', isBot: false }],
    };
    ds.session.replyTargets = { [turnId]: durableTarget };
    ds.session.currentReplyTarget = { rootMessageId: 'om_same_root', turnId, updatedAt };
    ds.session.quoteTargetId = turnId;
    ds.session.quoteTargetSenderOpenId = 'ou_same';
    ds.session.quoteTargetSenderIsBot = false;
    sessionStore.updateSession(ds.session);

    beginReplyTargetTurn(ds, 'om_same_root', turnId, updatedAt, {
      senderOpenId: 'ou_same', participants: [{ openId: 'ou_same', isBot: false }], inThread: true,
    });
    (ds.session.docCommentTargets ??= {})[turnId] = {
      fileToken: 'doccn_equal', fileType: 'docx', commentId: 'comment_equal', turnId,
    };

    await noteTurnReceived(ds, turnId);

    const durable = sessionStore.getSessionFresh(ds.session.sessionId);
    expect(durable?.replyTargets?.[turnId]).toEqual(durableTarget);
    expect(durable?.turnFeedback?.[turnId]).toMatchObject({
      requesterOpenId: 'ou_same', requesterIsBot: false,
    });
    expect(durable?.turnReplyContexts?.[turnId]).toBeUndefined();
    expect(durable?.docCommentTargets?.[turnId]).toBeUndefined();
    expect(durable?.replyThreadAliases?.om_same_root).toBeUndefined();
  });

  it('keeps a newer legacy current-only winner over stale live exact routing', async () => {
    registerWith(false);
    const ds = makeDs();
    const turnId = 'om_legacy_current_only';
    ds.session.currentReplyTarget = {
      rootMessageId: 'om_durable_root', turnId, updatedAt: '2026-10-27T10:00:00.000Z',
    };
    ds.session.quoteTargetId = turnId;
    ds.session.quoteTargetSenderOpenId = 'ou_durable';
    ds.session.quoteTargetSenderIsBot = true;
    sessionStore.updateSession(ds.session);

    ds.session.quoteTargetId = turnId;
    ds.session.quoteTargetSenderOpenId = 'ou_live';
    ds.session.quoteTargetSenderIsBot = false;
    beginReplyTargetTurn(ds, 'om_live_root', turnId, '2026-10-27T09:00:00.000Z', {
      senderOpenId: 'ou_live', participants: [{ openId: 'ou_live', isBot: false }], inThread: true,
    });
    (ds.session.docCommentTargets ??= {})[turnId] = {
      fileToken: 'doccn_stale', fileType: 'docx', commentId: 'comment_stale', turnId,
    };

    await noteTurnReceived(ds, turnId);

    const durable = sessionStore.getSessionFresh(ds.session.sessionId);
    expect(durable?.replyTargets?.[turnId]).toBeUndefined();
    expect(durable?.turnReplyContexts?.[turnId]).toBeUndefined();
    expect(durable?.docCommentTargets?.[turnId]).toBeUndefined();
    expect(durable?.replyThreadAliases?.om_live_root).toBeUndefined();
    expect(durable?.currentReplyTarget).toEqual({
      rootMessageId: 'om_durable_root', turnId, updatedAt: '2026-10-27T10:00:00.000Z',
    });
    expect(durable).toMatchObject({
      quoteTargetId: turnId, quoteTargetSenderOpenId: 'ou_durable', quoteTargetSenderIsBot: true,
    });
    expect(durable?.turnFeedback?.[turnId]).toMatchObject({ turnId, messageId: turnId });
    expect(durable?.turnFeedback?.[turnId]).not.toHaveProperty('requesterOpenId');
    expect(durable?.turnFeedback?.[turnId]).not.toHaveProperty('requesterIsBot');
    expect(ds.currentReplyTarget).toEqual(durable?.currentReplyTarget);
    expect(ds.replyThreadAliases).toEqual(durable?.replyThreadAliases);
  });

  it('linearizes type-ahead admission before trigger-user identity awaits', async () => {
    registerWith(false, { triggerUserAuth: true });
    const ds = makeDs();
    const releases = new Map<string, () => void>();
    mocks.publishTurnCliIdentity.mockImplementation(({ turnId }: { turnId?: string }) => (
      new Promise(resolve => { releases.set(turnId!, () => resolve([])); })
    ));
    const stage = (turnId: string, root: string, requester: string, updatedAt: string) => {
      ds.session.quoteTargetId = turnId;
      ds.session.quoteTargetSenderOpenId = requester;
      ds.session.quoteTargetSenderIsBot = false;
      beginReplyTargetTurn(ds, root, turnId, updatedAt, {
        senderOpenId: requester,
        participants: [{ openId: requester, isBot: false }],
        inThread: true,
      });
    };

    stage('om_typeahead_a', 'om_topic_a', 'ou_a', '2026-10-27T11:00:00.000Z');
    const admissionA = noteTurnReceived(ds, 'om_typeahead_a');
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_typeahead_a)
      .toMatchObject({ requesterOpenId: 'ou_a', requesterIsBot: false });

    stage('om_typeahead_b', 'om_topic_b', 'ou_b', '2026-10-27T11:01:00.000Z');
    const admissionB = noteTurnReceived(ds, 'om_typeahead_b');
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_typeahead_b)
      .toMatchObject({ requesterOpenId: 'ou_b', requesterIsBot: false });

    await vi.waitFor(() => expect(mocks.publishTurnCliIdentity).toHaveBeenCalledTimes(2));
    releases.get('om_typeahead_b')!();
    await admissionB;
    releases.get('om_typeahead_a')!();
    await admissionA;

    const durable = sessionStore.getSessionFresh(ds.session.sessionId);
    expect(Object.keys(durable?.turnFeedback ?? {})).toEqual(['om_typeahead_a', 'om_typeahead_b']);
    expect(Object.keys(durable?.replyTargets ?? {})).toEqual(['om_typeahead_a', 'om_typeahead_b']);
    expect(Object.keys(durable?.turnReplyContexts ?? {})).toEqual(['om_typeahead_a', 'om_typeahead_b']);
    expect(durable?.replyThreadAliases).toMatchObject({
      om_topic_a: expect.any(Object),
      om_topic_b: expect.any(Object),
    });
    expect(durable?.turnFeedback).toMatchObject({
      om_typeahead_a: { requesterOpenId: 'ou_a', requesterIsBot: false },
      om_typeahead_b: { requesterOpenId: 'ou_b', requesterIsBot: false },
    });
    expect(ds.currentReplyTarget).toEqual(durable?.currentReplyTarget);
    expect(ds.replyThreadAliases).toEqual(durable?.replyThreadAliases);
  });

  it('fails closed on multiple foreign live-only turns before identity or reaction effects', async () => {
    registerWith(true, { triggerUserAuth: true });
    const ds = makeDs();
    const stage = (turnId: string, root: string, requester: string, updatedAt: string) => {
      ds.session.quoteTargetId = turnId;
      ds.session.quoteTargetSenderOpenId = requester;
      ds.session.quoteTargetSenderIsBot = false;
      beginReplyTargetTurn(ds, root, turnId, updatedAt, {
        senderOpenId: requester,
        participants: [{ openId: requester, isBot: false }],
        inThread: true,
      });
    };
    stage('om_live_a', 'om_live_topic_a', 'ou_a', '2026-10-27T12:00:00.000Z');
    stage('om_live_b', 'om_live_topic_b', 'ou_b', '2026-10-27T12:01:00.000Z');
    const liveSession = ds.session;
    const before = structuredClone(ds.session);

    await expect(noteTurnReceived(ds, 'om_live_a')).rejects.toThrow('foreign live routing conflict');

    expect(ds.session).toBe(liveSession);
    expect(ds.session).toEqual(before);
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback).toBeUndefined();
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.replyTargets).toBeUndefined();
    expect(mocks.publishTurnCliIdentity).not.toHaveBeenCalled();
    expect(mocks.addReaction).not.toHaveBeenCalled();
  });

  it('persists an explicitly owned folded-root alias for the admitted turn', async () => {
    registerWith(false);
    const ds = makeDs();
    const turnId = 'om_folded_turn';
    beginReplyTargetTurn(ds, undefined, turnId, '2026-10-27T12:05:00.000Z', {
      senderOpenId: 'ou_folded',
      participants: [{ openId: 'ou_folded', isBot: false }],
      inThread: true,
      foldedRootId: 'om_folded_root',
    });
    expect(ds.session.replyTargets?.[turnId]?.rootMessageId).toBeUndefined();
    expect(ds.session.turnReplyContexts?.[turnId]?.target).toEqual({ mode: 'plain', chatId: 'oc_x' });
    expect(ds.session.currentReplyTarget).toBeUndefined();
    expect(ds.session.replyThreadAliases?.om_folded_root).toBeDefined();

    await noteTurnReceived(
      ds,
      turnId,
      undefined,
      undefined,
      turnId,
      undefined,
      ['om_folded_root'],
    );

    const durable = sessionStore.getSessionFresh(ds.session.sessionId);
    expect(durable?.turnFeedback?.[turnId]).toMatchObject({
      requesterOpenId: 'ou_folded', requesterIsBot: false,
    });
    expect(durable?.replyThreadAliases?.om_folded_root).toEqual({
      createdAt: '2026-10-27T12:05:00.000Z',
      lastUsedAt: '2026-10-27T12:05:00.000Z',
    });
    expect(ds.replyThreadAliases).toEqual(durable?.replyThreadAliases);
  });

  it('ignores an obsolete foreign alias when its durable owner moved to a newer root', async () => {
    registerWith(false);
    const ds = makeDs();
    const foreignTurnId = 'om_foreign_b';
    ds.session.quoteTargetId = foreignTurnId;
    ds.session.quoteTargetSenderOpenId = 'ou_b';
    ds.session.quoteTargetSenderIsBot = false;
    beginReplyTargetTurn(ds, 'om_b_new_root', foreignTurnId, '2026-10-27T10:00:00.000Z', {
      senderOpenId: 'ou_b', participants: [{ openId: 'ou_b', isBot: false }], inThread: true,
    });
    sessionStore.updateSession(ds.session);

    beginReplyTargetTurn(ds, 'om_b_old_root', foreignTurnId, '2026-10-27T09:00:00.000Z', {
      senderOpenId: 'ou_b', participants: [{ openId: 'ou_b', isBot: false }], inThread: true,
    });
    const admittedTurnId = 'om_admitted_a';
    ds.session.quoteTargetId = admittedTurnId;
    ds.session.quoteTargetSenderOpenId = 'ou_a';
    ds.session.quoteTargetSenderIsBot = false;
    beginReplyTargetTurn(ds, 'om_a_root', admittedTurnId, '2026-10-27T11:00:00.000Z', {
      senderOpenId: 'ou_a', participants: [{ openId: 'ou_a', isBot: false }], inThread: true,
    });

    await noteTurnReceived(ds, admittedTurnId);

    const durable = sessionStore.getSessionFresh(ds.session.sessionId);
    expect(durable?.turnFeedback?.[admittedTurnId]).toMatchObject({
      requesterOpenId: 'ou_a', requesterIsBot: false,
    });
    expect(durable?.replyTargets?.[foreignTurnId]).toMatchObject({
      rootMessageId: 'om_b_new_root', updatedAt: '2026-10-27T10:00:00.000Z',
    });
    expect(durable?.turnReplyContexts?.[foreignTurnId]?.target).toEqual({
      mode: 'thread', rootMessageId: 'om_b_new_root',
    });
    expect(durable?.replyThreadAliases?.om_b_new_root).toBeDefined();
    expect(durable?.replyThreadAliases?.om_b_old_root).toBeUndefined();
    expect(ds.replyThreadAliases).toEqual(durable?.replyThreadAliases);
  });

  it('ignores an obsolete current-only foreign alias after its durable owner moved roots', async () => {
    registerWith(false);
    const ds = makeDs();
    const foreignTurnId = 'om_legacy_foreign_b';
    ds.session.currentReplyTarget = {
      rootMessageId: 'om_b_current_new', turnId: foreignTurnId, updatedAt: '2026-10-27T10:00:00.000Z',
    };
    ds.session.replyThreadAliases = {
      om_b_current_new: {
        createdAt: '2026-10-27T10:00:00.000Z', lastUsedAt: '2026-10-27T10:00:00.000Z',
      },
    };
    sessionStore.updateSession(ds.session);

    ds.session.currentReplyTarget = {
      rootMessageId: 'om_b_current_old', turnId: foreignTurnId, updatedAt: '2026-10-27T09:00:00.000Z',
    };
    ds.session.replyThreadAliases = {
      om_b_current_old: {
        createdAt: '2026-10-27T09:00:00.000Z', lastUsedAt: '2026-10-27T09:00:00.000Z',
      },
    };
    const admittedTurnId = 'om_current_owner_a';
    ds.session.quoteTargetId = admittedTurnId;
    ds.session.quoteTargetSenderOpenId = 'ou_a';
    ds.session.quoteTargetSenderIsBot = false;
    beginReplyTargetTurn(ds, 'om_a_current_owner_root', admittedTurnId, '2026-10-27T11:00:00.000Z', {
      senderOpenId: 'ou_a', participants: [{ openId: 'ou_a', isBot: false }], inThread: true,
    });
    const liveForeignCurrent = {
      rootMessageId: 'om_b_current_old', turnId: foreignTurnId, updatedAt: '2026-10-27T09:00:00.000Z',
    };
    ds.session.currentReplyTarget = liveForeignCurrent;
    ds.currentReplyTarget = liveForeignCurrent;
    const aliases = {
      ...(ds.session.replyThreadAliases ?? {}),
      om_b_current_old: {
        createdAt: '2026-10-27T09:00:00.000Z', lastUsedAt: '2026-10-27T09:00:00.000Z',
      },
    };
    ds.session.replyThreadAliases = aliases;
    ds.replyThreadAliases = aliases;

    await noteTurnReceived(ds, admittedTurnId);

    const durable = sessionStore.getSessionFresh(ds.session.sessionId);
    expect(durable?.turnFeedback?.[admittedTurnId]).toMatchObject({
      requesterOpenId: 'ou_a', requesterIsBot: false,
    });
    expect(durable?.currentReplyTarget).toEqual({
      rootMessageId: 'om_b_current_new', turnId: foreignTurnId, updatedAt: '2026-10-27T10:00:00.000Z',
    });
    expect(durable?.replyThreadAliases?.om_b_current_new).toBeDefined();
    expect(durable?.replyThreadAliases?.om_b_current_old).toBeUndefined();
    expect(ds.currentReplyTarget).toEqual(durable?.currentReplyTarget);
    expect(ds.replyThreadAliases).toEqual(durable?.replyThreadAliases);
  });

  it('rejects an uncommitted foreign alias without a strictly newer durable owner route', async () => {
    registerWith(false);
    const ds = makeDs();
    const foreignTurnId = 'om_foreign_uncommitted';
    ds.session.quoteTargetId = foreignTurnId;
    ds.session.quoteTargetSenderOpenId = 'ou_b';
    ds.session.quoteTargetSenderIsBot = false;
    beginReplyTargetTurn(ds, 'om_b_root', foreignTurnId, '2026-10-27T10:00:00.000Z', {
      senderOpenId: 'ou_b', participants: [{ openId: 'ou_b', isBot: false }], inThread: true,
    });
    delete ds.session.replyThreadAliases?.om_b_root;
    sessionStore.updateSession(ds.session);

    const admittedTurnId = 'om_admitted_alias_guard';
    ds.session.quoteTargetId = admittedTurnId;
    ds.session.quoteTargetSenderOpenId = 'ou_a';
    ds.session.quoteTargetSenderIsBot = false;
    beginReplyTargetTurn(ds, 'om_a_guard_root', admittedTurnId, '2026-10-27T11:00:00.000Z', {
      senderOpenId: 'ou_a', participants: [{ openId: 'ou_a', isBot: false }], inThread: true,
    });
    const aliases = {
      ...(ds.session.replyThreadAliases ?? {}),
      om_b_root: {
        createdAt: '2026-10-27T10:00:00.000Z', lastUsedAt: '2026-10-27T10:00:00.000Z',
      },
    };
    ds.session.replyThreadAliases = aliases;
    ds.replyThreadAliases = aliases;
    const before = structuredClone(ds.session);
    expect(ds.session.replyThreadAliases?.om_b_root).toBeDefined();
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.replyThreadAliases?.om_b_root).toBeUndefined();

    await expect(noteTurnReceived(ds, admittedTurnId))
      .rejects.toThrow('foreign live routing conflict: replyThreadAliases');

    expect(ds.session).toEqual(before);
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.[admittedTurnId]).toBeUndefined();
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.replyThreadAliases?.om_b_root).toBeUndefined();
  });

  it('persists a stamped meeting-origin turn before the reaction early return', async () => {
    registerWith(true);
    const ds = makeDs();
    ds.session.vcMeetingReceiver = { listenerAppId: 'listener-app', meetingId: 'meeting-1', memberId: 'member-1', memberEpoch: 1 };
    ds.session.vcMeetingImTurnOrigins = {
      om_meeting: {
        listenerAppId: 'listener-app', meetingId: 'meeting-1', memberId: 'member-1', memberEpoch: 1,
        agentAppId: APP, ownerBootId: 'boot-1', ownerEpoch: 1, membershipGeneration: 1,
        sinkOwnerGeneration: 1, receiverSessionId: ds.session.sessionId, larkMessageId: 'om_meeting',
      },
    };
    sessionStore.updateSession(ds.session);

    await noteTurnReceived(ds, 'om_meeting');

    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_meeting).toMatchObject({ turnId: 'om_meeting' });
    expect(mocks.addReaction).not.toHaveBeenCalled();
  });

  it('fails closed before reaction when admission persistence fails', async () => {
    registerWith(true, { triggerUserAuth: true });
    const ds = makeDs();
    sessionStore.__testOnly_setBeforeRowPersist(() => { throw new Error('simulated feedback admission failure'); });

    await expect(noteTurnReceived(ds, 'om_fail')).rejects.toThrow('simulated feedback admission failure');

    expect(mocks.addReaction).not.toHaveBeenCalled();
    expect(mocks.publishTurnCliIdentity).not.toHaveBeenCalled();
    expect(ds.pendingAckReactions ?? []).toEqual([]);
  });

  it('type-ahead: two messages while busy each get 冲! then both flip to ✅ at idle', async () => {
    registerWith(true);
    const ds = makeDs();
    // B arrives while A is still being processed — no second working edge, but
    // each accepted message still gets its own ✋ because we bind to the message.
    await noteTurnReceived(ds, 'om_a');
    await noteTurnReceived(ds, 'om_b');
    expect(mocks.addReactionOnce).toHaveBeenCalledTimes(2);
    await turnFeedbackReconciler.terminal(ds, 'om_a', 'completed');
    await turnFeedbackReconciler.terminal(ds, 'om_b', 'completed');

    expect(mocks.removeReactionDetailed).toHaveBeenCalledTimes(2);
    expect(mocks.addReactionOnce).toHaveBeenCalledWith(APP, 'om_a', 'DONE');
    expect(mocks.addReactionOnce).toHaveBeenCalledWith(APP, 'om_b', 'DONE');
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback).toMatchObject({
      om_a: { phase: 'completed', reaction: { type: 'DONE' } },
      om_b: { phase: 'completed', reaction: { type: 'DONE' } },
    });
  });

  it('silentTurnReactions clears pending received reactions without adding DONE', async () => {
    registerWith(true, { silentTurnReactions: true });
    const ds = makeDs({
      pendingAckReactions: [
        { messageId: 'om_a', reactionId: 'rid_om_a' },
        { messageId: 'om_b', reactionId: 'rid_om_b' },
      ],
    });

    await finishTurnReactions(ds);

    expect(mocks.removeReaction).toHaveBeenCalledWith(APP, 'om_a', 'rid_om_a');
    expect(mocks.removeReaction).toHaveBeenCalledWith(APP, 'om_b', 'rid_om_b');
    expect(mocks.addReaction).not.toHaveBeenCalled();
    expect(ds.pendingAckReactions).toEqual([]);
  });

  it('does not register an in-flight ✋ that a concurrent idle could DONE prematurely', async () => {
    registerWith(true);
    const ds = makeDs();
    // addReactionOnce for B hangs until released — simulating a slow Lark round-trip
    // while a previous turn finishes.
    let releaseB!: (value: { status: 'created'; id: string }) => void;
    const bPending = new Promise<{ status: 'created'; id: string }>((resolve) => { releaseB = resolve; });
    mocks.addReactionOnce.mockReturnValueOnce(bPending);

    const notePromise = noteTurnReceived(ds, 'om_b'); // in flight, not yet awaited

    // A previous turn's legacy idle fires while CREATE(om_b) is still pending.
    await finishTurnReactions(ds);
    expect(mocks.addReactionOnce).not.toHaveBeenCalledWith(APP, 'om_b', 'DONE');
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_b)
      .toMatchObject({
        phase: 'processing',
        reactionReconcilePending: true,
        reactionOperation: { phase: 'add_pending', desiredType: 'GoGoGo' },
      });

    releaseB({ status: 'created', id: 'rid_om_b' });
    await notePromise;
    providerOwn.set('om_b', [{ id: 'rid_om_b', type: 'GoGoGo' }]);
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_b)
      .toMatchObject({ reaction: { id: 'rid_om_b', type: 'GoGoGo' } });

    await turnFeedbackReconciler.terminal(ds, 'om_b', 'completed');
    expect(mocks.removeReactionDetailed).toHaveBeenCalledWith(APP, 'om_b', 'rid_om_b');
    expect(mocks.addReactionOnce).toHaveBeenCalledWith(APP, 'om_b', 'DONE');
  });

  it('finishTurnReactions with no pending acks is a no-op', async () => {
    const ds = makeDs();
    await finishTurnReactions(ds);
    expect(mocks.removeReaction).not.toHaveBeenCalled();
    expect(mocks.addReaction).not.toHaveBeenCalled();
  });

  it('custom emoji: bots.json overrides the received / done emoji_type', async () => {
    registerWith(true, { receivedReactionEmoji: 'OK', doneReactionEmoji: 'Thumbsup' });
    const ds = makeDs();

    await noteTurnReceived(ds, 'om_a');
    expect(mocks.addReactionOnce).toHaveBeenCalledWith(APP, 'om_a', 'OK');

    await turnFeedbackReconciler.terminal(ds, 'om_a', 'completed');
    expect(mocks.addReactionOnce).toHaveBeenCalledWith(APP, 'om_a', 'Thumbsup');
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_a)
      .toMatchObject({ phase: 'completed', reaction: { type: 'Thumbsup' } });
  });

  it('received == done emoji: turn-end keeps the marker unchanged (Pi premature-idle guard)', async () => {
    // Both configured to GoGoGo — a premature idle removes then re-adds the same
    // 冲!, so a misleading ✅ never appears even if idle fires mid-turn.
    registerWith(true, { receivedReactionEmoji: 'GoGoGo', doneReactionEmoji: 'GoGoGo' });
    const ds = makeDs();

    await noteTurnReceived(ds, 'om_a');
    expect(mocks.addReactionOnce).toHaveBeenCalledWith(APP, 'om_a', 'GoGoGo');

    await turnFeedbackReconciler.terminal(ds, 'om_a', 'completed');
    expect(mocks.removeReactionDetailed).not.toHaveBeenCalled();
    expect(mocks.addReactionOnce).toHaveBeenCalledTimes(1);
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_a)
      .toMatchObject({ phase: 'completed', reaction: { type: 'GoGoGo' } });
  });
});

/**
 * Behavioral pin for PR #633 review P2: card-off finishTurnReactions requires a
 * working→idle edge. Argv cold-start (Pi/Gemini) must seed working before idle
 * (worker side); daemon-side, bare undefined→idle must NOT flip, while the
 * seeded working→idle sequence must.
 */
describe('turn reaction screen_update behavioral gate', () => {
  function makeFakeWorker() {
    const worker = new EventEmitter() as any;
    worker.killed = false;
    worker.send = vi.fn();
    worker.kill = vi.fn();
    worker.pid = 4242;
    worker.stdout = new EventEmitter();
    worker.stderr = new EventEmitter();
    return worker;
  }

  async function flush(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0));
    // finishTurnReactions is fire-and-forget void; wait a tick for awaits
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SESSION_DATA_DIR = mkdtempSync(join(tmpdir(), 'botmux-react-behav-'));
    sessionStore.init(APP);
    mocks.addReaction.mockImplementation(async (_app: string, msgId: string) => `rid_${msgId}`);
    mocks.removeReaction.mockResolvedValue(undefined);
    registerWith(true);
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
  });

  it('undefined→idle alone does not DONE pending GoGoGo (gate)', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({
      worker,
      workerPort: 9999,
      lastScreenStatus: undefined,
      pendingAckReactions: [{ messageId: 'om_a', reactionId: 'rid_om_a' }],
    });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', { type: 'screen_update', content: 'done?', status: 'idle' });
    await flush();

    expect(mocks.removeReaction).not.toHaveBeenCalled();
    expect(mocks.addReaction).not.toHaveBeenCalledWith(APP, 'om_a', 'DONE');
    expect(ds.pendingAckReactions?.map(a => a.messageId)).toEqual(['om_a']);
  });

  it('working→idle flips pending GoGoGo to DONE (argv seed / flushPending path)', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({
      worker,
      workerPort: 9999,
      lastScreenStatus: undefined,
      pendingAckReactions: [{ messageId: 'om_a', reactionId: 'rid_om_a' }],
    });
    __testOnly_setupWorkerHandlers(ds, worker);

    // Mirrors markPromptReady seeding working then idle for quiescence argv CLIs.
    worker.emit('message', { type: 'screen_update', content: 'busy', status: 'working' });
    await flush();
    worker.emit('message', { type: 'screen_update', content: 'ready', status: 'idle' });
    await flush();

    expect(mocks.removeReaction).toHaveBeenCalledWith(APP, 'om_a', 'rid_om_a');
    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_a', 'DONE');
    expect(ds.pendingAckReactions).toEqual([]);
  });

  it('working→limited does NOT DONE (rate limit is a blocked turn, not completion)', async () => {
    // A limited settle means the CLI is stuck on a rate/usage limit. DONE-ing
    // the ✋ here made users think the task finished while it actually stalled;
    // the proactive rate-limit notification (test/rate-limit-notify.test.ts)
    // owns that attention instead. The ✋ must stay until a real idle settle.
    const worker = makeFakeWorker();
    const ds = makeDs({
      worker,
      workerPort: 9999,
      lastScreenStatus: undefined,
      pendingAckReactions: [{ messageId: 'om_a', reactionId: 'rid_om_a' }],
    });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', {
      type: 'screen_update',
      content: 'Rate limit exceeded. Try again at 10:36 PM.',
      status: 'working',
    });
    await flush();
    worker.emit('message', {
      type: 'screen_update',
      content: 'Rate limit exceeded. Try again at 10:36 PM.',
      status: 'limited',
      usageLimit: {
        limited: true,
        kind: 'rate',
        retryAtMs: Date.now() + 60_000,
        retryLabel: '10:36 PM',
        retryReady: false,
      },
    });
    await flush();

    expect(mocks.removeReaction).not.toHaveBeenCalled();
    expect(mocks.addReaction).not.toHaveBeenCalledWith(APP, 'om_a', 'DONE');
    expect(ds.pendingAckReactions?.map(a => a.messageId)).toEqual(['om_a']);
  });

  it('limited→limited alone does not DONE (no working edge)', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({
      worker,
      workerPort: 9999,
      lastScreenStatus: undefined,
      pendingAckReactions: [{ messageId: 'om_a', reactionId: 'rid_om_a' }],
    });
    __testOnly_setupWorkerHandlers(ds, worker);

    const limitedMsg = {
      type: 'screen_update' as const,
      content: 'Rate limit exceeded. Try again at 10:36 PM.',
      status: 'limited' as const,
      usageLimit: {
        limited: true as const,
        kind: 'rate' as const,
        retryAtMs: Date.now() + 60_000,
        retryLabel: '10:36 PM',
        retryReady: false,
      },
    };
    worker.emit('message', limitedMsg);
    await flush();
    worker.emit('message', limitedMsg);
    await flush();

    expect(mocks.addReaction).not.toHaveBeenCalledWith(APP, 'om_a', 'DONE');
    expect(ds.pendingAckReactions?.map(a => a.messageId)).toEqual(['om_a']);
  });
});

