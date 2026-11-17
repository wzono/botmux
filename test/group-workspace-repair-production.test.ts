import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let dataDir = '';
vi.mock('../src/config.js', () => ({ config: { session: { get dataDir() { return dataDir; } } } }));
vi.mock('../src/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const sessionStore = await import('../src/services/session-store.js');
const { coordinateGroupWorkspaceQuarantineRepair } = await import('../src/services/group-workspace-repair.js');
const { openDatabaseSyncOrThrow } = await import('../src/services/sqlite-compat.js');
const { consumeGroupWorkspaceRepairAuthority } = await import('../src/core/group-workspace-route-runtime.js');
const { withBotAdminIdentityPublication } = await import('../src/services/bot-admin-unions-store.js');

function seed(sessionId: string, repo: string): void {
  sessionStore.init('cli_repair');
  sessionStore.createSession('chat', 'root', 'repair');
  const dbPath = join(dataDir, 'session-stores', 'cli_repair', 'sessions.db');
  const db = openDatabaseSyncOrThrow(dbPath);
  const row = {
    sessionId, chatId: 'chat', rootMessageId: 'root', title: 'repair', status: 'active', createdAt: new Date().toISOString(),
    workingDir: repo, workingDirSource: 'group', groupWorkspaceRevision: 1,
    groupWorkspaceQuarantine: { kind: 'known_group_identity_unprovable', expectedRevision: 1, detail: 'inode' },
  };
  db.prepare('DELETE FROM sessions').run();
  db.prepare('INSERT INTO sessions(session_id,status,row) VALUES(?,?,?)').run(sessionId, 'active', JSON.stringify(row));
  db.close();
  sessionStore.init('cli_repair');
}

describe('production group workspace quarantine repair coordinator', () => {
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'workspace-repair-production-')); });

  it.each(['success', 'failure'] as const)(
    'holds repair authority through read/proof/CAS and releases after %s', async outcome => {
      const repo = join(dataDir, 'repo'); mkdirSync(repo); seed('session', repo);
      const stat = await import('node:fs').then(fs => fs.statSync(repo, { bigint: true }));
      const identity = { path: repo, dev: stat.dev.toString(), ino: stat.ino.toString() };
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let acquired!: () => void;
      const ready = new Promise<void>(resolve => { acquired = resolve; });
      const lease = withBotAdminIdentityPublication(dataDir, async () => { acquired(); await held; });
      await ready;
      let publicationAcquired = false;
      let publication: Promise<string> | undefined;
      const repair = coordinateGroupWorkspaceQuarantineRepair({ sessionId: 'session', chatId: 'chat',
        actor: { tenantKey: 'tenant', unionId: 'on_admin' }, authority: { authorize: () =>
          consumeGroupWorkspaceRepairAuthority(async () => ({ status: 'authorized',
            releasePublicationLease: async () => { release(); await lease; } })) },
        groupStore: { read: async () => {
          publication = withBotAdminIdentityPublication(dataDir, async () => { publicationAcquired = true; return 'published'; });
          await new Promise(resolve => setTimeout(resolve, 30));
          expect(publicationAcquired).toBe(false);
          if (outcome === 'failure') throw new Error('repair read failed');
          return { status: 'available' as const, record: { chatId: 'chat', revision: 2,
            directory: { kind: 'bound' as const, workingDir: repo }, workspaceIdentity: identity,
            updatedAt: 1, updatedBy: { tenantKey: 'tenant', unionId: 'on_admin' } } };
        } }, operationId: 'repair-op', now: () => 10 });
      if (outcome === 'failure') await expect(repair).rejects.toThrow('repair read failed');
      else await expect(repair).resolves.toEqual({ status: 'repaired', operationId: 'repair-op' });
      await expect(publication).resolves.toBe('published');
      expect(publicationAcquired).toBe(true);
    },
  );

  it('revalidates fresh authority/current record/path identity and commits one exact durable CAS receipt', async () => {
    const repo = join(dataDir, 'repo'); mkdirSync(repo); seed('session', repo);
    const stat = await import('node:fs').then(fs => fs.statSync(repo, { bigint: true }));
    const identity = { path: repo, dev: stat.dev.toString(), ino: stat.ino.toString() };
    const result = await coordinateGroupWorkspaceQuarantineRepair({ sessionId: 'session', chatId: 'chat',
      actor: { tenantKey: 'tenant', unionId: 'on_admin' }, authority: { authorize: () => true },
      groupStore: { read: async () => ({ status: 'available', record: { chatId: 'chat', revision: 2,
        directory: { kind: 'bound', workingDir: repo }, workspaceIdentity: identity,
        updatedAt: 1, updatedBy: { tenantKey: 'tenant', unionId: 'on_admin' } } }) }, operationId: 'repair-op', now: () => 10 });
    expect(result).toEqual({ status: 'repaired', operationId: 'repair-op' });
    sessionStore.init('cli_repair');
    const repaired = sessionStore.getSessionFresh('session')!;
    expect(repaired).toMatchObject({ groupWorkspaceRevision: 2,
      groupWorkspaceIdentity: identity, groupWorkspaceRepairReceipt: { operationId: 'repair-op', repairedAt: 10 } });
    expect(repaired.groupWorkspaceQuarantine).toBeUndefined();
  });

  it('returns conflict and preserves newer durable row when exact CAS loses', async () => {
    const repo = join(dataDir, 'repo'); mkdirSync(repo); seed('session', repo);
    const stat = await import('node:fs').then(fs => fs.statSync(repo, { bigint: true }));
    const identity = { path: repo, dev: stat.dev.toString(), ino: stat.ino.toString() };
    sessionStore.__testOnly_setBeforeQuarantineRepairCas((_sessionId, raw) => {
      // The production UPDATE is exact-CAS on the selected raw row. Return an
      // obsolete expected value to deterministically model another committed
      // writer winning between selection and update without violating SQLite's
      // single-writer transaction rule.
      return JSON.stringify({ ...JSON.parse(raw), title: 'obsolete-row' });
    });
    const result = await coordinateGroupWorkspaceQuarantineRepair({ sessionId: 'session', chatId: 'chat',
      actor: { tenantKey: 'tenant', unionId: 'on_admin' }, authority: { authorize: () => true },
      groupStore: { read: async () => ({ status: 'available', record: { chatId: 'chat', revision: 2,
        directory: { kind: 'bound', workingDir: repo }, workspaceIdentity: identity,
        updatedAt: 1, updatedBy: { tenantKey: 'tenant', unionId: 'on_admin' } } }) }, operationId: 'repair-race' });
    expect(result).toEqual({ status: 'conflict' });
    sessionStore.__testOnly_setBeforeQuarantineRepairCas(undefined);
    sessionStore.init('cli_repair');
    const durable = sessionStore.getSessionFresh('session')!;
    expect(durable.title).toBe('repair');
    expect(durable.groupWorkspaceQuarantine).toBeDefined();
    expect(durable.groupWorkspaceRepairReceipt).toBeUndefined();
  });

  it('leaves quarantine durable when fresh authority denies', async () => {
    const repo = join(dataDir, 'repo'); mkdirSync(repo); seed('session', repo);
    const result = await coordinateGroupWorkspaceQuarantineRepair({ sessionId: 'session', chatId: 'chat',
      actor: { tenantKey: 'tenant', unionId: 'on_other' }, authority: { authorize: () => false },
      groupStore: { read: async () => { throw new Error('must not read'); } } });
    expect(result).toEqual({ status: 'unauthorized' });
    expect(sessionStore.getSessionFresh('session')?.groupWorkspaceQuarantine).toBeDefined();
  });
});
