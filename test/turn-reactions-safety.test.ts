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

vi.mock('../src/core/turn-cli-identity.js', async () => {
  const actual = await vi.importActual<any>('../src/core/turn-cli-identity.js');
  return { ...actual, publishTurnCliIdentity: mocks.publishTurnCliIdentity };
});

import { getBot, registerBot } from '../src/bot-registry.js';
import {
  noteTurnReceived,
  handleProductionTurnTerminalLifecycle,
  __testOnly_claimNewDaemonSession as claimNewDaemonSession,
} from '../src/daemon.js';
import { OncallGroupStore } from '../src/services/oncall-group-store.js';
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

describe('reaction entrypoint safety after capacity retirement', () => {
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

  it.each(['legacy', 'unified'] as const)('persists %s session boundaries before any first card is published', async replyCardMode => {
    registerWith(false, { replyCardMode });
    getBot(APP).config.oncallGroup = { enabled: true, chatIds: ['oc_x'] };
    const ds = makeDs({ chatType: 'group', scope: 'thread' });
    await noteTurnReceived(ds, 'om_newquestion');
    // Reopen the store: boundary survives even without a published source/card.
    const store = new OncallGroupStore(process.env.SESSION_DATA_DIR!);
    expect(store.latest(APP, ds.session.sessionId)).toBeUndefined();
    const boundary = store.otherSessionScope({ appId: APP, sessionId: 'old-session', chatId: 'oc_x',
      rootId: ds.session.rootMessageId, questionId: 'om_oldquestion', messageId: 'om_oldreply', answer: '' });
    expect([...boundary.starts]).toEqual(['om_newquestion']);
    expect([...boundary.messages]).toEqual(['om_newquestion']);
    expect(mocks.addReaction).not.toHaveBeenCalled();
  });

  it.each(['legacy', 'unified'] as const)('isolates %s initial turns while waiting for repo selection or worktree creation', async replyCardMode => {
    registerWith(false, { replyCardMode });
    getBot(APP).config.oncallGroup = { enabled: true, chatIds: ['oc_x'] };
    const registry = new Map<string, DaemonSession>();
    const ds = makeDs({ chatType: 'group', scope: 'thread', pendingRepo: true, pendingTurnId: 'om_newquestion' });
    expect((await claimNewDaemonSession(registry, ds)).accepted).toBe(true);
    const store = new OncallGroupStore(process.env.SESSION_DATA_DIR!);
    expect([...store.otherSessionScope({ appId: APP, sessionId: 'old-session', chatId: 'oc_x',
      rootId: ds.session.rootMessageId, questionId: 'om_oldquestion', messageId: 'om_oldreply', answer: '' }).starts]).toEqual(['om_newquestion']);
    // Later acceptance must retain the same turn number, not count it twice.
    await noteTurnReceived(ds, 'om_newquestion');
    expect(store.registerTurn(APP, ds.session.sessionId, 'om_newquestion')).toBe(1);
    expect(store.registerTurn(APP, ds.session.sessionId, 'om_secondquestion')).toBe(2);
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

    expect(accepted).toBe(false);
    await vi.waitFor(() => expect(mocks.publishTurnCliIdentity).toHaveBeenCalledTimes(1));
    expect(accepted).toBe(false);

    releaseIdentity();
    await receiving;
    expect(accepted).toBe(true);
    expect(ds.pendingAckReactions).toEqual([{ messageId: 'om_slow_auth', reactionId: 'rid_om_slow_auth' }]);
    expect(mocks.addReaction).toHaveBeenCalledWith(APP, 'om_slow_auth', 'GoGoGo');
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
    await handleProductionTurnTerminalLifecycle(ds, {
      turnId: terminalTurnId,
    }, { workerGeneration });

    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.deploymentContinuation?.state)
      .toBe(expectedState);
  });

  it('preserves explicitly persisted the queued-message exact routing snapshot created before admission', async () => {
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

    sessionStore.updateSession(ds.session);
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
  });

  it('preserves explicitly persisted an Ask document turn routing and comment association', async () => {
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

    sessionStore.updateSession(ds.session);
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
  });

  it('keeps explicitly persisted type-ahead routes exact during identity awaits', async () => {
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
      sessionStore.updateSession(ds.session);
    };

    stage('om_typeahead_a', 'om_topic_a', 'ou_a', '2026-10-27T11:00:00.000Z');
    const admissionA = noteTurnReceived(ds, 'om_typeahead_a');

    stage('om_typeahead_b', 'om_topic_b', 'ou_b', '2026-10-27T11:01:00.000Z');
    const admissionB = noteTurnReceived(ds, 'om_typeahead_b');

    await vi.waitFor(() => expect(mocks.publishTurnCliIdentity).toHaveBeenCalledTimes(2));
    releases.get('om_typeahead_b')!();
    await admissionB;
    releases.get('om_typeahead_a')!();
    await admissionA;

    const durable = sessionStore.getSessionFresh(ds.session.sessionId);
    expect(Object.keys(durable?.replyTargets ?? {})).toEqual(['om_typeahead_a', 'om_typeahead_b']);
    expect(Object.keys(durable?.turnReplyContexts ?? {})).toEqual(['om_typeahead_a', 'om_typeahead_b']);
    expect(durable?.replyThreadAliases).toMatchObject({
      om_topic_a: expect.any(Object),
      om_topic_b: expect.any(Object),
    });
    expect(ds.currentReplyTarget).toEqual(durable?.currentReplyTarget);
    expect(ds.replyThreadAliases).toEqual(durable?.replyThreadAliases);
  });

  it('preserves an explicitly persisted folded-root alias while acknowledging its turn', async () => {
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

    sessionStore.updateSession(ds.session);
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
    expect(durable?.replyThreadAliases?.om_folded_root).toEqual({
      createdAt: '2026-10-27T12:05:00.000Z',
      lastUsedAt: '2026-10-27T12:05:00.000Z',
    });
    expect(ds.replyThreadAliases).toEqual(durable?.replyThreadAliases);
  });

  it('keeps stamped meeting-origin turns reaction-free', async () => {
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

    expect(mocks.addReaction).not.toHaveBeenCalled();
  });

  it('keeps exact-object ownership and never writes a detached same-id row on receipt', async () => {
    registerWith(false);
    const owner = makeDs();
    const detached = { ...owner, session: structuredClone(owner.session) } as DaemonSession;
    expect(sessionStore.ownsSessionForMutation(owner.session)).toBe(true);
    expect(sessionStore.ownsSessionForMutation(detached.session)).toBe(false);
    const before = structuredClone(sessionStore.getSessionFresh(owner.session.sessionId));
    await noteTurnReceived(detached, 'om_detached');
    expect(sessionStore.getSessionFresh(owner.session.sessionId)).toEqual(before);
  });

});
