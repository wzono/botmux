import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { fsyncDirectorySyncPortable, fsyncFilesAndDirectorySync, fsyncRegularFileSync } from '../utils/fs-durability.js';
import { withFileLock } from '../utils/file-lock.js';
import { workspaceRestartBlocked } from '../core/workspace-migration-supervisor.js';
import { openDatabaseSyncOrThrow } from './sqlite-compat.js';

export const WORKSPACE_MIGRATION_MANIFEST_FILE = 'workspace-migration-manifest.json';
const MANIFEST_VERSION = 1;
const TARGET_SCHEMA_VERSION = 2;

export type WorkspaceMigrationPhase =
  | 'prepared'
  | 'per_store_staged'
  | 'per_store_verified'
  | 'published'
  | 'complete';

export type WorkspaceMigrationStoreKind =
  | 'group_json'
  | 'operation_json'
  | 'session_sqlite'
  | 'admin_snapshot';

export interface WorkspaceMigrationStoreEntry {
  kind: WorkspaceMigrationStoreKind;
  sourcePath: string;
  backupPath: string;
  stagedPath: string;
  sourceChecksum: string;
  backupChecksum?: string;
  targetChecksum?: string;
  publishPoint: 'pending' | 'published';
}

export interface WorkspaceMigrationManifest {
  manifestVersion: 1;
  batchId: string;
  epoch: number;
  sourceVersion: number;
  targetVersion: number;
  phase: WorkspaceMigrationPhase;
  writer: {
    ownerId: string;
    leaseExpiresAt: number;
    fencingToken: number;
  };
  stores: Record<string, WorkspaceMigrationStoreEntry>;
  createdAt: number;
  updatedAt: number;
  fleetQuiescence?: { provenAt: number; restartBlocked: boolean; supervisorProofToken?: string };
}

export interface WorkspaceWriterFence {
  epoch: number;
  fencingToken: number;
}

export class WorkspaceMigrationFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceMigrationFenceError';
  }
}

function manifestPath(dataDir: string): string {
  return join(dataDir, WORKSPACE_MIGRATION_MANIFEST_FILE);
}

