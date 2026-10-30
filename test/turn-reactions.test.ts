/**
 * Two-phase turn reactions (auto-on for card-off sessions, i.e. streaming card disabled):
 *   - noteTurnReceived(ds, msgId): react 冲! (GoGoGo) the instant a user message
 *     is accepted for the session. Owned sessions persist exact turn state;
 *     unowned compatibility ingress gets a fail-closed best-effort receipt.
 *   - Only the durable exact terminal turns owned reactions into DONE or ERROR;
 *     screen idle never proves completion.
 *
 * Binding the "received" reaction to the message (not a worker status edge) is
 * what makes type-ahead / busy-batched messages each get their own reaction —
 * the regression this test locks (Codex review of the patch-removal change).
 *
 * Run:  pnpm vitest run test/turn-reactions.test.ts
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const mocks = vi.hoisted(() => ({
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
  ownReactions: new Map<string, Array<{ id: string; type: string }>>(),
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
  return { ...actual, addReaction: mocks.addReaction, removeReaction: mocks.removeReaction };
});

vi.mock('../src/im/lark/reaction-provider.js', () => ({
  listOwnReactions: vi.fn(async (_app: string, messageId: string) => ({
    kind: 'listed', reactions: structuredClone(mocks.ownReactions.get(messageId) ?? []),
  })),
  createReactionOnce: vi.fn(async (app: string, messageId: string, type: string) => {
    const id = await mocks.addReaction(app, messageId, type);
    mocks.ownReactions.set(messageId, [...(mocks.ownReactions.get(messageId) ?? []), { id, type }]);
    return { kind: 'created', reaction: { id, type } };
  }),
  deleteReactionOnce: vi.fn(async (app: string, messageId: string, reactionId: string) => {
    await mocks.removeReaction(app, messageId, reactionId);
    mocks.ownReactions.set(
      messageId,
      (mocks.ownReactions.get(messageId) ?? []).filter(reaction => reaction.id !== reactionId),
    );
    return { kind: 'deleted' };
  }),
}));
vi.mock('../src/core/turn-cli-identity.js', async () => {
  const actual = await vi.importActual<any>('../src/core/turn-cli-identity.js');
  return { ...actual, publishTurnCliIdentity: mocks.publishTurnCliIdentity };
});

import { getBot, registerBot } from '../src/bot-registry.js';
import {
  noteTurnReceived,
  handleOwnedTurnFeedbackTerminal,
  createTurnFeedbackWorkerCallbacks,
  createProductionTurnFeedbackWorkerCallbacks,
  __testOnly_applyLiveTurnFeedbackTerminal as applyLiveFeedbackTerminal,
  __testOnly_turnFeedbackReconciler as feedbackReconciler,
} from '../src/daemon.js';
import * as sessionStore from '../src/services/session-store.js';
import { beginReplyTargetTurn } from '../src/core/reply-target.js';
import {
  initWorkerPool,
  __testOnly_setupWorkerHandlers,
} from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';

const APP = 'reaction_app';

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
    mocks.publishTurnCliIdentity.mockResolvedValue([]);
    mocks.ownReactions.clear();
    process.env.SESSION_DATA_DIR = mkdtempSync(join(tmpdir(), 'botmux-react-'));
    sessionStore.init(APP);
    mocks.addReaction.mockImplementation(async (_app: string, msgId: string) => `rid_${msgId}`);
    mocks.removeReaction.mockResolvedValue(undefined);
    mocks.publishTurnCliIdentity.mockResolvedValue([]);
  });

  afterEach(() => {
    sessionStore.__testOnly_setBeforeRowPersist(undefined);
  });

  it('用户身份刷新期间展示收到表情，身份就绪后完成接收登记', async () => {
    registerWith(true);
    getBot(APP).config.triggerUserAuth = { enabled: true, tools: ['lark-cli'] };
    const ds = makeDs();
    let releaseIdentity!: () => void;
    mocks.publishTurnCliIdentity.mockImplementationOnce(() => new Promise<void>(resolve => {
      releaseIdentity = resolve;
    }));
    let accepted = false;
    const receiving = noteTurnReceived(ds, 'om_slow_auth').then(() => { accepted = true; });

    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_slow_auth)
      .toMatchObject({ phase: 'processing' });
    expect(accepted).toBe(false);
    await vi.waitFor(() => expect(mocks.publishTurnCliIdentity).toHaveBeenCalledTimes(1));
    expect(accepted).toBe(false);

    releaseIdentity();
    await receiving;
    expect(accepted).toBe(true);
    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_slow_auth', 'GoGoGo');
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_slow_auth?.reaction)
      .toEqual({ id: 'rid_om_slow_auth', type: 'GoGoGo' });
  });

  it('连续两位发送者分别按消息绑定本轮身份', async () => {
    registerWith(true);
    getBot(APP).config.triggerUserAuth = { enabled: true, tools: ['lark-cli'] };
    const ds = makeDs();
    ds.session.replyTargets = {
      om_user_a: { rootMessageId: 'om_user_a', senderOpenId: 'ou_user_a', participants: [{ openId: 'ou_user_a', isBot: false }], updatedAt: new Date().toISOString() },
      om_user_b: { rootMessageId: 'om_user_b', senderOpenId: 'ou_user_b', participants: [{ openId: 'ou_user_b', isBot: false }], updatedAt: new Date().toISOString() },
    };
    sessionStore.updateSession(ds.session);
    await Promise.all([noteTurnReceived(ds, 'om_user_a'), noteTurnReceived(ds, 'om_user_b')]);
    expect(mocks.publishTurnCliIdentity).toHaveBeenCalledWith(expect.objectContaining({
      turnId: 'om_user_a', senderOpenId: 'ou_user_a',
    }));
    expect(mocks.publishTurnCliIdentity).toHaveBeenCalledWith(expect.objectContaining({
      turnId: 'om_user_b', senderOpenId: 'ou_user_b',
    }));
    expect(Object.keys(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback ?? {}).sort())
      .toEqual(['om_user_a', 'om_user_b']);
  });

  it.each(['card', 'silent', 'comment', 'duplicate', 'failed'])(
    '接收路径 %s 完成本轮身份准备', async path => {
      registerWith(path !== 'card', { silentTurnReactions: path === 'silent' });
      getBot(APP).config.triggerUserAuth = { enabled: true, tools: ['lark-cli'] };
      const ds = makeDs();
      if (path === 'failed') mocks.addReaction.mockRejectedValueOnce(new Error('transport'));
      await noteTurnReceived(ds, path === 'comment' ? 'comment_auth' : 'om_auth');
      expect(mocks.publishTurnCliIdentity).toHaveBeenCalledTimes(1);
    },
  );

  it('streaming card on (default): no reaction on receipt', async () => {
    registerWith(false);
    const ds = makeDs();
    await noteTurnReceived(ds, 'om_a');
    expect(mocks.addReaction).not.toHaveBeenCalled();
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_a).toMatchObject({
      version: 1, turnId: 'om_a', messageId: 'om_a', phase: 'processing',
    });
    expect(ds.turnReceivedAtMs).toBeUndefined();
    getBot(APP).config.showReplyTiming = true;
    await noteTurnReceived(ds, 'om_b', undefined, undefined, 'om_actual_turn');
    expect(ds.turnReceivedAtMs?.get('om_actual_turn')).toEqual(expect.any(Number));
    expect(ds.turnReceivedAtMs?.has('om_b')).toBe(false);
  });

  it('does not persist feedback through an unrelated store row with the same session id', async () => {
    registerWith(true);
    const durableOwner = makeDs();
    const synthetic = {
      ...durableOwner,
      session: structuredClone(durableOwner.session),
    } as DaemonSession;

    await noteTurnReceived(synthetic, 'om_synthetic_same_id');

    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_synthetic_same_id', 'GoGoGo');
    expect(sessionStore.getOwnedSession(durableOwner.session.sessionId)?.turnFeedback
      ?.om_synthetic_same_id).toBeUndefined();
  });

  it('does not reconcile an existing durable feedback row through a detached same-id session', async () => {
    registerWith(true);
    const durableOwner = makeDs();
    durableOwner.session.turnFeedback = {
      om_existing: {
        version: 1, turnId: 'om_existing', messageId: 'om_existing',
        phase: 'capacity_waiting', updatedAt: new Date().toISOString(),
        reaction: { id: 'rid_existing', type: 'GoGoGo' },
      },
    };
    sessionStore.updateSession(durableOwner.session);
    const before = structuredClone(sessionStore.getSessionFresh(durableOwner.session.sessionId));
    const detached = {
      ...durableOwner,
      session: structuredClone(durableOwner.session),
    } as DaemonSession;

    await noteTurnReceived(detached, 'om_existing');

    expect(sessionStore.getSessionFresh(durableOwner.session.sessionId)).toEqual(before);
  });

  it('does not settle a durable owner row from a detached same-id terminal seam', async () => {
    registerWith(true);
    const durableOwner = makeDs();
    await noteTurnReceived(durableOwner, 'om_detached_terminal');
    mocks.addReaction.mockClear();
    mocks.removeReaction.mockClear();
    const detached = {
      ...durableOwner,
      session: structuredClone(durableOwner.session),
    } as DaemonSession;

    await createTurnFeedbackWorkerCallbacks().onTurnTerminal!(detached, {
      turnId: 'om_detached_terminal', status: 'completed', completedAtMs: Date.now(),
    }, { workerGeneration: detached.workerGeneration ?? 1 });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(sessionStore.getSessionFresh(durableOwner.session.sessionId)?.turnFeedback
      ?.om_detached_terminal?.phase).toBe('processing');
    expect(mocks.removeReaction).not.toHaveBeenCalled();
    expect(mocks.addReaction).not.toHaveBeenCalled();
  });

  it('settles an exact terminal through the production seam after store restore', async () => {
    registerWith(true);
    const original = makeDs();
    await noteTurnReceived(original, 'om_restored_terminal');
    const sessionId = original.session.sessionId;
    sessionStore.init(APP);
    const restoredSession = sessionStore.getSession(sessionId)!;
    const restored = {
      ...original,
      session: restoredSession,
    } as DaemonSession;
    mocks.addReaction.mockClear();
    mocks.removeReaction.mockClear();

    await createTurnFeedbackWorkerCallbacks().onTurnTerminal!(restored, {
      turnId: 'om_restored_terminal', status: 'completed', completedAtMs: Date.now(),
    }, { workerGeneration: restored.workerGeneration ?? 1 });
    await feedbackReconciler.reconcile(restored, 'om_restored_terminal');

    expect(sessionStore.getSessionFresh(sessionId)?.turnFeedback?.om_restored_terminal?.phase)
      .toBe('completed');
    expect(mocks.removeReaction).toHaveBeenCalledWith(APP, 'om_restored_terminal', 'rid_om_restored_terminal');
    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_restored_terminal', 'DONE');
  });

  it.each([false, true])('production terminal decorator forwards the exact tuple once (owned=%s)', async owned => {
    const durableOwner = makeDs();
    const ds = owned ? durableOwner : {
      ...durableOwner,
      session: structuredClone(durableOwner.session),
    } as DaemonSession;
    const terminal = {
      turnId: 'om_forwarded_terminal', status: 'completed' as const, completedAtMs: Date.now(),
    };
    const context = { workerGeneration: 7 };
    const next = vi.fn(async () => undefined);

    await createTurnFeedbackWorkerCallbacks(next).onTurnTerminal!(ds, terminal, context);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(ds, terminal, context);
  });

  it.each([
    ['matching generation and turn', 3, 'om_checkpoint', 'cancelled'],
    ['wrong generation', 4, 'om_checkpoint', 'running'],
    ['wrong turn', 3, 'om_other', 'running'],
  ] as const)('production terminal composition retires deployment continuation for %s', async (
    _label, workerGeneration, terminalTurnId, expectedState,
  ) => {
    const ds = makeDs();
    Object.assign(ds.session, {
      larkAppId: APP, cliId: 'codex', backendType: 'tmux', cliSessionId: 'native-checkpoint',
    });
    ds.session.deploymentContinuation = {
      state: 'running', turnId: 'om_checkpoint', nativeSessionId: 'native-checkpoint',
      caller: { senderType: 'user', requestLarkAppId: APP, requestUserOpenId: 'ou_checkpoint' },
      workerGeneration: 3, consumedAt: Date.now(),
    };
    sessionStore.updateDeploymentContinuation(ds.session);
    await createProductionTurnFeedbackWorkerCallbacks().onTurnTerminal!(ds, {
      turnId: terminalTurnId, status: 'completed', completedAtMs: Date.now(),
    }, { workerGeneration });

    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.deploymentContinuation?.state)
      .toBe(expectedState);
  });

  it.each([true, false])('unified replies retain the independent status-card reaction gate (off=%s)', async statusOff => {
    registerWith(statusOff, { replyCardMode: 'unified' });
    const ds = makeDs();
    await noteTurnReceived(ds, 'om_status_toggle');
    expect(mocks.addReaction).toHaveBeenCalledTimes(statusOff ? 1 : 0);
  });

  it('Plan B: a meeting-agent session reacts to plain user turns like any card-off session', async () => {
    registerWith(true);
    const ds = makeDs();
    // The vcMeetingReceiver marker is now pure delivery metadata. A plain user
    // message remains a durable ordinary turn.
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app',
      meetingId: 'meeting-1',
      memberId: 'member-1',
      memberEpoch: 1,
    };

    await noteTurnReceived(ds, 'om_new');

    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_new', 'GoGoGo');
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_new)
      .toMatchObject({ phase: 'processing', messageId: 'om_new' });
  });

  it('reacts 冲! (GoGoGo) on each accepted message and dedups by message id', async () => {
    registerWith(true);
    const ds = makeDs();
    mocks.addReaction.mockImplementationOnce(async (_app: string, msgId: string) => {
      expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_a).toMatchObject({
        turnId: 'om_a', messageId: 'om_a', phase: 'processing',
      });
      return `rid_${msgId}`;
    });
    await noteTurnReceived(ds, 'om_a');
    const firstAdmission = structuredClone(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_a);
    await noteTurnReceived(ds, 'om_a'); // same message — must not double-react
    await noteTurnReceived(ds, 'om_b');
    expect(mocks.addReaction).toHaveBeenCalledTimes(2);
    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_a', 'GoGoGo');
    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_b', 'GoGoGo');
    expect(Object.values(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback ?? {})
      .map(record => record.messageId)).toEqual(['om_a', 'om_b']);
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_a).toEqual(firstAdmission);
    expect(Object.keys(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback ?? {})).toEqual(['om_a', 'om_b']);
  });

  it('can use Get as the received reaction for substitute turns', async () => {
    registerWith(true);
    const ds = makeDs();

    await noteTurnReceived(ds, 'om_sub', undefined, undefined, undefined, 'Get');

    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_sub', 'Get');
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_sub?.reaction?.type).toBe('Get');
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_sub?.receivedReactionEmoji).toBe('Get');
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

    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_a', 'GoGoGo');
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_a?.reaction?.type).toBe('GoGoGo');
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

    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_a', 'GoGoGo');
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
  });

  it('a later non-substitute turn in the same session gets the streaming card back (no session latch)', async () => {
    registerWith(false);
    const ds = makeDs({
      // A direct @bot turn overwrote the reply target: substitute flag gone.
      currentReplyTarget: { rootMessageId: 'om_direct', turnId: 'om_b', updatedAt: new Date().toISOString() },
    });

    await noteTurnReceived(ds, 'om_b');

    expect(mocks.addReaction).not.toHaveBeenCalled();
  });

  it('silentTurnReactions suppresses receipt reactions in card-off sessions', async () => {
    registerWith(true, { silentTurnReactions: true });
    const ds = makeDs();

    await noteTurnReceived(ds, 'om_a');

    expect(mocks.addReaction).not.toHaveBeenCalled();
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_a).toMatchObject({ turnId: 'om_a' });
  });

  it('silentTurnReactions is a no-op when the streaming card is on (gate order)', async () => {
    // Card-on already early-returns before the silent gate, so the flag must not
    // perturb card-on behavior — same outcome as a plain card-on session.
    registerWith(false, { silentTurnReactions: true });
    const ds = makeDs();

    await noteTurnReceived(ds, 'om_a');

    expect(mocks.addReaction).not.toHaveBeenCalled();
  });

  it('skips non-message ids (doc-comment id / chat anchor cannot carry a reaction)', async () => {
    registerWith(true);
    const ds = makeDs();
    await noteTurnReceived(ds, 'comment_123');
    await noteTurnReceived(ds, 'oc_chat');
    expect(mocks.addReaction).not.toHaveBeenCalled();
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
    expect(mocks.addReaction).toHaveBeenCalledTimes(1);
    expect(durable?.turnFeedback?.[turnId]?.reaction?.type).toBe('GoGoGo');
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
  });

  it('commits terminal phase and reaction intent atomically before convergence', async () => {
    registerWith(true);
    const ds = makeDs();
    await noteTurnReceived(ds, 'om_terminal');
    mocks.addReaction.mockClear();

    applyLiveFeedbackTerminal(ds, {
      turnId: 'om_terminal', status: 'completed', completedAtMs: Date.now(),
    });

    const committed = sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_terminal;
    expect(committed).toMatchObject({ phase: 'completed' });
    expect(committed?.reactionIntent ?? committed?.reaction).toBeDefined();
  });

  it('projects an owned failed terminal to ERROR instead of DONE', async () => {
    registerWith(true);
    const ds = makeDs();
    await noteTurnReceived(ds, 'om_owned_failed');
    mocks.addReaction.mockClear();

    applyLiveFeedbackTerminal(ds, {
      turnId: 'om_owned_failed', status: 'failed', completedAtMs: Date.now(),
    });
    await feedbackReconciler.reconcile(ds, 'om_owned_failed');

    expect(mocks.removeReaction).toHaveBeenCalledWith(APP, 'om_owned_failed', 'rid_om_owned_failed');
    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_owned_failed', 'ERROR');
    expect(mocks.addReaction).not.toHaveBeenCalledWith(APP, 'om_owned_failed', 'DONE');
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_owned_failed?.phase)
      .toBe('failed');
  });

  it('contains terminal feedback commit failure without calling the reaction provider', async () => {
    registerWith(true);
    const ds = makeDs();
    await noteTurnReceived(ds, 'om_terminal_fail');
    mocks.addReaction.mockClear();
    mocks.removeReaction.mockClear();
    sessionStore.__testOnly_setBeforeRowPersist(() => { throw new Error('terminal feedback write failed'); });

    expect(() => applyLiveFeedbackTerminal(ds, {
      turnId: 'om_terminal_fail', status: 'completed', completedAtMs: Date.now(),
    })).not.toThrow();

    expect(mocks.addReaction).not.toHaveBeenCalled();
    expect(mocks.removeReaction).not.toHaveBeenCalled();
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_terminal_fail?.phase)
      .toBe('processing');
  });

  it('type-ahead: two messages settle independently from their exact terminals', async () => {
    registerWith(true);
    const ds = makeDs();
    // B arrives while A is still being processed — no second working edge, but
    // each accepted message still gets its own ✋ because we bind to the message.
    await noteTurnReceived(ds, 'om_a');
    await noteTurnReceived(ds, 'om_b');
    expect(mocks.addReaction).toHaveBeenCalledTimes(2);

    mocks.addReaction.mockClear();
    feedbackReconciler.terminal(ds, 'om_a', 'completed');
    feedbackReconciler.terminal(ds, 'om_b', 'completed');
    await feedbackReconciler.reconcile(ds, 'om_a');
    await feedbackReconciler.reconcile(ds, 'om_b');

    // Each exact terminal removes its own GoGoGo and creates DONE.
    expect(mocks.removeReaction).toHaveBeenCalledWith(APP, 'om_a', 'rid_om_a');
    expect(mocks.removeReaction).toHaveBeenCalledWith(APP, 'om_b', 'rid_om_b');
    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_a', 'DONE');
    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_b', 'DONE');
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_a?.phase).toBe('completed');
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_b?.phase).toBe('completed');
  });

  it('silentTurnReactions keeps terminal convergence reaction-free', async () => {
    registerWith(true, { silentTurnReactions: true });
    const ds = makeDs();
    await noteTurnReceived(ds, 'om_a');
    applyLiveFeedbackTerminal(ds, { turnId: 'om_a', status: 'completed', completedAtMs: Date.now() });
    await feedbackReconciler.reconcile(ds, 'om_a');

    expect(mocks.removeReaction).not.toHaveBeenCalled();
    expect(mocks.addReaction).not.toHaveBeenCalled();
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_a?.phase)
      .toBe('completed');
  });

  it('does not register an in-flight ✋ that a concurrent idle could DONE prematurely', async () => {
    registerWith(true);
    const ds = makeDs();
    // addReaction for B hangs until released — simulating a slow Lark round-trip
    // while a previous turn finishes.
    let releaseB!: (v: string) => void;
    const bPending = new Promise<string>((r) => { releaseB = r; });
    mocks.addReaction.mockReturnValueOnce(bPending as any);

    const notePromise = noteTurnReceived(ds, 'om_b'); // in flight, not yet awaited

    // A terminal cannot happen before admission completes on the production
    // owned path; while CREATE is pending, no terminal reaction is emitted.
    expect(mocks.addReaction).not.toHaveBeenCalledWith(APP, 'om_b', 'DONE');

    // addReaction resolves → only now does om_b persist its provider receipt.
    releaseB('rid_om_b');
    await notePromise;
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_b?.reaction)
      .toEqual({ id: 'rid_om_b', type: 'GoGoGo' });

    // om_b's terminal now converges it to ✅ exactly once.
    feedbackReconciler.terminal(ds, 'om_b', 'completed');
    await feedbackReconciler.reconcile(ds, 'om_b');
    expect(mocks.removeReaction).toHaveBeenCalledWith(APP, 'om_b', 'rid_om_b');
    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_b', 'DONE');
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_b?.phase).toBe('completed');
  });

  it('custom emoji: bots.json overrides the received / done emoji_type', async () => {
    registerWith(true, { receivedReactionEmoji: 'OK', doneReactionEmoji: 'Thumbsup' });
    const ds = makeDs();

    await noteTurnReceived(ds, 'om_a');
    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_a', 'OK');

    mocks.addReaction.mockClear();
    feedbackReconciler.terminal(ds, 'om_a', 'completed');
    await feedbackReconciler.reconcile(ds, 'om_a');
    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_a', 'Thumbsup');
  });

  it('received == done emoji: turn-end keeps the marker unchanged (Pi premature-idle guard)', async () => {
    // Both configured to GoGoGo — a premature idle removes then re-adds the same
    // 冲!, so a misleading ✅ never appears even if idle fires mid-turn.
    registerWith(true, { receivedReactionEmoji: 'GoGoGo', doneReactionEmoji: 'GoGoGo' });
    const ds = makeDs();

    await noteTurnReceived(ds, 'om_a');
    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_a', 'GoGoGo');

    mocks.addReaction.mockClear();
    feedbackReconciler.terminal(ds, 'om_a', 'completed');
    await feedbackReconciler.reconcile(ds, 'om_a');
    expect(mocks.removeReaction).not.toHaveBeenCalled();
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_a?.reaction)
      .toEqual({ id: 'rid_om_a', type: 'GoGoGo' });
    expect(mocks.addReaction).not.toHaveBeenCalledWith(APP, 'om_a', 'DONE');
  });
});

/**
 * Screen status is a runtime hint, not a turn terminal. In particular, the
 * bootstrap working→idle edge of a fresh `/th` worker must not settle reactions.
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
    // Reaction transport is fire-and-forget; wait a tick for any provider calls.
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  async function deliver(worker: EventEmitter, message: Record<string, unknown>): Promise<void> {
    await Promise.all(worker.listeners('message').map(listener => listener.call(worker, message)));
    await flush();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.publishTurnCliIdentity.mockResolvedValue([]);
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
      ...createTurnFeedbackWorkerCallbacks(),
    });
  });

  it('undefined→idle alone does not DONE pending GoGoGo (gate)', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({
      worker,
      workerPort: 9999,
      lastScreenStatus: undefined,
    });
    await noteTurnReceived(ds, 'om_a');
    mocks.addReaction.mockClear();
    mocks.removeReaction.mockClear();
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', { type: 'screen_update', content: 'done?', status: 'idle' });
    await flush();

    expect(mocks.removeReaction).not.toHaveBeenCalled();
    expect(mocks.addReaction).not.toHaveBeenCalledWith(APP, 'om_a', 'DONE');
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_a?.phase)
      .toBe('processing');
  });

  it('working→idle during `/th` startup does not settle a pending turn', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({
      worker,
      workerPort: 9999,
      lastScreenStatus: undefined,
    });
    await noteTurnReceived(ds, 'om_a');
    mocks.addReaction.mockClear();
    mocks.removeReaction.mockClear();
    __testOnly_setupWorkerHandlers(ds, worker);

    // Mirrors the real `/th` race: CLI bootstrap publishes a transient
    // working→idle before UserPromptSubmit starts the user's actual turn.
    worker.emit('message', { type: 'screen_update', content: 'busy', status: 'working' });
    await flush();
    worker.emit('message', { type: 'screen_update', content: 'ready', status: 'idle' });
    await flush();

    expect(mocks.removeReaction).not.toHaveBeenCalled();
    expect(mocks.addReaction).not.toHaveBeenCalledWith(APP, 'om_a', 'DONE');
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_a?.phase)
      .toBe('processing');
  });

  it('validated completed terminal settles only its exact type-ahead turn to DONE', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, workerPort: 9999 });
    await noteTurnReceived(ds, 'om_a');
    await noteTurnReceived(ds, 'om_b');
    mocks.addReaction.mockClear();
    mocks.removeReaction.mockClear();
    __testOnly_setupWorkerHandlers(ds, worker);

    await deliver(worker, {
      type: 'turn_terminal', sessionId: ds.session.sessionId,
      turnId: 'om_a', status: 'completed', completedAtMs: Date.now(),
    });

    expect(mocks.removeReaction).toHaveBeenCalledWith(APP, 'om_a', 'rid_om_a');
    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_a', 'DONE');
    expect(mocks.removeReaction).not.toHaveBeenCalledWith(APP, 'om_b', 'rid_om_b');
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback).toMatchObject({
      om_a: { phase: 'completed' },
      om_b: { phase: 'processing', reaction: { id: 'rid_om_b', type: 'GoGoGo' } },
    });
  });

  it('validated failed terminal settles its exact turn to ERROR', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, workerPort: 9999 });
    await noteTurnReceived(ds, 'om_failed');
    mocks.addReaction.mockClear();
    mocks.removeReaction.mockClear();
    __testOnly_setupWorkerHandlers(ds, worker);

    await deliver(worker, {
      type: 'turn_terminal', sessionId: ds.session.sessionId,
      turnId: 'om_failed', status: 'failed', completedAtMs: Date.now(),
    });

    expect(mocks.removeReaction).toHaveBeenCalledWith(APP, 'om_failed', 'rid_om_failed');
    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_failed', 'ERROR');
    expect(mocks.addReaction).not.toHaveBeenCalledWith(APP, 'om_failed', 'DONE');
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_failed?.phase)
      .toBe('failed');
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
    });
    await noteTurnReceived(ds, 'om_a');
    mocks.addReaction.mockClear();
    mocks.removeReaction.mockClear();
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
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_a?.phase)
      .toBe('processing');
  });

  it('limited→limited alone does not DONE (no working edge)', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({
      worker,
      workerPort: 9999,
      lastScreenStatus: undefined,
    });
    await noteTurnReceived(ds, 'om_a');
    mocks.addReaction.mockClear();
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
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_a?.phase)
      .toBe('processing');
  });
});

