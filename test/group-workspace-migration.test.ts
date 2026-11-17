import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { GroupWorkspaceStore } from '../src/services/group-workspace-store.js';
import { GroupWorkspaceOperationStore } from '../src/services/group-workspace-operation-store.js';
import { writeBotAdminUnions } from '../src/services/bot-admin-unions-store.js';
import { assertGroupWorkspaceSessionExecutable, repairKnownGroupWorkspaceSession } from '../src/core/session-cwd.js';
import type { Session } from '../src/types.js';
import {
  WorkspaceMigrationFenceError,
  WorkspaceSchemaMigrator,
  assertWorkspaceWriterFence,
  readWorkspaceMigrationManifest,
} from '../src/services/workspace-schema-migrator.js';

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), 'workspace-migration-'));
}

describe('host-wide workspace schema migration', () => {
  it('publishes one monotonic epoch and rejects stale normal writers while the batch is active', async () => {
    const root = dataDir();
    writeFileSync(join(root, 'group-workspaces.json'), JSON.stringify({ schemaVersion: 2, records: {}, receipts: {} }));
    writeFileSync(join(root, 'group-workspace-operations.json'), JSON.stringify({ schemaVersion: 2, operations: {}, sourceIndex: {} }));
    const migrator = new WorkspaceSchemaMigrator(root, {
      ownerId: 'daemon-a', now: () => 10, requiredStores: ['group_json', 'operation_json'],
    });
    const stopped = await migrator.migrateOrRecover({ stopAfter: 'prepared' });
    expect(stopped.status).toBe('incomplete');
    const prepared = readWorkspaceMigrationManifest(root);
    expect(prepared).toMatchObject({ phase: 'prepared', epoch: 1, writer: { ownerId: 'daemon-a', fencingToken: 1 } });
    expect(() => assertWorkspaceWriterFence(root, { epoch: 0, fencingToken: 0 })).toThrow(WorkspaceMigrationFenceError);
    expect(() => assertWorkspaceWriterFence(root)).toThrow(WorkspaceMigrationFenceError);

    const completed = await migrator.migrateOrRecover();
    expect(completed).toMatchObject({ status: 'complete', epoch: 1 });
    const manifest = readWorkspaceMigrationManifest(root)!;
    expect(manifest.phase).toBe('complete');
    expect(Object.values(manifest.stores).every(store => store.publishPoint === 'published')).toBe(true);
    expect(() => assertWorkspaceWriterFence(root, { epoch: 1, fencingToken: 1 })).not.toThrow();
    expect(JSON.parse(readFileSync(join(root, 'group-workspaces.json'), 'utf8')).schemaVersion).toBe(2);
  });
  it('migrates v1 bindings and session provenance while quarantining unprovable known-group rows', async () => {
    const root = dataDir();
    const repo = join(root, 'repo');
    mkdirSync(repo);
    writeFileSync(join(root, 'group-workspaces.json'), JSON.stringify({ schemaVersion: 1, records: {
      chat: { chatId: 'chat', revision: 1, directory: { kind: 'bound', workingDir: repo },
        updatedAt: 1, updatedBy: { tenantKey: 'tenant', unionId: 'on_admin' } },
    }, receipts: {} }));
    writeFileSync(join(root, 'group-workspace-operations.json'), JSON.stringify({ schemaVersion: 2, operations: {}, sourceIndex: {} }));
    const dbPath = join(root, 'session-stores', 'cli_test', 'sessions.db');
    mkdirSync(join(root, 'session-stores', 'cli_test'), { recursive: true });
    const db = openDatabaseSyncOrThrow(dbPath);
    db.exec('CREATE TABLE sessions(session_id TEXT PRIMARY KEY, status TEXT NOT NULL, row TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO sessions(session_id,status,row) VALUES(?,?,?)');
    insert.run('legacy', 'active', JSON.stringify({ sessionId: 'legacy', status: 'active', workingDir: '/tmp' }));
    insert.run('known', 'active', JSON.stringify({ sessionId: 'known', status: 'active', chatId: 'chat',
      workingDir: repo, workingDirSource: 'group', groupWorkspaceRevision: 1 }));
    insert.run('stale', 'active', JSON.stringify({ sessionId: 'stale', status: 'active', chatId: 'chat',
      workingDir: repo, workingDirSource: 'group', groupWorkspaceRevision: 0 }));
    db.close();

    await new WorkspaceSchemaMigrator(root, { ownerId: 'daemon-a' }).migrateOrRecover();
    const group = JSON.parse(readFileSync(join(root, 'group-workspaces.json'), 'utf8'));
    expect(group.schemaVersion).toBe(2);
    expect(group.records.chat.workspaceIdentity).toMatchObject({ path: repo });
    expect(Object.values(group.receipts)).toHaveLength(1);
    await expect(new GroupWorkspaceStore(root).read('chat')).resolves.toMatchObject({
      status: 'available', record: { revision: 1, directory: { kind: 'bound', workingDir: repo } },
    });
    await expect(new GroupWorkspaceOperationStore(root).listUnresolved()).resolves.toMatchObject({ status: 'available' });
    const migrated = openDatabaseSyncOrThrow(dbPath, { readOnly: true });
    const rows = migrated.prepare('SELECT session_id,row FROM sessions ORDER BY session_id').all() as Array<{ session_id: string; row: string }>;
    migrated.close();
    const byId = Object.fromEntries(rows.map(row => [row.session_id, JSON.parse(row.row)]));
    expect(byId.legacy.workingDirSource).toBe('legacy-unknown');
    expect(byId.known).toMatchObject({ workspaceSchemaVersion: 2, groupWorkspaceIdentity: group.records.chat.workspaceIdentity });
    expect(byId.stale.groupWorkspaceQuarantine).toMatchObject({ kind: 'known_group_identity_unprovable', expectedRevision: 0 });
  });

  it('rolls back before the first publish and resumes instead of rolling back after a publish point', async () => {
    const root = dataDir();
    writeFileSync(join(root, 'group-workspaces.json'), JSON.stringify({ schemaVersion: 1, records: {}, receipts: {} }));
    writeFileSync(join(root, 'group-workspace-operations.json'), JSON.stringify({ schemaVersion: 2, operations: {}, sourceIndex: {} }));
    const before = readFileSync(join(root, 'group-workspaces.json'), 'utf8');
    await new WorkspaceSchemaMigrator(root, { ownerId: 'a' }).migrateOrRecover({ stopAfter: 'per_store_verified' });
    writeFileSync(join(root, 'group-workspaces.json'), 'corrupt');
    await expect(new WorkspaceSchemaMigrator(root, { ownerId: 'a' }).migrateOrRecover({ stopAfter: 'per_store_verified' }))
      .rejects.toThrow('changed while fenced');
    writeFileSync(join(root, 'group-workspaces.json'), before);
    await new WorkspaceSchemaMigrator(root, { ownerId: 'a' }).migrateOrRecover({ stopAfter: 'per_store_verified' });
    expect(readFileSync(join(root, 'group-workspaces.json'), 'utf8')).toBe(before);

    let crashed = false;
    const crash = new WorkspaceSchemaMigrator(root, { ownerId: 'a', crashProbe(point) {
      if (!crashed && point.startsWith('publish-renamed:')) { crashed = true; throw new Error('crash'); }
    } });
    await expect(crash.migrateOrRecover()).rejects.toThrow('crash');
    expect(readWorkspaceMigrationManifest(root)!.phase).toBe('per_store_verified');
    expect(Object.values(readWorkspaceMigrationManifest(root)!.stores).some(store => store.publishPoint === 'pending')).toBe(true);
    await expect(new WorkspaceSchemaMigrator(root, { ownerId: 'a' }).migrateOrRecover()).resolves.toMatchObject({ status: 'complete' });
  });

  it('requires an authorized fresh proof to supersede durable known-group quarantine', () => {
    const session = { sessionId: 's', workingDir: '/repo', workingDirSource: 'group', groupWorkspaceRevision: 1,
      groupWorkspaceQuarantine: { kind: 'known_group_identity_unprovable', expectedRevision: 1, detail: 'inode' },
    } as Session;
    expect(() => assertGroupWorkspaceSessionExecutable(session)).toThrow('known_group_identity_unprovable');
    expect(repairKnownGroupWorkspaceSession({ session, authorized: false, operationId: 'repair-1', currentRevision: 2,
      currentIdentity: { path: '/repo', dev: '1', ino: '2' } })).toEqual({ status: 'unauthorized' });
    expect(session.groupWorkspaceQuarantine).toBeDefined();
    const repaired = repairKnownGroupWorkspaceSession({ session, authorized: true, operationId: 'repair-1', currentRevision: 2,
      currentIdentity: { path: '/repo', dev: '1', ino: '2' } });
    expect(repaired).toMatchObject({ status: 'repaired', supersedingEvent: { operationId: 'repair-1' } });
    expect(session.groupWorkspaceQuarantine).toBeUndefined();
    expect(() => assertGroupWorkspaceSessionExecutable(session)).not.toThrow();
  });

  it('two daemons fence stale ownership and never overwrite a newer epoch writer', async () => {
    const root = dataDir();
    writeFileSync(join(root, 'group-workspaces.json'), JSON.stringify({ schemaVersion: 2, records: {}, receipts: {} }));
    const a = new WorkspaceSchemaMigrator(root, { ownerId: 'daemon-a', now: () => 10, leaseMs: 5,
      requiredStores: ['group_json'] });
    await a.migrateOrRecover({ stopAfter: 'prepared' });
    const b = new WorkspaceSchemaMigrator(root, { ownerId: 'daemon-b', now: () => 20, leaseMs: 5,
      requiredStores: ['group_json'] });
    await b.migrateOrRecover({ stopAfter: 'per_store_staged' });
    expect(readWorkspaceMigrationManifest(root)!.writer).toMatchObject({ ownerId: 'daemon-b', fencingToken: 2 });
    await expect(a.migrateOrRecover()).rejects.toThrow('writer lease is held');
    await expect(b.migrateOrRecover()).resolves.toMatchObject({ status: 'complete' });
    expect(readWorkspaceMigrationManifest(root)!.writer.fencingToken).toBe(2);
  });

  it.each([
    'group_json', 'operation_json', 'session_sqlite', 'admin_snapshot',
  ] as const)('rejects stale and missing epoch writers for %s while another process owns the fence', async kind => {
    const root = dataDir();
    if (kind === 'group_json') writeFileSync(join(root, 'group-workspaces.json'), JSON.stringify({ schemaVersion: 2, records: {}, receipts: {} }));
    if (kind === 'operation_json') writeFileSync(join(root, 'group-workspace-operations.json'), JSON.stringify({ schemaVersion: 2, operations: {}, sourceIndex: {} }));
    if (kind === 'session_sqlite') {
      const path = join(root, 'session-stores', 'cli_a', 'sessions.db');
      mkdirSync(join(root, 'session-stores', 'cli_a'), { recursive: true });
      const db = openDatabaseSyncOrThrow(path); db.exec('CREATE TABLE sessions(session_id TEXT PRIMARY KEY,status TEXT,row TEXT)'); db.close();
    }
    if (kind === 'admin_snapshot') {
      mkdirSync(join(root, 'bot-admin-unions'), { recursive: true });
      writeFileSync(join(root, 'bot-admin-unions', 'cli_a.json'), '{}');
    }
    await new WorkspaceSchemaMigrator(root, { ownerId: 'process-a', requiredStores: [kind] })
      .migrateOrRecover({ stopAfter: 'prepared' });
    expect(() => assertWorkspaceWriterFence(root)).toThrow('active');
    expect(() => assertWorkspaceWriterFence(root, { epoch: 0, fencingToken: 0 })).toThrow('stale');
    expect(() => assertWorkspaceWriterFence(root, { epoch: 1, fencingToken: 1 })).not.toThrow();
    if (kind === 'group_json') {
      await expect(new GroupWorkspaceStore(root).mutate({ kind: 'unbind', chatId: 'chat',
        sourceEventId: 'group-workspace-text-source-v1:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        expectedRevision: 0, actor: { tenantKey: 'tenant', unionId: 'on_admin' }, authorized: true, now: 1,
      })).resolves.toMatchObject({ outcome: 'store_unavailable' });
    } else if (kind === 'operation_json') {
      const identity = { path: '/repo', dev: '1', ino: '2' };
      await expect(new GroupWorkspaceOperationStore(root).prepare({ operationKey: 'operation', sourceEventId: 'source',
        kind: 'set', requestIntentDigest: 'intent', payloadDigest: 'payload', chatId: 'chat', sessionId: 'session',
        expectedSessionGeneration: 1, expectedGroupRevision: 0, target: { kind: 'workspace', identity },
        targetWorkingDir: identity.path, targetWorkspaceIdentity: identity,
        actor: { tenantKey: 'tenant', unionId: 'on_admin' }, phase: 'prepared', updatedAt: 1,
      })).resolves.toEqual({ status: 'store_unavailable' });
    } else if (kind === 'admin_snapshot') {
      expect(() => writeBotAdminUnions(root, 'cli_a', { fingerprint: 'f', admins: ['on_admin'], exact: true, updatedAt: 1 }))
        .toThrow('workspace migration is active');
    }
  });

  it('exports separate downgrade copies without mutating v2 data, sessions, or manifest', async () => {
    const root = dataDir();
    writeFileSync(join(root, 'group-workspaces.json'), JSON.stringify({ schemaVersion: 2, records: {}, receipts: { retained: true } }));
    const dbPath = join(root, 'session-stores', 'app', 'sessions.db');
    mkdirSync(join(root, 'session-stores', 'app'), { recursive: true });
    const db = openDatabaseSyncOrThrow(dbPath); db.exec('CREATE TABLE sessions(session_id TEXT PRIMARY KEY,status TEXT,row TEXT)'); db.close();
    const migrator = new WorkspaceSchemaMigrator(root, { ownerId: 'daemon-a' });
    await migrator.migrateOrRecover();
    const original = readFileSync(join(root, 'group-workspaces.json'), 'utf8');
    const manifest = readFileSync(join(root, 'workspace-migration-manifest.json'), 'utf8');
    const sessionBefore = createHash('sha256').update(readFileSync(dbPath)).digest('hex');
    const output = join(root, 'downgrade-export');
    const exported = migrator.exportCompatibilityCopies(output);
    expect(exported.some(path => path.endsWith('group-workspaces.json'))).toBe(true);
    expect(exported.some(path => path.endsWith('sessions.db'))).toBe(true);
    expect(readFileSync(join(root, 'group-workspaces.json'), 'utf8')).toBe(original);
    expect(readFileSync(join(root, 'workspace-migration-manifest.json'), 'utf8')).toBe(manifest);
    expect(createHash('sha256').update(readFileSync(dbPath)).digest('hex')).toBe(sessionBefore);
  });
});
