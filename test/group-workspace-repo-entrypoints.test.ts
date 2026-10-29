import { describe, expect, it, vi } from 'vitest';
import {
  formatGroupWorkspaceRepoShow,
  runGroupWorkspaceRepoEntrypoint,
  type GroupWorkspaceRepoEntrypointDeps,
  type GroupWorkspaceRepoEntrypointRequest,
} from '../src/core/command-handler.js';
import { canonicalCardSourceEventId, canonicalTextSourceEventId } from '../src/services/group-workspace-store.js';

const actor = { tenantKey: 'tenant-a', unionId: 'on_user' };
const base: GroupWorkspaceRepoEntrypointRequest = {
  kind: 'set', source: 'text', chatId: 'oc_chat', actor, messageId: 'om_original', selection: '/repo/X',
};

function harness(result: Awaited<ReturnType<GroupWorkspaceRepoEntrypointDeps['executeSet']>> = { status: 'group_committed', groupRevision: 3 }) {
  const replies: string[] = [];
  const executeSet = vi.fn(async () => result);
  const executeUnbind = vi.fn(async () => result);
  const deps: GroupWorkspaceRepoEntrypointDeps = {
    executeSet, executeUnbind,
    reply: async message => { replies.push(message); },
  };
  return { deps, replies, executeSet, executeUnbind };
}

describe('group workspace /repo entrypoints', () => {
  it('gives text and card the same terminal response boundary with distinct canonical sources', async () => {
    const text = harness();
    await runGroupWorkspaceRepoEntrypoint(base, text.deps);
    const card = harness();
    await runGroupWorkspaceRepoEntrypoint({
      ...base, source: 'card', messageId: undefined, originMessageId: 'om_card', actionId: 'act_1',
    }, card.deps);
    expect(text.replies).toHaveLength(1);
    expect(card.replies).toEqual(text.replies);
    expect(text.executeSet.mock.calls[0]![0].sourceEventId).toBe(canonicalTextSourceEventId({
      tenantKey: actor.tenantKey, chatId: base.chatId, messageId: 'om_original',
    }).ok ? (canonicalTextSourceEventId({ tenantKey: actor.tenantKey, chatId: base.chatId, messageId: 'om_original' }) as any).sourceEventId : '');
    expect(card.executeSet.mock.calls[0]![0].sourceEventId).toBe((canonicalCardSourceEventId({
      tenantKey: actor.tenantKey, chatId: base.chatId, originMessageId: 'om_card', actionId: 'act_1',
    }) as any).sourceEventId);
  });

  it.each([
    [{ status: 'session_committed' as const }, /群目录.*待/],
    [{ status: 'conflict' as const }, /冲突/],
    [{ status: 'store_unavailable' as const }, /不可用/],
    [{ status: 'unknown' as const }, /未知/],
    [{ status: 'protocol_conflict' as const }, /请求.*冲突/],
    [{ status: 'aborted' as const }, /未切换/],
  ])('maps saga state %# to a non-success response', async (result, pattern) => {
    const h = harness(result);
    await runGroupWorkspaceRepoEntrypoint(base, h.deps);
    expect(h.replies).toHaveLength(1);
    expect(h.replies[0]).toMatch(pattern);
    expect(h.replies[0]).not.toMatch(/群目录更新成功/);
  });

  it('replay success is receipt-derived and the entrypoint performs no switch or write itself', async () => {
    const h = harness({ status: 'group_committed', groupRevision: 3, replayed: true });
    await runGroupWorkspaceRepoEntrypoint(base, h.deps);
    expect(h.executeSet).toHaveBeenCalledOnce();
    expect(h.replies[0]).toMatch(/群目录更新成功/);
  });

  it('unbind uses the direct operation without a set/session phase', async () => {
    const h = harness({ status: 'group_committed', groupRevision: 4 });
    await runGroupWorkspaceRepoEntrypoint({
      kind: 'unbind', source: 'text', chatId: 'oc_chat', actor, messageId: 'om_unbind',
    }, h.deps);
    expect(h.executeUnbind).toHaveBeenCalledOnce();
    expect(h.executeSet).not.toHaveBeenCalled();
    expect(h.replies[0]).toMatch(/群目录解绑成功/);
  });

  it('show reports session, oncall, group, default, final source, revision and health', () => {
    const output = formatGroupWorkspaceRepoShow({
      session: { workingDir: '/repo/session', source: 'explicit' },
      oncall: { workingDir: '/repo/oncall', source: 'oncall-explicit' },
      group: { state: 'bound', workingDir: '/repo/group', revision: 7, source: 'group', health: 'usable' },
      botDefault: { workingDir: '/repo/default', source: 'bot-default' },
      resolved: { workingDir: '/repo/session', source: 'explicit' },
    }, 'en');
    for (const value of ['session', 'oncall', 'group', 'default', 'revision 7', 'usable', 'explicit']) {
      expect(output.toLowerCase()).toContain(value);
    }
  });

  it('fails closed before side effects when immutable source identity is absent', async () => {
    const h = harness();
    await runGroupWorkspaceRepoEntrypoint({ ...base, messageId: undefined }, h.deps);
    expect(h.executeSet).not.toHaveBeenCalled();
    expect(h.replies[0]).toMatch(/来源/);
  });
});
