import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  formatGroupWorkspaceRepoShow,
  runGroupWorkspaceRepoEntrypoint,
  type GroupWorkspaceRepoEntrypointRequest,
} from '../src/core/command-handler.js';
import {
  GroupWorkspaceOperationCoordinator,
  type GroupCommitReceipt,
  type GroupWorkspaceOperationDependencies,
} from '../src/core/group-workspace-operation.js';
import { GroupWorkspaceOperationStore } from '../src/services/group-workspace-operation-store.js';
import { groupWorkspaceOperationKey } from '../src/services/group-workspace-store.js';

const actor = { tenantKey: 'tenant-a', unionId: 'on_user' };
const sourceEventId = 'group-workspace-text-source-v1:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const request = {
  operationKey: groupWorkspaceOperationKey(sourceEventId, 'set'),
  sourceEventId,
  kind: 'set' as const,
  requestIntentDigest: 'intent-a',
  chatId: 'oc_group',
  sessionId: 'session-a',
  actor,
  authorityFingerprint: 'fingerprint-a',
};

function coordinatorHarness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-entrypoints-v2-'));
  let authority: 'authorized' | 'denied' | 'unavailable' = 'authorized';
  let receipt: GroupCommitReceipt | undefined;
  let switches = 0;
  let commits = 0;
  const afterBoundary = vi.fn<NonNullable<GroupWorkspaceOperationDependencies['afterBoundary']>>();
  const deps: GroupWorkspaceOperationDependencies = {
    journalStore: new GroupWorkspaceOperationStore(dataDir),
    now: () => 10,
    revalidateAuthority: async () => ({ status: authority }),
    lookupGroupReceipt: async () => receipt ? { status: 'found', receipt } : { status: 'missing' },
    reconcileUnknownGroupReceipt: async () => receipt ? { status: 'found', receipt } : { status: 'missing' },
    readCurrentGroupRevision: async () => ({ status: 'available', revision: 2 }),
    resolveCanonicalTarget: async () => ({
      status: 'resolved', workingDir: '/repo/x', workspaceIdentity: { path: '/repo/x', dev: '1', ino: '2' },
    }),
    readSession: async () => ({ status: 'available', generation: 4, workingDir: '/repo/old' }),
    switchSession: async () => { switches += 1; return { status: 'committed', generation: 5 }; },
    commitGroup: async journal => {
      commits += 1;
      receipt = {
        status: 'committed', resultingRevision: 3,
        operationKey: journal.operationKey, payloadDigest: journal.payloadDigest,
        chatId: journal.chatId, targetWorkingDir: journal.targetWorkingDir!,
        workspaceIdentity: journal.targetWorkspaceIdentity!,
      };
      return { status: 'committed', resultingRevision: 3 };
    },
    convergeSession: async () => 'converged',
    afterBoundary,
  };
  return {
    coordinator: new GroupWorkspaceOperationCoordinator(deps), afterBoundary,
    revoke: () => { authority = 'denied'; },
    authorityUnavailable: () => { authority = 'unavailable'; },
    effects: () => ({ switches, commits }),
    journal: () => deps.journalStore.get(request.operationKey),
    setConvergence: (value: GroupWorkspaceOperationDependencies['convergeSession']) => { deps.convergeSession = value; },
  };
}

const baseEntrypoint: GroupWorkspaceRepoEntrypointRequest = {
  kind: 'set', source: 'text', chatId: 'oc_group', actor, messageId: 'om_source', selection: '/repo/x',
};