function checksum(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function durableCopySync(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(source, target);
  fsyncFilesAndDirectorySync(dirname(target), [target]);
}

function durablePublishCopySync(source: string, target: string, batchId: string): void {
  const temp = `${target}.workspace-migration-${batchId}`;
  try {
    copyFileSync(source, temp);
    fsyncRegularFileSync(temp);
    renameSync(temp, target);
    fsyncDirectorySyncPortable(dirname(target));
  } catch (error) {
    try { unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
}

function materializeStandaloneSqlite(source: string, target: string): void {
  try { unlinkSync(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const db = openDatabaseSyncOrThrow(source, { readOnly: true });
  try {
    const escaped = target.replaceAll("'", "''");
    db.exec(`VACUUM INTO '${escaped}'`);
  } finally {
    db.close();
  }
  fsyncFilesAndDirectorySync(dirname(target), [target]);
  const verify = openDatabaseSyncOrThrow(target, { readOnly: true });
  try {
    const integrity = verify.prepare('PRAGMA integrity_check').get() as Record<string, unknown> | undefined;
    if (!integrity || !Object.values(integrity).includes('ok')) {
      throw new WorkspaceMigrationFenceError('staged SQLite integrity check failed');
    }
  } finally {
    verify.close();
  }
  if (existsSync(`${target}-wal`) || existsSync(`${target}-shm`)) {
    throw new WorkspaceMigrationFenceError('staged SQLite retained WAL dependency');
  }
}

function storeKey(kind: WorkspaceMigrationStoreKind, path: string, dataDir: string): string {
  return `${kind}:${relative(dataDir, path)}`;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateManifest(value: unknown): WorkspaceMigrationManifest {
  if (!isObject(value) || value.manifestVersion !== MANIFEST_VERSION
    || typeof value.batchId !== 'string' || !value.batchId
    || !Number.isSafeInteger(value.epoch) || (value.epoch as number) < 1
    || value.targetVersion !== TARGET_SCHEMA_VERSION
    || !['prepared', 'per_store_staged', 'per_store_verified', 'published', 'complete'].includes(String(value.phase))
    || !isObject(value.writer) || !isObject(value.stores)) {
    throw new WorkspaceMigrationFenceError('invalid workspace migration manifest');
  }
  return value as unknown as WorkspaceMigrationManifest;
}

export function readWorkspaceMigrationManifest(dataDir: string): WorkspaceMigrationManifest | undefined {
  const path = manifestPath(dataDir);
  if (!existsSync(path)) return undefined;
  return validateManifest(readJson(path));
}

/** Every workspace-schema writer calls this immediately before its durable write. */
export function assertWorkspaceWriterFence(dataDir: string, fence?: WorkspaceWriterFence): void {
  const restartBlocked = workspaceRestartBlocked(dataDir);
  const manifest = readWorkspaceMigrationManifest(dataDir);
  if (!manifest) {
    if (fence) throw new WorkspaceMigrationFenceError('workspace migration fence does not exist');
    if (restartBlocked) throw new WorkspaceMigrationFenceError('workspace supervisor restart block is active');
    return;
  }
  if (manifest.targetVersion > TARGET_SCHEMA_VERSION) {
    throw new WorkspaceMigrationFenceError('future workspace schema epoch');
  }
  const matches = fence?.epoch === manifest.epoch
    && fence.fencingToken === manifest.writer.fencingToken;
  if (fence && !matches) throw new WorkspaceMigrationFenceError('stale workspace migration writer fence');
  if (manifest.phase !== 'complete' && !matches) {
    throw new WorkspaceMigrationFenceError('workspace migration is active');
  }
}

export function workspaceMigrationIngressReady(dataDir: string): boolean {
  try {
    const manifest = readWorkspaceMigrationManifest(dataDir);
    return !manifest || (manifest.phase === 'complete'
      && manifest.targetVersion === TARGET_SCHEMA_VERSION
      && Object.values(manifest.stores).every(store => store.publishPoint === 'published'));
  } catch {
    return false;
  }
}

function writeManifest(dataDir: string, manifest: WorkspaceMigrationManifest): void {
  manifest.updatedAt = Date.now();
  atomicWriteFileSync(manifestPath(dataDir), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600, durable: true, followTargetSymlink: false,
  });
}

function discoverSessionStores(dataDir: string): string[] {
  const root = join(dataDir, 'session-stores');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(root, entry.name, 'sessions.db'))
    .filter(existsSync)
    .sort();
}

function discoverAdminSnapshots(dataDir: string): string[] {
  const root = join(dataDir, 'bot-admin-unions');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => join(root, entry.name))
    .sort();
}

function defaultStorePaths(dataDir: string): Array<{ kind: WorkspaceMigrationStoreKind; path: string }> {
  return [
    { kind: 'group_json' as const, path: join(dataDir, 'group-workspaces.json') },
    { kind: 'operation_json' as const, path: join(dataDir, 'group-workspace-operations.json') },
    ...discoverSessionStores(dataDir).map(path => ({ kind: 'session_sqlite' as const, path })),
    ...discoverAdminSnapshots(dataDir).map(path => ({ kind: 'admin_snapshot' as const, path })),
  ].filter(entry => existsSync(entry.path));
}

function pathIdentity(path: string): { path: string; dev: string; ino: string } | undefined {
  try {
    const stat = statSync(path, { bigint: true });
    if (!stat.isDirectory()) return undefined;
    return { path, dev: stat.dev.toString(), ino: stat.ino.toString() };
  } catch {
    return undefined;
  }
}

function sameActor(left: unknown, right: unknown): boolean {
  return isObject(left) && isObject(right)
    && left.tenantKey === right.tenantKey && left.unionId === right.unionId;
}

function migrationSourceEventId(chatId: string, revision: number): string {
  return `group-workspace-text-source-v1:sha256:${createHash('sha256')
    .update(JSON.stringify(['workspace-schema-migration-v1', chatId, revision])).digest('hex')}`;
}

function migrationOperationKey(sourceEventId: string, kind: 'set' | 'unbind'): string {
  return `group-workspace-operation-v1:sha256:${createHash('sha256')
    .update(JSON.stringify([1, sourceEventId, kind])).digest('hex')}`;
}

function migrationPayloadDigest(chatId: string, kind: 'set' | 'unbind', target?: string): string {
  return `group-workspace-payload-v1:sha256:${createHash('sha256')
    .update(JSON.stringify([1, chatId, kind, kind === 'set' ? target : 'tombstone'])).digest('hex')}`;
}

function migrateGroupJson(path: string): void {
  const value = readJson(path);
  if (!isObject(value) || !Number.isSafeInteger(value.schemaVersion)) throw new Error('malformed group workspace store');
  if ((value.schemaVersion as number) > TARGET_SCHEMA_VERSION) throw new WorkspaceMigrationFenceError('future group workspace schema');
  if (value.schemaVersion === TARGET_SCHEMA_VERSION) return;
  if (value.schemaVersion !== 1 || !isObject(value.records) || !isObject(value.receipts)) throw new Error('malformed v1 group workspace store');
  for (const [chatId, record] of Object.entries(value.records)) {
    if (!isObject(record) || !isObject(record.directory)) throw new Error('malformed group workspace record');
    let identity: { path: string; dev: string; ino: string } | undefined;
    if (record.directory.kind === 'bound') {
      identity = typeof record.directory.workingDir === 'string' ? pathIdentity(record.directory.workingDir) : undefined;
      if (!identity) throw new WorkspaceMigrationFenceError('legacy bound workspace identity is unprovable');
      if (isObject(record.directoryIdentity)
        && (record.directoryIdentity.dev !== identity.dev || record.directoryIdentity.ino !== identity.ino)) {
        throw new WorkspaceMigrationFenceError('legacy bound workspace identity changed');
      }
      record.workspaceIdentity = identity;
      record.directoryIdentity = { dev: identity.dev, ino: identity.ino };
    }
    const directory = record.directory as Record<string, unknown>;
    const revision = Number(record.revision);
    const exact = Object.values(value.receipts).find(receipt => isObject(receipt)
      && receipt.outcome === 'committed' && receipt.chatId === chatId
      && receipt.resultingRevision === revision
      && JSON.stringify(receipt.resultingDirectory) === JSON.stringify(directory)
      && receipt.completedAt === record.updatedAt && sameActor(receipt.actor, record.updatedBy)
      && (directory.kind !== 'bound' || receipt.canonicalTargetWorkingDir === directory.workingDir));
    if (!exact && revision === 1 && isObject(record.updatedBy)) {
      const kind = directory.kind === 'bound' ? 'set' : 'unbind';
      const sourceEventId = migrationSourceEventId(chatId, revision);
      const operationKey = migrationOperationKey(sourceEventId, kind);
      value.receipts[operationKey] = {
        operationKey, sourceEventId, kind,
        payloadDigest: migrationPayloadDigest(chatId, kind,
          typeof directory.workingDir === 'string' ? directory.workingDir : undefined),
        chatId, outcome: 'committed', resultingRevision: 1,
        resultingDirectory: structuredClone(directory), actor: structuredClone(record.updatedBy),
        completedAt: record.updatedAt, expectedRevision: 0,
        ...(kind === 'set' ? { canonicalTargetWorkingDir: directory.workingDir,
          workspaceIdentity: structuredClone(identity) } : {}),
      };
    } else if (!exact) {
      throw new WorkspaceMigrationFenceError(
        `legacy group revision history is unprovable: ${chatId}:${revision}`,
      );
    }
  }
  for (const receipt of Object.values(value.receipts)) {
    if (!isObject(receipt) || receipt.kind !== 'set' || receipt.outcome !== 'committed') continue;
    const target = receipt.canonicalTargetWorkingDir;
    // Preserve an already-durable historical identity even when that old path no
    // longer exists after a later valid rebind. Never replace it with a live probe.
    if (isObject(receipt.workspaceIdentity)
      && receipt.workspaceIdentity.path === target
      && typeof receipt.workspaceIdentity.dev === 'string'
      && typeof receipt.workspaceIdentity.ino === 'string') continue;
    let identity: { path: string; dev: string; ino: string } | undefined;
    if (typeof receipt.chatId === 'string') {
      const current = value.records[receipt.chatId];
      if (isObject(current) && isObject(current.directory) && current.directory.kind === 'bound'
        && current.directory.workingDir === target && current.revision === receipt.resultingRevision
        && isObject(current.workspaceIdentity)) identity = current.workspaceIdentity as { path: string; dev: string; ino: string };
    }
    // Only a receipt for the CURRENT published binding may derive proof from the
    // live path. Historical legacy receipts remain explicit opaque history; they
    // cannot abort migration of a newer, fully proven current record.
    if (!identity && typeof target === 'string') {
      const current = typeof receipt.chatId === 'string' ? value.records[receipt.chatId] : undefined;
      if (isObject(current) && current.revision === receipt.resultingRevision) identity = pathIdentity(target);
    }
    if (identity) receipt.workspaceIdentity = identity;
    else receipt.historicalIdentity = 'legacy_unprovable';
  }
  value.schemaVersion = TARGET_SCHEMA_VERSION;
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function migrateOperationJson(path: string): void {
  const value = readJson(path);
  if (!isObject(value) || !Number.isSafeInteger(value.schemaVersion)) throw new Error('malformed operation store');
  if ((value.schemaVersion as number) > TARGET_SCHEMA_VERSION) throw new WorkspaceMigrationFenceError('future operation schema');
  if (value.schemaVersion === TARGET_SCHEMA_VERSION) return;
  if (value.schemaVersion !== 1 || !isObject(value.operations)) throw new Error('malformed v1 operation store');
  const sourceIndex: Record<string, string> = Object.create(null);
  for (const [key, operation] of Object.entries(value.operations)) {
    if (!isObject(operation) || (operation.kind !== 'set' && operation.kind !== 'unbind')) throw new Error('malformed v1 operation');
    if (operation.kind === 'unbind') operation.target = { kind: 'absent' };
    else {
      const target = operation.targetWorkingDir;
      const terminal = ['conflict', 'invalid_dir', 'unauthorized', 'store_unavailable', 'no_session_complete', 'orphaned'].includes(String(operation.phase));
      const identity = terminal && typeof target === 'string' ? pathIdentity(target) : undefined;
      if (identity) {
        operation.target = { kind: 'workspace', identity };
        operation.targetWorkspaceIdentity = identity;
      } else {
        operation.target = { kind: 'legacy_identity_missing', path: target };
        operation.legacyPhase = operation.phase;
        operation.phase = 'migration_blocked_identity_missing';
        delete operation.targetWorkspaceIdentity;
      }
    }
    operation.requestIntentDigest ??= operation.payloadDigest;
    sourceIndex[JSON.stringify([operation.sourceEventId, operation.kind])] = key;
  }
  value.sourceIndex = sourceIndex;
  value.schemaVersion = TARGET_SCHEMA_VERSION;
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function groupRecordsFromStagedStores(stores: Record<string, WorkspaceMigrationStoreEntry>): Record<string, Record<string, unknown>> {
  const group = Object.values(stores).find(store => store.kind === 'group_json');
  if (!group || !existsSync(group.stagedPath)) return Object.create(null);
  const value = readJson(group.stagedPath);
  return isObject(value) && isObject(value.records) ? value.records as Record<string, Record<string, unknown>> : Object.create(null);
}

function quarantineKnownGroup(session: Record<string, unknown>, detail: string): void {
  session.groupWorkspaceQuarantine = {
    kind: 'known_group_identity_unprovable',
    expectedIdentity: isObject(session.groupWorkspaceIdentity) ? session.groupWorkspaceIdentity : undefined,
    expectedRevision: Number.isSafeInteger(session.groupWorkspaceRevision) ? session.groupWorkspaceRevision : undefined,
    detail,
  };
}

function migrateSessionSqlite(path: string, records: Record<string, Record<string, unknown>>): void {
  const db = openDatabaseSyncOrThrow(path);
  try {
    const rows = db.prepare('SELECT session_id,row FROM sessions').all() as Array<{ session_id: string; row: string }>;
    db.exec('BEGIN IMMEDIATE');
    try {
      const update = db.prepare('UPDATE sessions SET row=? WHERE session_id=?');
      for (const stored of rows) {
        const session = JSON.parse(stored.row) as Record<string, unknown>;
        if (session.workingDirSource === undefined) {
          session.workingDirSource = 'legacy-unknown';
          delete session.groupWorkspaceRevision;
          delete session.groupWorkspaceIdentity;
          delete session.groupWorkspaceDirectoryIdentity;
        } else if (session.workingDirSource === 'group') {
          const record = typeof session.chatId === 'string' ? records[session.chatId] : undefined;
          const identity = record && isObject(record.workspaceIdentity) ? record.workspaceIdentity : undefined;
          const exact = record && isObject(record.directory) && record.directory.kind === 'bound'
            && record.directory.workingDir === session.workingDir
            && record.revision === session.groupWorkspaceRevision && identity;
          if (exact) {
            session.workspaceSchemaVersion = TARGET_SCHEMA_VERSION;
            session.groupWorkspaceIdentity = structuredClone(identity);
            session.groupWorkspaceDirectoryIdentity = { dev: identity.dev, ino: identity.ino };
          } else quarantineKnownGroup(session, !record ? 'group_record_unreadable_or_missing' : 'group_revision_or_identity_mismatch');
        }
        const follow = session.groupWorkspaceFollow;
        if (isObject(follow) && follow.schemaVersion !== TARGET_SCHEMA_VERSION) {
          const identity = typeof follow.targetWorkingDir === 'string' ? pathIdentity(follow.targetWorkingDir) : undefined;
          if (follow.phase === 'prepared' && identity) {
            follow.schemaVersion = TARGET_SCHEMA_VERSION;
            follow.journalRevision = 0;
            follow.targetWorkspaceIdentity = identity;
            follow.targetDirectoryIdentity = { dev: identity.dev, ino: identity.ino };
          } else {
            quarantineKnownGroup(session, `follow_${String(follow.phase)}_identity_unprovable`);
            session.groupWorkspaceFollowQuarantine = structuredClone(follow);
            delete session.groupWorkspaceFollow;
          }
        }
        update.run(JSON.stringify(session), stored.session_id);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}

export interface WorkspaceSchemaMigratorOptions {
  ownerId: string;
  now?: () => number;
  leaseMs?: number;
  requiredStores?: WorkspaceMigrationStoreKind[];
  transform?: (kind: WorkspaceMigrationStoreKind, source: string, staged: string) => Promise<void> | void;
  crashProbe?: (point: string, manifest: Readonly<WorkspaceMigrationManifest>) => void;
  /** Durable token issued by the live supervisor after exact-generation daemon
   * quiescence. Required by the production supervisor path; tests may exercise
   * the offline migrator without one. */
  supervisorProofToken?: string;
}

export class WorkspaceSchemaMigrator {
  private readonly now: () => number;
  private readonly leaseMs: number;

  constructor(private readonly dataDir: string, private readonly options: WorkspaceSchemaMigratorOptions) {
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? 30_000;
  }

  private probe(point: string, manifest: WorkspaceMigrationManifest): void {
    this.options.crashProbe?.(point, structuredClone(manifest));
  }

  private selectedStores(): Array<{ kind: WorkspaceMigrationStoreKind; path: string }> {
    const selected = defaultStorePaths(this.dataDir);
    if (!this.options.requiredStores) return selected;
    return selected.filter(store => this.options.requiredStores!.includes(store.kind));
  }

  private prepare(): WorkspaceMigrationManifest {
    const prior = readWorkspaceMigrationManifest(this.dataDir);
    if (prior) return prior;
    const now = this.now();
    const batchId = randomUUID();
    const root = join(this.dataDir, 'workspace-migrations', batchId);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const manifest: WorkspaceMigrationManifest = {
      manifestVersion: MANIFEST_VERSION,
      batchId,
      epoch: 1,
      sourceVersion: 1,
      targetVersion: TARGET_SCHEMA_VERSION,
      phase: 'prepared',
      writer: { ownerId: this.options.ownerId, leaseExpiresAt: now + this.leaseMs, fencingToken: 1 },
      stores: Object.create(null) as Record<string, WorkspaceMigrationStoreEntry>,
      createdAt: now,
      updatedAt: now,
      ...(this.options.supervisorProofToken ? { fleetQuiescence: {
        provenAt: now,
        restartBlocked: true,
        supervisorProofToken: this.options.supervisorProofToken,
      } } : {}),
    };
    // Publish the enforceable host fence before discovery, checkpoint, checksum,
    // or copying. Every current/future production writer consults this manifest.
    writeManifest(this.dataDir, manifest);
    this.probe('fence:published', manifest);
    return manifest;
  }

  private populateStores(manifest: WorkspaceMigrationManifest): void {
    if (manifest.phase !== 'prepared') return;
    const root = join(this.dataDir, 'workspace-migrations', manifest.batchId);
    for (const store of this.selectedStores()) {
      const key = storeKey(store.kind, store.path, this.dataDir);
      if (manifest.stores[key]) continue;
      const suffix = createHash('sha256').update(relative(this.dataDir, store.path)).digest('hex').slice(0, 12);
      const backupPath = join(root, `${suffix}-${basename(store.path)}.backup`);
      const stagedPath = join(root, `${suffix}-${basename(store.path)}.staged`);
      if (store.kind === 'session_sqlite') {
        const db = openDatabaseSyncOrThrow(store.path);
        try {
          const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number | bigint } | undefined;
          if (Number(checkpoint?.busy ?? 0) !== 0) throw new WorkspaceMigrationFenceError('session WAL is busy');
        } finally { db.close(); }
      }
      // Checksum only after WAL checkpoint: checkpoint mutates the main SQLite
      // file, so sampling first makes a healthy database look concurrently changed.
      const sourceChecksum = checksum(store.path);
      if (store.kind === 'session_sqlite') materializeStandaloneSqlite(store.path, backupPath);
      else durableCopySync(store.path, backupPath);
      if (checksum(store.path) !== sourceChecksum) {
        throw new WorkspaceMigrationFenceError(`workspace store changed during snapshot: ${key}`);
      }
      manifest.stores[key] = {
        kind: store.kind, sourcePath: store.path, backupPath, stagedPath,
        sourceChecksum, backupChecksum: checksum(backupPath), publishPoint: 'pending',
      };
      writeManifest(this.dataDir, manifest);
    }
    this.probe('phase:prepared', manifest);
  }

  private assertOwner(manifest: WorkspaceMigrationManifest): void {
    if (manifest.writer.ownerId !== this.options.ownerId) {
      if (manifest.writer.leaseExpiresAt > this.now()) {
        throw new WorkspaceMigrationFenceError('workspace migration writer lease is held');
      }
      manifest.writer = {
        ownerId: this.options.ownerId,
        leaseExpiresAt: this.now() + this.leaseMs,
        fencingToken: manifest.writer.fencingToken + 1,
      };
      writeManifest(this.dataDir, manifest);
    }
  }

  private async stage(manifest: WorkspaceMigrationManifest): Promise<void> {
    for (const [key, store] of Object.entries(manifest.stores)) {
      if (existsSync(store.stagedPath) && store.targetChecksum !== undefined) {
        if (checksum(store.stagedPath) !== store.targetChecksum) {
          throw new WorkspaceMigrationFenceError(`incomplete workspace stage: ${key}`);
        }
        continue;
      }
      if (store.targetChecksum !== undefined && checksum(store.sourcePath) === store.targetChecksum) {
        store.publishPoint = 'published';
        writeManifest(this.dataDir, manifest);
        continue;
      }
      if (checksum(store.sourcePath) !== store.sourceChecksum) {
        throw new WorkspaceMigrationFenceError(`workspace store changed after fence: ${key}`);
      }
      if (store.kind === 'session_sqlite') materializeStandaloneSqlite(store.backupPath, store.stagedPath);
      else durableCopySync(store.backupPath, store.stagedPath);
      if (store.kind === 'group_json') migrateGroupJson(store.stagedPath);
      else if (store.kind === 'operation_json') migrateOperationJson(store.stagedPath);
      else if (store.kind === 'session_sqlite') migrateSessionSqlite(store.stagedPath, groupRecordsFromStagedStores(manifest.stores));
      await this.options.transform?.(store.kind, store.backupPath, store.stagedPath);
      fsyncFilesAndDirectorySync(dirname(store.stagedPath), [store.stagedPath]);
      if (store.kind === 'session_sqlite') {
        const verify = openDatabaseSyncOrThrow(store.stagedPath, { readOnly: true });
        try { verify.prepare('SELECT COUNT(*) AS count FROM sessions').get(); } finally { verify.close(); }
        if (existsSync(`${store.stagedPath}-wal`) || existsSync(`${store.stagedPath}-shm`)) {
          throw new WorkspaceMigrationFenceError(`staged SQLite has WAL dependency: ${key}`);
        }
      }
      this.probe(`stage:${key}`, manifest);
    }
    manifest.phase = 'per_store_staged';
    writeManifest(this.dataDir, manifest);
    this.probe('phase:per_store_staged', manifest);
  }

  private verify(manifest: WorkspaceMigrationManifest): void {
    for (const [key, store] of Object.entries(manifest.stores)) {
      if (!existsSync(store.backupPath) || checksum(store.backupPath) !== (store.backupChecksum ?? store.sourceChecksum)) {
        throw new WorkspaceMigrationFenceError(`workspace backup checksum mismatch: ${key}`);
      }
      if (!existsSync(store.stagedPath)) throw new WorkspaceMigrationFenceError(`workspace stage missing: ${key}`);
      store.targetChecksum = checksum(store.stagedPath);
    }
    manifest.phase = 'per_store_verified';
    writeManifest(this.dataDir, manifest);
    this.probe('phase:per_store_verified', manifest);
  }

  private publish(manifest: WorkspaceMigrationManifest): void {
    for (const [key, store] of Object.entries(manifest.stores)) {
      if (store.publishPoint === 'published') {
        if (checksum(store.sourcePath) !== store.targetChecksum) {
          throw new WorkspaceMigrationFenceError(`published workspace checksum mismatch: ${key}`);
        }
        continue;
      }
      const liveChecksum = checksum(store.sourcePath);
      if (liveChecksum === store.targetChecksum) {
        store.publishPoint = 'published';
        writeManifest(this.dataDir, manifest);
        this.probe(`publish-recovered:${key}`, manifest);
        continue;
      }
      if (liveChecksum !== store.sourceChecksum) {
        throw new WorkspaceMigrationFenceError(`newer fenced data would be overwritten: ${key}`);
      }
      durablePublishCopySync(store.stagedPath, store.sourcePath, manifest.batchId);
      this.probe(`publish-renamed:${key}`, manifest);
      store.publishPoint = 'published';
      writeManifest(this.dataDir, manifest);
      this.probe(`publish:${key}`, manifest);
    }
    manifest.phase = 'published';
    writeManifest(this.dataDir, manifest);
    this.probe('phase:published', manifest);
  }

  private complete(manifest: WorkspaceMigrationManifest): void {
    for (const [key, store] of Object.entries(manifest.stores)) {
      if (store.publishPoint !== 'published' || checksum(store.sourcePath) !== store.targetChecksum) {
        throw new WorkspaceMigrationFenceError(`workspace epoch is mixed: ${key}`);
      }
    }
    manifest.phase = 'complete';
    writeManifest(this.dataDir, manifest);
    this.probe('phase:complete', manifest);
  }

  private rollbackBeforePublish(manifest: WorkspaceMigrationManifest): void {
    if (Object.values(manifest.stores).some(store => store.publishPoint === 'published')) return;
    if (manifest.phase === 'per_store_verified') {
      const checksums = Object.values(manifest.stores).map(store => ({
        store,
        live: existsSync(store.sourcePath) ? checksum(store.sourcePath) : undefined,
      }));
      const hasPublishedTarget = checksums.some(({ store, live }) =>
        store.targetChecksum !== undefined && store.targetChecksum !== store.sourceChecksum
        && live === store.targetChecksum);
      const hasThirdChecksum = checksums.some(({ store, live }) =>
        live !== store.sourceChecksum && live !== store.targetChecksum);
      if (hasThirdChecksum) throw new WorkspaceMigrationFenceError('workspace store changed while fenced');
      if (hasPublishedTarget) return;
    }
    for (const [key, store] of Object.entries(manifest.stores)) {
      if (checksum(store.backupPath) !== (store.backupChecksum ?? store.sourceChecksum)) {
        throw new WorkspaceMigrationFenceError('workspace rollback backup checksum mismatch');
      }
      if (checksum(store.sourcePath) !== store.sourceChecksum) {
        throw new WorkspaceMigrationFenceError(`workspace store changed while fenced: ${key}`);
      }
    }
  }

  async migrateOrRecover(options: { stopAfter?: WorkspaceMigrationPhase } = {}): Promise<
    { status: 'complete'; epoch: number; fence: WorkspaceWriterFence }
    | { status: 'incomplete'; phase: WorkspaceMigrationPhase; epoch: number }
  > {
    mkdirSync(this.dataDir, { recursive: true });
    return withFileLock(manifestPath(this.dataDir), async () => {
      let manifest = this.prepare();
      if (this.options.supervisorProofToken && !workspaceRestartBlocked(this.dataDir)) {
        throw new WorkspaceMigrationFenceError('supervisor restart block was lost');
      }
      if (manifest.targetVersion > TARGET_SCHEMA_VERSION) throw new WorkspaceMigrationFenceError('future workspace migration version');
      if (manifest.phase === 'complete') {
        if (!workspaceMigrationIngressReady(this.dataDir)) throw new WorkspaceMigrationFenceError('completed workspace epoch failed verification');
        return { status: 'complete', epoch: manifest.epoch,
          fence: { epoch: manifest.epoch, fencingToken: manifest.writer.fencingToken } };
      }
      this.assertOwner(manifest);
      this.populateStores(manifest);
      this.rollbackBeforePublish(manifest);
      if (options.stopAfter === manifest.phase) return { status: 'incomplete', phase: manifest.phase, epoch: manifest.epoch };
      if (manifest.phase === 'prepared') await this.stage(manifest);
      if (options.stopAfter === manifest.phase) return { status: 'incomplete', phase: manifest.phase, epoch: manifest.epoch };
      if (manifest.phase === 'per_store_staged') this.verify(manifest);
      if (options.stopAfter === manifest.phase) return { status: 'incomplete', phase: manifest.phase, epoch: manifest.epoch };
      if (manifest.phase === 'per_store_verified') this.publish(manifest);
      if (options.stopAfter === manifest.phase) return { status: 'incomplete', phase: manifest.phase, epoch: manifest.epoch };
      if (manifest.phase === 'published') this.complete(manifest);
      manifest = readWorkspaceMigrationManifest(this.dataDir)!;
      return { status: 'complete', epoch: manifest.epoch,
        fence: { epoch: manifest.epoch, fencingToken: manifest.writer.fencingToken } };
    });
  }

  /** A downgrade is an export, never an in-place rollback. */
  exportCompatibilityCopies(outputDir: string): string[] {
    const manifest = readWorkspaceMigrationManifest(this.dataDir);
    if (!manifest || manifest.phase !== 'complete') throw new WorkspaceMigrationFenceError('workspace migration is not complete');
    mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    const exported: string[] = [];
    for (const store of Object.values(manifest.stores)) {
      const target = join(outputDir, relative(this.dataDir, store.sourcePath));
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(store.backupPath, target);
      exported.push(target);
    }
    const manifestCopy = join(outputDir, WORKSPACE_MIGRATION_MANIFEST_FILE);
    writeFileSync(manifestCopy, readFileSync(manifestPath(this.dataDir)));
    exported.push(manifestCopy);
    return exported;
  }
}
