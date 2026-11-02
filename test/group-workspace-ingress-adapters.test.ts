import { mkdirSync, mkdtempSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveIngressWorkspace,
  runWorkspaceIngressAdapter,
  type WorkspaceIngressOrigin,
} from '../src/core/session-manager.js';
import { canonicalTextSourceEventId, GroupWorkspaceStore } from '../src/services/group-workspace-store.js';
import { composeRowFromActive, composeRowFromClosed } from '../src/core/dashboard-rows.js';
import { normalizeGroupWorkspaceRouteText } from '../src/im/lark/event-dispatcher.js';

const origins: WorkspaceIngressOrigin[] = [
  'ordinary_new', 'ordinary_existing', 'listener_realtime', 'listener_polled',
  'trigger_new', 'trigger_existing', 'dashboard_create', 'dashboard_start',
  'dashboard_board', 'dashboard_resume', 'scheduler_tick', 'scheduler_manual',
  'failed_turn_retry', 'failed_turn_fresh',
];

describe('group workspace ingress adapters', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(origins)('%s resolves, follows and proves identity before business effects', async origin => {
    const trace: string[] = [];
    const result = await runWorkspaceIngressAdapter({
      origin,
      resolve: async () => {
        trace.push('resolve');
        return { status: 'resolved', workspace: { path: '/repo', dev: '1', ino: '2' }, groupRevision: 7 };
      },
      follow: async () => { trace.push('follow'); return true; },
      prove: async () => { trace.push('prove'); return true; },
      acquire: async () => { trace.push('lease'); return true; },
      markAttempting: async () => { trace.push('attempting'); return true; },
      deliver: async () => { trace.push('deliver'); return true; },
    });
    expect(result).toEqual({ status: 'delivered' });
    expect(trace).toEqual(['resolve', 'follow', 'prove', 'lease', 'attempting', 'deliver']);
  });

  it.each(origins)('%s fails closed on resolver, follow, or identity failure', async origin => {
    for (const failed of ['resolve', 'follow', 'prove'] as const) {
      const effects: string[] = [];
      const result = await runWorkspaceIngressAdapter({
        origin,
        resolve: async () => failed === 'resolve'
          ? { status: 'store_unavailable', detail: 'locked' }
          : { status: 'resolved', workspace: { path: '/repo', dev: '1', ino: '2' }, groupRevision: 7 },
        follow: async () => failed !== 'follow',
        prove: async () => failed !== 'prove',
        acquire: async () => { effects.push('lease'); return true; },
        markAttempting: async () => { effects.push('attempting'); return true; },
        deliver: async () => { effects.push('deliver'); return true; },
      });
      expect(result.status).toBe('rejected');
      expect(effects).toEqual([]);
    }
  });

  it('normalizes leading @Bot /repo exactly like the generic command route', () => {
    const message = {
      message_type: 'text',
      content: JSON.stringify({ text: '@Bot /repo /repo/x' }),
      mentions: [{ key: '@Bot', id: { open_id: 'ou_bot' }, name: 'Bot' }],
    };
    expect(normalizeGroupWorkspaceRouteText(message)).toBe('/repo /repo/x');
  });

  it('shows frozen workspace provenance on live and persisted Dashboard rows', () => {
    const identity = { path: '/repo/x', dev: '1', ino: '2' };
    const session = {
      sessionId: 'session-1', larkAppId: 'app', chatId: 'oc_group', rootMessageId: 'oc_group',
      status: 'active', scope: 'chat', createdAt: '2026-11-02T00:00:00.000Z', workingDir: identity.path,
      workingDirSource: 'group', groupWorkspaceRevision: 9, groupWorkspaceIdentity: identity,
    } as any;
    const ds = {
      session, worker: null, workerPort: null, workerToken: null, larkAppId: 'app', chatId: 'oc_group',
      chatType: 'group', scope: 'chat', spawnedAt: 1, cliVersion: 'test', lastMessageAt: 1,
      hasHistory: false, workingDir: identity.path,
    } as any;
    expect(composeRowFromActive(ds)).toMatchObject({
      workingDir: identity.path, workingDirSource: 'group', groupWorkspaceRevision: 9,
      groupWorkspaceIdentity: identity,
    });
    session.status = 'closed';
    expect(composeRowFromClosed(session)).toMatchObject({
      workingDir: identity.path, workingDirSource: 'group', groupWorkspaceRevision: 9,
      groupWorkspaceIdentity: identity,
    });
  });

  it('uses the same async resolver precedence and preserves group identity/provenance', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ingress-workspace-'));
    const repo = join(dataDir, 'repo');
    mkdirSync(repo, { recursive: true });
    const canonical = realpathSync(repo);
    const stat = statSync(canonical, { bigint: true });
    const workspaceIdentity = { path: canonical, dev: String(stat.dev), ino: String(stat.ino) };
    const store = new GroupWorkspaceStore(dataDir);
    const source = canonicalTextSourceEventId({ tenantKey: 'tenant', chatId: 'oc_group', messageId: 'om_event_1' });
    if (!source.ok) throw new Error('expected canonical source');
    expect((await store.mutate({
      sourceEventId: source.sourceEventId, kind: 'set', chatId: 'oc_group', requestedWorkingDir: canonical,
      directoryValid: true, expectedWorkspaceIdentity: workspaceIdentity, expectedRevision: 0,
      expectedSessionGeneration: 1, authorized: true,
      actor: { tenantKey: 'tenant', unionId: 'on_admin' }, now: Date.parse('2026-11-02T00:00:00.000Z'),
    })).outcome).toBe('committed');
    const resolved = await resolveIngressWorkspace({
      larkAppId: 'app', chatId: 'oc_group', chatType: 'group', dataDir,
      oncall: undefined, botDefaultWorkingDir: '/fallback',
    });
    expect(resolved).toMatchObject({ status: 'resolved', mutation: {
      workingDir: canonical, source: 'group', groupWorkspaceRevision: 1,
      groupWorkspaceIdentity: workspaceIdentity,
    } });
  });
});
