import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatGroupWorkspaceRepoShow,
  runGroupWorkspaceRepoEntrypoint,
  type GroupWorkspaceRepoEntrypointDeps,
  type GroupWorkspaceRepoEntrypointRequest,
} from '../src/core/command-handler.js';
import {
  canonicalCardSourceEventId,
  canonicalTextSourceEventId,
  canonicalGroupWorkspaceRequestIntentDigest,
  GroupWorkspaceStore,
  groupWorkspaceOperationKey,
} from '../src/services/group-workspace-store.js';
import { GroupWorkspaceOperationStore } from '../src/services/group-workspace-operation-store.js';
import { GroupWorkspaceOperationCoordinator, type GroupCommitReceipt } from '../src/core/group-workspace-operation.js';
import { resolveGroupWorkspaceRepoSelection } from '../src/core/repo-selection.js';

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
  it.each([['name', 'repo-a'], ['index', '1']] as const)(
    'replays /repo %s from frozen raw intent and canonical target without re-resolution', async (_case, selection) => {
      const dataDir = mkdtempSync(join(tmpdir(), 'botmux-repo-entrypoint-'));
      const scanRoot = join(dataDir, 'scan');
      const target = join(scanRoot, 'repo-a');
      mkdirSync(target, { recursive: true });
      const groupStore = new GroupWorkspaceStore(dataDir);
      let mapping = [{ path: target, name: 'repo-a', branch: 'main' }];
      let resolutions = 0, switches = 0, writes = 0;
      const execute = async (request: Parameters<GroupWorkspaceRepoEntrypointDeps['executeSet']>[0]) => {
        const coordinator = new GroupWorkspaceOperationCoordinator({
          journalStore: new GroupWorkspaceOperationStore(dataDir), now: () => 10,
          lookupGroupReceipt: async key => {
            const found = await groupStore.readReceipt(key);
            if (found.status !== 'found') return found;
            return { status: 'found' as const, receipt: {
              operationKey: key, payloadDigest: found.receipt.payloadDigest, chatId: found.receipt.chatId,
              targetWorkingDir: found.receipt.canonicalTargetWorkingDir!, status: 'committed' as const,
              resultingRevision: found.receipt.resultingRevision!,
            } satisfies GroupCommitReceipt };
          },
          reconcileUnknownGroupReceipt: async () => ({ status: 'missing' as const }),
          readCurrentGroupRevision: async () => ({ status: 'available' as const, revision: 0 }),
          resolveCanonicalTarget: async () => {
            resolutions += 1;
            const resolved = resolveGroupWorkspaceRepoSelection(request.selection!, [scanRoot], mapping);
            return resolved ? { status: 'resolved' as const, workingDir: resolved.path } : { status: 'store_unavailable' as const };
          },
          readSession: async () => ({ status: 'available' as const, generation: 0, workingDir: '/old' }),
          switchSession: async () => { switches += 1; return { status: 'committed' as const, generation: 1 }; },
          commitGroup: async journal => {
            writes += 1;
            const result = await groupStore.mutate({
              kind: 'set', chatId: journal.chatId, sourceEventId: journal.sourceEventId,
              requestedWorkingDir: journal.targetWorkingDir, expectedRevision: journal.expectedGroupRevision,
              actor: journal.actor, authorized: true, directoryValid: true, now: 10,
            });
            return result.outcome === 'committed'
              ? { status: 'committed' as const, resultingRevision: result.receipt.resultingRevision! }
              : { status: 'unknown' as const };
          },
          convergeSession: async () => undefined,
        });
        const result = await coordinator.execute({
          operationKey: groupWorkspaceOperationKey(request.sourceEventId, 'set'), sourceEventId: request.sourceEventId,
          kind: 'set', requestIntentDigest: canonicalGroupWorkspaceRequestIntentDigest({
            kind: 'set', chatId: request.chatId, selection: request.selection!,
          }), chatId: request.chatId, sessionId: 'session-1', actor: request.actor,
        });
        return result.status === 'group_committed'
          ? { status: 'group_committed' as const, groupRevision: result.groupRevision }
          : { status: result.status };
      };
      const request = { ...base, selection };
      const replies: string[] = [];
      await runGroupWorkspaceRepoEntrypoint(request, { executeSet: execute, executeUnbind: vi.fn(), reply: async m => { replies.push(m); } });
      const receipt = await groupStore.readReceipt(groupWorkspaceOperationKey(canonicalTextSourceEventId({
        tenantKey: actor.tenantKey, chatId: base.chatId, messageId: base.messageId!,
      }).ok ? (canonicalTextSourceEventId({ tenantKey: actor.tenantKey, chatId: base.chatId, messageId: base.messageId! }) as any).sourceEventId : '', 'set'));
      mapping = [{ path: join(scanRoot, 'changed'), name: 'repo-a', branch: 'next' }];
      await runGroupWorkspaceRepoEntrypoint(request, { executeSet: execute, executeUnbind: vi.fn(), reply: async m => { replies.push(m); } });
      expect({ resolutions, switches, writes }).toEqual({ resolutions: 1, switches: 1, writes: 1 });
      expect(await groupStore.readReceipt((receipt as any).receipt.operationKey)).toEqual(receipt);
      await expect(execute({ ...request, sourceEventId: (receipt as any).receipt.sourceEventId, selection: `${selection}-other` }))
        .resolves.toMatchObject({ status: 'protocol_conflict' });
    },
  );
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

  it.each([
    [{ status: 'conflict' as const }, /解绑.*冲突/],
    [{ status: 'store_unavailable' as const }, /解绑.*不可用/],
    [{ status: 'unknown' as const }, /解绑.*未知/],
    [{ status: 'protocol_conflict' as const }, /解绑.*请求.*冲突/],
    [{ status: 'aborted' as const }, /解绑.*未执行/],
  ])('uses unbind-specific failure copy without claiming a session switch %#', async (result, pattern) => {
    const h = harness(result);
    await runGroupWorkspaceRepoEntrypoint({
      kind: 'unbind', source: 'text', chatId: 'oc_chat', actor, messageId: 'om_unbind',
    }, h.deps);
    expect(h.replies[0]).toMatch(pattern);
    expect(h.replies[0]).not.toMatch(/会话.*(?:切换|变化)/);
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

  it('show reports every current persisted layer without collapsing explicit and default oncall', () => {
    const output = formatGroupWorkspaceRepoShow({
      session: { workingDir: '/repo/session', source: 'legacy/unknown', revision: 6 },
      explicitOncall: { workingDir: '/repo/oncall', source: 'oncall-explicit' },
      defaultOncall: { workingDir: '/repo/auto', source: 'default-oncall-config' },
      group: { state: 'bound', workingDir: '/repo/group', revision: 7, source: 'group', health: 'usable',
        updatedAt: 1234, managers: ['tenant-a/on_manager'] },
      botDefault: { workingDir: '/repo/default', source: 'bot-default' },
      resolved: { workingDir: '/repo/session', source: 'session-persisted' },
    }, 'en');
    for (const value of ['session', 'explicit oncall', 'default oncall', 'group', 'default', 'revision 7',
      'revision 6', 'usable', 'updated 1234', 'tenant-a/on_manager', 'session-persisted', 'legacy/unknown']) {
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