describe('group workspace Task 7 entrypoints v2', () => {
  it('revalidates authority after the switch boundary hook and before switching the session', async () => {
    const h = coordinatorHarness();
    h.afterBoundary.mockImplementation(async boundary => {
      if (boundary === 'prepared_before_switch') h.revoke();
    });
    await expect(h.coordinator.execute(request)).resolves.toMatchObject({ status: 'unauthorized' });
    expect(h.effects()).toEqual({ switches: 0, commits: 0 });
  });

  it.each(['session_missing', 'generation_conflict'] as const)(
    'durably quarantines a committed receipt when exact session provenance ends as %s', async convergence => {
      const h = coordinatorHarness();
      h.setConvergence(async () => convergence);
      await expect(h.coordinator.execute(request)).resolves.toMatchObject({
        status: 'convergence_quarantined',
        reason: convergence,
        journal: { phase: 'convergence_quarantined', convergenceFailure: convergence },
      });
      expect(h.effects()).toEqual({ switches: 1, commits: 1 });
      await expect(h.coordinator.execute(request)).resolves.toMatchObject({
        status: 'convergence_quarantined', reason: convergence,
      });
      expect(h.effects()).toEqual({ switches: 1, commits: 1 });
    },
  );

  it('keeps transient authority unavailability recoverable instead of persisting unauthorized', async () => {
    const h = coordinatorHarness();
    h.afterBoundary.mockImplementation(async boundary => {
      if (boundary === 'prepared_before_switch') h.authorityUnavailable();
    });
    await expect(h.coordinator.execute(request)).resolves.toMatchObject({ status: 'store_unavailable' });
    expect(h.effects()).toEqual({ switches: 0, commits: 0 });
    expect(await h.journal()).toMatchObject({ status: 'found', journal: { phase: 'prepared' } });
  });

  it.each(['invalid_dir', 'unauthorized'] as const)('renders a localized non-success response for %s', async status => {
    const replies: string[] = [];
    await runGroupWorkspaceRepoEntrypoint(baseEntrypoint, {
      executeSet: async () => ({ status }), executeUnbind: async () => ({ status }),
      reply: async message => { replies.push(message); }, locale: 'en',
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]).not.toContain(`cmd.repo.group.${status}`);
    expect(replies[0]).not.toMatch(/updated \(revision/);
  });

  it('replays a receipt-derived response after the first response crashes without owning worker or CAS effects', async () => {
    let workerEffects = 0;
    let casEffects = 0;
    const executeSet = vi.fn(async () => {
      if (executeSet.mock.calls.length === 1) {
        workerEffects += 1;
        casEffects += 1;
      }
      return { status: 'group_committed' as const, groupRevision: 9, replayed: executeSet.mock.calls.length > 1 };
    });
    await expect(runGroupWorkspaceRepoEntrypoint(baseEntrypoint, {
      executeSet, executeUnbind: vi.fn(), reply: async () => { throw new Error('response crash'); },
    })).rejects.toThrow('response crash');
    const replies: string[] = [];
    await runGroupWorkspaceRepoEntrypoint(baseEntrypoint, {
      executeSet, executeUnbind: vi.fn(), reply: async message => { replies.push(message); },
    });
    expect({ workerEffects, casEffects, replies: replies.length }).toEqual({ workerEffects: 1, casEffects: 1, replies: 1 });
  });

  it('shows resolver failure, quarantine and migration outcomes without collapsing them into legacy policy', () => {
    const output = formatGroupWorkspaceRepoShow({
      group: { state: 'unavailable', health: 'store_unavailable' },
      resolution: { status: 'identity_changed', detail: 'expected dev=1 ino=2; actual dev=1 ino=3' },
      quarantine: { kind: 'known_group_identity_unprovable', expectedRevision: 7,
        expectedIdentity: { path: '/repo/x', dev: '1', ino: '2' }, detail: 'inode changed' },
      migration: { status: 'blocked', detail: 'migration_blocked_identity_missing' },
      operation: { status: 'convergence_quarantined', detail: 'generation_conflict' },
      resolved: { workingDir: '/repo/fallback', source: 'current-policy' },
    }, 'en');
    expect(output).toContain('identity_changed');
    expect(output).toContain('known_group_identity_unprovable');
    expect(output).toContain('revision 7');
    expect(output).toContain('migration_blocked_identity_missing');
    expect(output).toContain('convergence_quarantined');
    expect(output).toContain('generation_conflict');
    expect(output).toContain('resolved: /repo/fallback');
  });
});
