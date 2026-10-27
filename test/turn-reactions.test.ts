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
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const mocks = vi.hoisted(() => ({
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
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

vi.mock('../src/core/turn-cli-identity.js', async () => {
  const actual = await vi.importActual<any>('../src/core/turn-cli-identity.js');
  return { ...actual, publishTurnCliIdentity: mocks.publishTurnCliIdentity };
});

import { getBot, registerBot } from '../src/bot-registry.js';
import { noteTurnReceived } from '../src/daemon.js';
import * as sessionStore from '../src/services/session-store.js';
import { beginReplyTargetTurn } from '../src/core/reply-target.js';
import {
  initWorkerPool,
  __testOnly_finishTurnReactions as finishTurnReactions,
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
    process.env.SESSION_DATA_DIR = mkdtempSync(join(tmpdir(), 'botmux-react-'));
    sessionStore.init(APP);
    mocks.addReaction.mockImplementation(async (_app: string, msgId: string) => `rid_${msgId}`);
    mocks.removeReaction.mockResolvedValue(undefined);
    mocks.publishTurnCliIdentity.mockResolvedValue([]);
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
    expect(mocks.addReaction).toHaveBeenCalledTimes(statusOff ? 1 : 0);
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
    expect(ds.pendingAckReactions?.map(a => a.messageId)).toEqual(['om_a', 'om_b']);
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback?.om_a).toEqual(firstAdmission);
    expect(Object.keys(sessionStore.getSessionFresh(ds.session.sessionId)?.turnFeedback ?? {})).toEqual(['om_a', 'om_b']);
  });

  it('can use Get as the received reaction for substitute turns', async () => {
    registerWith(true);
    const ds = makeDs();

    await noteTurnReceived(ds, 'om_sub', undefined, undefined, undefined, 'Get');

    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_sub', 'Get');
    expect(ds.pendingAckReactions?.map(a => a.messageId)).toEqual(['om_sub']);
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
    expect(ds.pendingAckReactions?.map(a => a.messageId)).toEqual(['om_a']);
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
    expect(mocks.addReaction).toHaveBeenCalledTimes(1);
    expect(ds.pendingAckReactions?.map(item => item.messageId)).toEqual([turnId]);
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
    expect(mocks.addReaction).toHaveBeenCalledTimes(2);

    mocks.addReaction.mockClear();
    await finishTurnReactions(ds);

    // Each ✋ removed and replaced with ✅ DONE — neither message is left behind.
    expect(mocks.removeReaction).toHaveBeenCalledWith(APP, 'om_a', 'rid_om_a');
    expect(mocks.removeReaction).toHaveBeenCalledWith(APP, 'om_b', 'rid_om_b');
    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_a', 'DONE');
    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_b', 'DONE');
    expect(ds.pendingAckReactions).toEqual([]);
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
    // addReaction for B hangs until released — simulating a slow Lark round-trip
    // while a previous turn finishes.
    let releaseB!: (v: string) => void;
    const bPending = new Promise<string>((r) => { releaseB = r; });
    mocks.addReaction.mockReturnValueOnce(bPending as any);

    const notePromise = noteTurnReceived(ds, 'om_b'); // in flight, not yet awaited

    // A previous turn's idle fires while addReaction(om_b) is still pending.
    await finishTurnReactions(ds);
    // om_b is NOT registered yet → no premature DONE, list stays empty.
    expect(mocks.addReaction).not.toHaveBeenCalledWith(APP, 'om_b', 'DONE');
    expect(ds.pendingAckReactions ?? []).toEqual([]);

    // addReaction resolves → only now does om_b register.
    releaseB('rid_om_b');
    await notePromise;
    expect(ds.pendingAckReactions?.map((a) => a.messageId)).toEqual(['om_b']);

    // om_b's own idle now flips it to ✅ exactly once.
    await finishTurnReactions(ds);
    expect(mocks.removeReaction).toHaveBeenCalledWith(APP, 'om_b', 'rid_om_b');
    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_b', 'DONE');
    expect(ds.pendingAckReactions).toEqual([]);
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
    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_a', 'OK');

    mocks.addReaction.mockClear();
    await finishTurnReactions(ds);
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
    await finishTurnReactions(ds);
    expect(mocks.removeReaction).toHaveBeenCalledWith(APP, 'om_a', 'rid_om_a');
    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_a', 'GoGoGo');
    expect(mocks.addReaction).not.toHaveBeenCalledWith(APP, 'om_a', 'DONE');
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

