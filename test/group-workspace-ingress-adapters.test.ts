import { mkdirSync, mkdtempSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveIngressWorkspace } from '../src/core/session-manager.js';
import { canonicalTextSourceEventId, GroupWorkspaceStore } from '../src/services/group-workspace-store.js';
import { composeRowFromActive, composeRowFromClosed } from '../src/core/dashboard-rows.js';
import { normalizeGroupWorkspaceRouteText } from '../src/im/lark/event-dispatcher.js';

describe('group workspace ingress adapters', () => {
  afterEach(() => vi.restoreAllMocks());

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
