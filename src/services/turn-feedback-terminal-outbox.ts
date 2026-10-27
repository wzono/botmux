import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import type { DaemonToWorker, WorkerToDaemon } from '../types.js';
import { readDurableProcessIdentity } from '../utils/process-identity.js';

export interface TurnFeedbackTerminalRecord {
  version: 1;
  terminalRequestId: string;
  ownerAppId: string;
  sessionId: string;
  turnId: string;
  dispatchAttempt?: number;
  workerGeneration: number;
  status: 'completed' | 'failed' | 'cancelled' | 'ambiguous';
  completedAtMs?: number;
  durationMs?: number;
  savedAtMs: number;
}

export interface TurnFeedbackTerminalOutboxItem {
  path: string;
  record: TurnFeedbackTerminalRecord;
}

export interface TurnFeedbackSuspendWriteFence {
  submit(write: () => void): 'written' | 'deferred' | 'rejected';
  submitAsync(write: () => Promise<void>): Promise<'written' | 'deferred' | 'rejected'>;
  prepare(): void;
  commit(): void;
  resume(): void;
  discard(): void;
  pendingCount(): number;
}

/** FIFO fence for authenticated terminal writes during suspend preparation. */
export function createTurnFeedbackSuspendWriteFence(
  onError: (error: unknown) => void = () => undefined,
): TurnFeedbackSuspendWriteFence {
  let state: 'active' | 'preparing' | 'quiesced' | 'draining' = 'active';
  const pending: Array<{
    kind: 'sync' | 'async';
    write: () => void | Promise<void>;
    resolve?: (result: 'deferred') => void;
    reject?: (error: unknown) => void;
  }> = [];
  let inFlight = 0;
  const runAsync = async (write: () => Promise<void>): Promise<void> => {
    inFlight += 1;
    try { await write(); } finally { inFlight -= 1; }
  };
  return {
    submit(write) {
      if (state === 'active') { write(); return 'written'; }
      if (state === 'quiesced') return 'rejected';
      pending.push({ kind: 'sync', write });
      return 'deferred';
    },
    async submitAsync(write) {
      if (state === 'quiesced') return 'rejected';
      if (state === 'preparing' || state === 'draining') {
        return new Promise<'deferred'>((resolve, reject) => {
          pending.push({ kind: 'async', write, resolve, reject });
        });
      }
      await runAsync(write);
      return 'written';
    },
    prepare() { if (state === 'active') state = 'preparing'; },
    commit() { state = 'quiesced'; },
    resume() {
      if (state === 'draining' || state === 'active') return;
      state = 'draining';
      const drain = (): void => {
        while (pending.length > 0) {
          const item = pending.shift()!;
          if (item.kind === 'sync') {
            try { item.write(); } catch (error) { onError(error); }
            continue;
          }
          void (async () => {
            try {
              await runAsync(item.write as () => Promise<void>);
              item.resolve?.('deferred');
            } catch (error) {
              onError(error);
              item.reject?.(error);
            }
            drain();
          })();
          return;
        }
        state = 'active';
      };
      drain();
    },
    discard() {
      state = 'active';
      for (const item of pending.splice(0)) item.resolve?.('deferred');
    },
    pendingCount: () => pending.length + inFlight,
  };
}

const ROOT = 'turn-feedback-terminal-outbox';
const QUARANTINE = 'quarantine';
const SUSPEND_READY = '.suspend-ready';
const MAX_RECORD_BYTES = 2_048;
const MAX_RECORDS_PER_APP = 512;
const MAX_PENDING_AGE_MS = 30 * 86_400_000;
const MAX_QUARANTINE_FILES = 256;
const MAX_QUARANTINE_AGE_MS = 30 * 86_400_000;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_TURN = /^[\x21-\x7e]{1,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECORD_KEYS = new Set([
  'version', 'terminalRequestId', 'ownerAppId', 'sessionId', 'turnId',
  'dispatchAttempt', 'workerGeneration', 'status', 'completedAtMs',
  'durationMs', 'savedAtMs',
]);
let terminalCapacityProcessIdentityReader = readDurableProcessIdentity;

export function __testOnly_setTerminalCapacityProcessIdentityReader(
  reader?: typeof readDurableProcessIdentity,
): void {
  terminalCapacityProcessIdentityReader = reader ?? readDurableProcessIdentity;
}

function safeInteger(value: unknown, positive = false): value is number {
  return Number.isSafeInteger(value) && (positive ? Number(value) > 0 : Number(value) >= 0);
}

function assertSafeSegment(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SAFE_SEGMENT.test(value) || value === '.' || value === '..') {
    throw new Error(`invalid terminal outbox ${label}`);
  }
}

export function validateTurnFeedbackTerminalRecord(
  input: unknown,
): TurnFeedbackTerminalRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid terminal outbox record');
  }
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some(key => !RECORD_KEYS.has(key))) {
    throw new Error('terminal outbox record contains unknown keys');
  }
  if (raw.version !== 1 || typeof raw.terminalRequestId !== 'string'
    || !UUID.test(raw.terminalRequestId)) {
    throw new Error('invalid terminal outbox identity');
  }
  assertSafeSegment(raw.ownerAppId, 'ownerAppId');
  assertSafeSegment(raw.sessionId, 'sessionId');
  if (typeof raw.turnId !== 'string' || !SAFE_TURN.test(raw.turnId)) {
    throw new Error('invalid terminal outbox turnId');
  }
  if (!safeInteger(raw.workerGeneration, true)
    || (raw.dispatchAttempt !== undefined && !safeInteger(raw.dispatchAttempt))
    || (raw.completedAtMs !== undefined && !safeInteger(raw.completedAtMs))
    || (raw.durationMs !== undefined && !safeInteger(raw.durationMs))
    || !safeInteger(raw.savedAtMs)) {
    throw new Error('invalid terminal outbox number');
  }
  if (!['completed', 'failed', 'cancelled', 'ambiguous'].includes(String(raw.status))) {
    throw new Error('invalid terminal outbox status');
  }
  const encoded = JSON.stringify(raw);
  if (Buffer.byteLength(encoded) > MAX_RECORD_BYTES) {
    throw new Error('terminal outbox record exceeds maximum bytes');
  }
  return structuredClone(raw) as unknown as TurnFeedbackTerminalRecord;
}

function ensureSecureDirectory(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
    return;
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`terminal outbox directory is a symlink: ${path}`);
  if (!stat.isDirectory()) throw new Error(`terminal outbox path is not a directory: ${path}`);
  const uid = process.getuid?.();
  if ((stat.mode & 0o777) !== 0o700 || (uid !== undefined && stat.uid !== uid)) {
    throw new Error(`terminal outbox directory is insecure: ${path}`);
  }
}

function assertSecureDirectory(path: string): void {
  if (!existsSync(path)) throw new Error(`terminal outbox directory is missing: ${path}`);
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (stat.isSymbolicLink() || !stat.isDirectory()
    || (stat.mode & 0o777) !== 0o700
    || (uid !== undefined && stat.uid !== uid)) {
    throw new Error(`terminal outbox directory is insecure: ${path}`);
  }
}

function rootPath(dataDir: string): string {
  const canonicalDataDir = realpathSync(dataDir);
  const root = join(canonicalDataDir, ROOT);
  ensureSecureDirectory(root);
  return root;
}

function recordPath(dataDir: string, record: TurnFeedbackTerminalRecord): string {
  const root = rootPath(dataDir);
  const app = join(root, record.ownerAppId);
  const session = join(app, record.sessionId);
  const generation = join(session, String(record.workerGeneration));
  ensureSecureDirectory(app);
  ensureSecureDirectory(session);
  ensureSecureDirectory(generation);
  return join(generation, `${record.terminalRequestId}.json`);
}

function generationPath(dataDir: string, identity: {
  ownerAppId: string; sessionId: string; workerGeneration: number;
}): string {
  assertSafeSegment(identity.ownerAppId, 'ownerAppId');
  assertSafeSegment(identity.sessionId, 'sessionId');
  if (!safeInteger(identity.workerGeneration, true)) {
    throw new Error('invalid terminal outbox workerGeneration');
  }
  const root = rootPath(dataDir);
  const app = join(root, identity.ownerAppId);
  const session = join(app, identity.sessionId);
  const generation = join(session, String(identity.workerGeneration));
  ensureSecureDirectory(app);
  ensureSecureDirectory(session);
  ensureSecureDirectory(generation);
  return generation;
}

function requestPath(dataDir: string, identity: {
  ownerAppId: string;
  sessionId: string;
  workerGeneration: number;
  terminalRequestId: string;
}): string {
  assertSafeSegment(identity.ownerAppId, 'ownerAppId');
  assertSafeSegment(identity.sessionId, 'sessionId');
  if (!safeInteger(identity.workerGeneration, true) || !UUID.test(identity.terminalRequestId)) {
    throw new Error('invalid terminal outbox request identity');
  }
  return join(
    rootPath(dataDir), identity.ownerAppId, identity.sessionId,
    String(identity.workerGeneration), `${identity.terminalRequestId}.json`,
  );
}

function readSecureFile(path: string): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      fsConstants.O_RDONLY
        | (process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW)
        | fsConstants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600
      || (uid !== undefined && stat.uid !== uid)
      || stat.size <= 0 || stat.size > MAX_RECORD_BYTES) {
      throw new Error('unsafe terminal outbox file');
    }
    return readFileSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function sameRecord(left: TurnFeedbackTerminalRecord, right: TurnFeedbackTerminalRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readCapacityLockFile(path: string): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      fsConstants.O_RDONLY
        | (process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW)
        | fsConstants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    // nlink=2 is the crash-safe publish interval: canonical lock + initialized
    // candidate name. Both names pin the same immutable owner inode.
    if (!stat.isFile() || stat.nlink < 1 || stat.nlink > 2
      || (stat.mode & 0o777) !== 0o600
      || (uid !== undefined && stat.uid !== uid)
      || stat.size <= 0 || stat.size > MAX_RECORD_BYTES) {
      throw new Error('unsafe terminal outbox capacity lock');
    }
    return readFileSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function countJsonFiles(path: string): number {
  if (!existsSync(path)) return 0;
  let count = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === QUARANTINE) continue;
    const child = join(path, entry.name);
    const stat = lstatSync(child);
    const uid = process.getuid?.();
    if (stat.isSymbolicLink()) throw new Error('terminal outbox capacity tree contains symlink');
    if (stat.isDirectory()) {
      if ((stat.mode & 0o777) !== 0o700 || (uid !== undefined && stat.uid !== uid)) {
        throw new Error('terminal outbox capacity tree contains insecure directory');
      }
      count += countJsonFiles(child);
    } else if (stat.isFile() && entry.name.endsWith('.json')) count += 1;
  }
  return count;
}

function withAppCapacityLock<T>(appDir: string, run: () => T): T {
  const lock = join(appDir, '.capacity.lock');
  const processStart = terminalCapacityProcessIdentityReader(process.pid);
  let fd: number | undefined;
  let ownedLock: { dev: number; ino: number } | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = join(
      appDir,
      `.capacity.lock.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
    );
    try {
      fd = openSync(
        candidate,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
          | (process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW),
        0o600,
      );
      writeFileSync(fd, JSON.stringify({
        version: 1, pid: process.pid,
        ...(processStart ? { processStart } : {}),
        createdAtMs: Date.now(),
      }));
      fsyncSync(fd);
      const stat = fstatSync(fd);
      linkSync(candidate, lock);
      ownedLock = { dev: stat.dev, ino: stat.ino };
      try { unlinkSync(candidate); } catch { /* canonical inode already owns the lock */ }
      break;
    } catch (error) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* best-effort candidate cleanup */ }
        fd = undefined;
      }
      try { unlinkSync(candidate); } catch { /* candidate may not exist */ }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const stat = lstatSync(lock);
        const uid = process.getuid?.();
        if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink < 1 || stat.nlink > 2
          || (stat.mode & 0o777) !== 0o600
          || (uid !== undefined && stat.uid !== uid)) {
          throw new Error('terminal outbox capacity lock is unsafe');
        }
        const owner = JSON.parse(readCapacityLockFile(lock).toString('utf8')) as {
          version?: unknown; pid?: unknown; processStart?: unknown; createdAtMs?: unknown;
        };
        const pid = Number(owner.pid);
        if ((owner.version !== undefined && owner.version !== 1)
          || !Number.isSafeInteger(pid) || pid <= 1) {
          throw new Error('terminal outbox capacity lock owner is malformed');
        }
        const recordedStart = typeof owner.processStart === 'string' ? owner.processStart : undefined;
        let pidStatus: 'alive' | 'dead' | 'unknown';
        try {
          process.kill(pid, 0);
          pidStatus = 'alive';
        } catch (probeError) {
          const code = (probeError as NodeJS.ErrnoException).code;
          pidStatus = code === 'EPERM' ? 'alive' : code === 'ESRCH' ? 'dead' : 'unknown';
        }
        const liveStart = pidStatus === 'alive'
          ? terminalCapacityProcessIdentityReader(pid) : undefined;
        const identityMismatch = recordedStart !== undefined
          && liveStart !== undefined
          && recordedStart !== liveStart;
        if (pidStatus === 'dead' || identityMismatch) {
          const current = lstatSync(lock);
          if (current.dev === stat.dev && current.ino === stat.ino) {
            unlinkSync(lock);
            for (const entry of readdirSync(appDir, { withFileTypes: true })) {
              if (!entry.isFile()
                || !/^\.capacity\.lock\.\d+\.[0-9a-f]{16}\.tmp$/.test(entry.name)) continue;
              const orphan = join(appDir, entry.name);
              try {
                const orphanStat = lstatSync(orphan);
                if (orphanStat.dev === stat.dev && orphanStat.ino === stat.ino) unlinkSync(orphan);
              } catch { /* a concurrent cleanup may already have removed it */ }
            }
          }
          continue;
        }
      } catch (lockError) {
        if (lockError instanceof Error
          && lockError.message.includes('capacity lock is unsafe')) throw lockError;
        // A canonical lock is published only after its owner record is fully
        // initialized. Any malformed legacy/foreign inode has unknown ownership
        // and must remain fail-closed; age alone never proves its creator gone.
      }
      if (attempt === 99) throw new Error('terminal outbox capacity lock unavailable');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  if (fd === undefined) throw new Error('terminal outbox capacity lock unavailable');
  try { return run(); } finally {
    closeSync(fd);
    try {
      const current = lstatSync(lock);
      if (ownedLock && current.dev === ownedLock.dev && current.ino === ownedLock.ino) unlinkSync(lock);
    } catch { /* lock owner cleanup is best-effort */ }
  }
}

export function writeTurnFeedbackTerminalOutbox(
  dataDir: string,
  input: TurnFeedbackTerminalRecord,
): string {
  const record = validateTurnFeedbackTerminalRecord(input);
  const path = recordPath(dataDir, record);
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('terminal outbox leaf is a symlink');
    const existing = validateTurnFeedbackTerminalRecord(JSON.parse(readSecureFile(path).toString('utf8')));
    if (!sameRecord(existing, record)) throw new Error('terminal outbox identity conflict');
    return path;
  }
  const appDir = join(rootPath(dataDir), record.ownerAppId);
  return withAppCapacityLock(appDir, () => {
    if (existsSync(path)) {
      const existing = validateTurnFeedbackTerminalRecord(JSON.parse(readSecureFile(path).toString('utf8')));
      if (!sameRecord(existing, record)) throw new Error('terminal outbox identity conflict');
      return path;
    }
    if (countJsonFiles(appDir) >= MAX_RECORDS_PER_APP) {
      throw new Error('terminal outbox capacity exceeded');
    }
    atomicWriteFileSync(path, JSON.stringify(record), {
      mode: 0o600, durable: true, followTargetSymlink: false,
    });
    return path;
  });
}

export function readTurnFeedbackTerminalOutbox(
  dataDir: string,
  identity: TurnFeedbackTerminalRecord,
): TurnFeedbackTerminalRecord | undefined {
  const expected = validateTurnFeedbackTerminalRecord(identity);
  const path = recordPath(dataDir, expected);
  if (!existsSync(path)) return undefined;
  const actual = validateTurnFeedbackTerminalRecord(JSON.parse(readSecureFile(path).toString('utf8')));
  if (!sameRecord(actual, expected)) throw new Error('terminal outbox identity conflict');
  return actual;
}

export function readTurnFeedbackTerminalRequest(
  dataDir: string,
  identity: { ownerAppId: string; sessionId: string; workerGeneration: number; terminalRequestId: string },
): TurnFeedbackTerminalRecord | undefined {
  const root = rootPath(dataDir);
  const appDir = join(root, identity.ownerAppId);
  const sessionDir = join(appDir, identity.sessionId);
  const generationDir = join(sessionDir, String(identity.workerGeneration));
  if (!existsSync(appDir) || !existsSync(sessionDir) || !existsSync(generationDir)) return undefined;
  assertSecureDirectory(appDir);
  assertSecureDirectory(sessionDir);
  assertSecureDirectory(generationDir);
  const path = requestPath(dataDir, identity);
  if (!existsSync(path)) return undefined;
  const record = validateTurnFeedbackTerminalRecord(JSON.parse(readSecureFile(path).toString('utf8')));
  if (record.ownerAppId !== identity.ownerAppId
    || record.sessionId !== identity.sessionId
    || record.workerGeneration !== identity.workerGeneration
    || record.terminalRequestId !== identity.terminalRequestId
    || requestPath(dataDir, record) !== path) {
    throw new Error('terminal outbox request path mismatch');
  }
  return record;
}

export function removeTurnFeedbackTerminalOutbox(
  dataDir: string,
  identity: TurnFeedbackTerminalRecord,
): boolean {
  let existing: TurnFeedbackTerminalRecord | undefined;
  try { existing = readTurnFeedbackTerminalOutbox(dataDir, identity); } catch { return false; }
  if (!existing) return false;
  unlinkSync(recordPath(dataDir, identity));
  return true;
}

export function quarantineTurnFeedbackTerminalOutbox(
  dataDir: string,
  identity: TurnFeedbackTerminalRecord,
  nowMs = Date.now(),
): string | undefined {
  const record = validateTurnFeedbackTerminalRecord(identity);
  const exact = readTurnFeedbackTerminalRequest(dataDir, {
    ownerAppId: record.ownerAppId, sessionId: record.sessionId,
    workerGeneration: record.workerGeneration, terminalRequestId: record.terminalRequestId,
  });
  if (!exact || !sameRecord(exact, record)) return undefined;
  const path = requestPath(dataDir, record);
  if (!existsSync(path)) return undefined;
  const root = rootPath(dataDir);
  const target = quarantine(root, path, nowMs);
  pruneQuarantine(root, nowMs);
  return target;
}

function quarantinePath(root: string, path: string, nowMs: number): string {
  const quarantine = join(root, QUARANTINE);
  ensureSecureDirectory(quarantine);
  return join(
    quarantine,
    `${basename(path)}.${nowMs}.${randomBytes(4).toString('hex')}.quarantine`,
  );
}

function quarantine(root: string, path: string, nowMs: number): string {
  const target = quarantinePath(root, path, nowMs);
  renameSync(path, target);
  return target;
}

function pruneQuarantine(root: string, nowMs = Date.now()): void {
  const path = join(root, QUARANTINE);
  if (!existsSync(path)) return;
  const entries = readdirSync(path, { withFileTypes: true })
    .map(entry => {
      const timestamp = /\.(\d+)\.[0-9a-f]{8}\.quarantine$/.exec(entry.name);
      return {
        name: entry.name, path: join(path, entry.name),
        atMs: timestamp ? Number(timestamp[1]) : 0,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const expired = entries.filter(entry => !Number.isSafeInteger(entry.atMs)
    || entry.atMs < nowMs - MAX_QUARANTINE_AGE_MS
    || entry.atMs > nowMs);
  for (const entry of expired) rmSync(entry.path, { force: true, recursive: true });
  const remaining = entries.filter(entry => !expired.includes(entry));
  for (const entry of remaining.slice(0, Math.max(0, remaining.length - MAX_QUARANTINE_FILES))) {
    rmSync(entry.path, { force: true, recursive: true });
  }
}

function collectRecordPaths(path: string, found: string[], unsafe: string[]): void {
  if (!existsSync(path)) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === QUARANTINE
      || entry.name === '.capacity.lock'
      || entry.name === SUSPEND_READY
      || /^\.capacity\.lock\.\d+\.[0-9a-f]{16}\.tmp$/.test(entry.name)) continue;
    const child = join(path, entry.name);
    const stat = lstatSync(child);
    const uid = process.getuid?.();
    if (stat.isSymbolicLink()) { unsafe.push(child); continue; }
    if (stat.isDirectory()) {
      if ((stat.mode & 0o777) !== 0o700 || (uid !== undefined && stat.uid !== uid)) unsafe.push(child);
      else collectRecordPaths(child, found, unsafe);
    }
    else if (stat.isFile() && entry.name.endsWith('.json')) found.push(child);
    else unsafe.push(child);
  }
}

export function listTurnFeedbackTerminalOutbox(
  dataDir: string,
  ownerAppId: string,
  nowMs = Date.now(),
): { records: TurnFeedbackTerminalOutboxItem[]; quarantined: string[] } {
  assertSafeSegment(ownerAppId, 'ownerAppId');
  const root = rootPath(dataDir);
  const appDir = join(root, ownerAppId);
  if (!existsSync(appDir)) return { records: [], quarantined: [] };
  const appStat = lstatSync(appDir);
  const uid = process.getuid?.();
  if (appStat.isSymbolicLink() || !appStat.isDirectory()
    || (appStat.mode & 0o777) !== 0o700
    || (uid !== undefined && appStat.uid !== uid)) {
    return { records: [], quarantined: [quarantine(root, appDir, nowMs)] };
  }
  const paths: string[] = [];
  const unsafe: string[] = [];
  collectRecordPaths(appDir, paths, unsafe);
  const records: TurnFeedbackTerminalOutboxItem[] = [];
  const quarantined = unsafe.map(path => quarantine(root, path, nowMs));
  for (const path of paths) {
    try {
      const record = validateTurnFeedbackTerminalRecord(JSON.parse(readSecureFile(path).toString('utf8')));
      if (record.ownerAppId !== ownerAppId
        || requestPath(dataDir, record) !== path
        || record.savedAtMs > nowMs
        || record.savedAtMs < nowMs - MAX_PENDING_AGE_MS) {
        quarantined.push(quarantine(root, path, nowMs));
        continue;
      }
      records.push({ path, record });
    } catch {
      quarantined.push(quarantine(root, path, nowMs));
    }
  }
  records.sort((left, right) =>
    left.record.savedAtMs - right.record.savedAtMs
      || left.record.terminalRequestId.localeCompare(right.record.terminalRequestId));
  pruneQuarantine(root, nowMs);
  return { records, quarantined };
}

/** Read-only, exact-worker pending probe used before destroying a live worker.
 * Any malformed or insecure state throws so the caller can fail closed. */
export function hasPendingTurnFeedbackTerminalOutbox(
  dataDir: string,
  identity: { ownerAppId: string; sessionId: string; workerGeneration: number },
  settled: (record: TurnFeedbackTerminalRecord) => boolean = () => false,
): boolean {
  assertSafeSegment(identity.ownerAppId, 'ownerAppId');
  assertSafeSegment(identity.sessionId, 'sessionId');
  if (!safeInteger(identity.workerGeneration, true)) {
    throw new Error('invalid terminal outbox workerGeneration');
  }
  const root = join(realpathSync(dataDir), ROOT);
  if (!existsSync(root)) return false;
  assertSecureDirectory(root);
  const appDir = join(root, identity.ownerAppId);
  if (!existsSync(appDir)) return false;
  assertSecureDirectory(appDir);
  const sessionDir = join(appDir, identity.sessionId);
  if (!existsSync(sessionDir)) return false;
  assertSecureDirectory(sessionDir);
  const generationDir = join(sessionDir, String(identity.workerGeneration));
  if (!existsSync(generationDir)) return false;
  assertSecureDirectory(generationDir);
  const entries = readdirSync(generationDir, { withFileTypes: true });
  const recordEntries = entries.filter(entry => entry.name !== SUSPEND_READY);
  if (recordEntries.length > MAX_RECORDS_PER_APP) {
    throw new Error('terminal outbox worker directory exceeds capacity');
  }
  for (const entry of recordEntries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      throw new Error('terminal outbox worker directory contains unsafe entry');
    }
    const path = join(generationDir, entry.name);
    const record = validateTurnFeedbackTerminalRecord(
      JSON.parse(readSecureFile(path).toString('utf8')),
    );
    if (record.ownerAppId !== identity.ownerAppId
      || record.sessionId !== identity.sessionId
      || record.workerGeneration !== identity.workerGeneration
      || entry.name !== `${record.terminalRequestId}.json`) {
      throw new Error('terminal outbox worker record path mismatch');
    }
    if (!settled(record)) return true;
  }
  return false;
}

/** After the worker ACKs quiescence, serialize against every outbox writer,
 * require every current-generation record to have an exact durable receipt,
 * and remove those settled files before the generation can be retired. */
export function settleTurnFeedbackTerminalOutboxForSuspend(
  dataDir: string,
  identity: { ownerAppId: string; sessionId: string; workerGeneration: number },
  settled: (record: TurnFeedbackTerminalRecord) => boolean,
): boolean {
  assertSafeSegment(identity.ownerAppId, 'ownerAppId');
  assertSafeSegment(identity.sessionId, 'sessionId');
  if (!safeInteger(identity.workerGeneration, true)) {
    throw new Error('invalid terminal outbox workerGeneration');
  }
  const root = rootPath(dataDir);
  const appDir = join(root, identity.ownerAppId);
  if (!existsSync(appDir)) return true;
  assertSecureDirectory(appDir);
  return withAppCapacityLock(appDir, () => {
    const sessionDir = join(appDir, identity.sessionId);
    if (!existsSync(sessionDir)) return true;
    assertSecureDirectory(sessionDir);
    const generationDir = join(sessionDir, String(identity.workerGeneration));
    if (!existsSync(generationDir)) return true;
    assertSecureDirectory(generationDir);
    const entries = readdirSync(generationDir, { withFileTypes: true });
    const recordEntries = entries.filter(entry => entry.name !== SUSPEND_READY);
    if (recordEntries.length > MAX_RECORDS_PER_APP) {
      throw new Error('terminal outbox worker directory exceeds capacity');
    }
    const removable: Array<{ path: string; dev: number; ino: number }> = [];
    for (const entry of recordEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        throw new Error('terminal outbox worker directory contains unsafe entry');
      }
      const path = join(generationDir, entry.name);
      const record = validateTurnFeedbackTerminalRecord(
        JSON.parse(readSecureFile(path).toString('utf8')),
      );
      if (record.ownerAppId !== identity.ownerAppId
        || record.sessionId !== identity.sessionId
        || record.workerGeneration !== identity.workerGeneration
        || entry.name !== `${record.terminalRequestId}.json`) {
        throw new Error('terminal outbox worker record path mismatch');
      }
      if (!settled(record)) return false;
      const stat = lstatSync(path);
      removable.push({ path, dev: stat.dev, ino: stat.ino });
    }
    for (const item of removable) {
      const current = lstatSync(item.path);
      if (current.dev !== item.dev || current.ino !== item.ino
        || !current.isFile() || current.isSymbolicLink()) {
        throw new Error('terminal outbox settled record changed before removal');
      }
      unlinkSync(item.path);
    }
    return true;
  });
}

export interface TurnFeedbackTerminalSuspendReady {
  version: 1;
  ownerAppId: string;
  sessionId: string;
  workerGeneration: number;
  requestId: string;
}

function validateSuspendReady(input: unknown): TurnFeedbackTerminalSuspendReady {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid terminal suspend ready marker');
  }
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => ![
    'version', 'ownerAppId', 'sessionId', 'workerGeneration', 'requestId',
  ].includes(key)) || value.version !== 1) {
    throw new Error('invalid terminal suspend ready marker');
  }
  assertSafeSegment(value.ownerAppId, 'ownerAppId');
  assertSafeSegment(value.sessionId, 'sessionId');
  if (!safeInteger(value.workerGeneration, true)
    || typeof value.requestId !== 'string' || !UUID.test(value.requestId)) {
    throw new Error('invalid terminal suspend ready identity');
  }
  return structuredClone(value) as unknown as TurnFeedbackTerminalSuspendReady;
}

export function writeTurnFeedbackTerminalSuspendReady(
  dataDir: string,
  input: TurnFeedbackTerminalSuspendReady,
): void {
  const marker = validateSuspendReady(input);
  atomicWriteFileSync(
    join(generationPath(dataDir, marker), SUSPEND_READY),
    JSON.stringify(marker),
    { mode: 0o600, durable: true, followTargetSymlink: false },
  );
}

export function readTurnFeedbackTerminalSuspendReady(
  dataDir: string,
  expected: TurnFeedbackTerminalSuspendReady,
): boolean {
  const marker = validateSuspendReady(expected);
  const path = join(generationPath(dataDir, marker), SUSPEND_READY);
  if (!existsSync(path)) return false;
  const actual = validateSuspendReady(JSON.parse(readSecureFile(path).toString('utf8')));
  return JSON.stringify(actual) === JSON.stringify(marker);
}

export function removeTurnFeedbackTerminalSuspendReady(
  dataDir: string,
  expected: TurnFeedbackTerminalSuspendReady,
): boolean {
  const marker = validateSuspendReady(expected);
  const path = join(generationPath(dataDir, marker), SUSPEND_READY);
  if (!existsSync(path)) return true;
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      fsConstants.O_RDONLY
        | (process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW)
        | fsConstants.O_NONBLOCK,
    );
    const opened = fstatSync(fd);
    const uid = process.getuid?.();
    if (!opened.isFile() || opened.nlink !== 1 || (opened.mode & 0o777) !== 0o600
      || (uid !== undefined && opened.uid !== uid)
      || opened.size <= 0 || opened.size > MAX_RECORD_BYTES) return false;
    const actual = validateSuspendReady(JSON.parse(readFileSync(fd).toString('utf8')));
    if (JSON.stringify(actual) !== JSON.stringify(marker)) return false;
    const current = lstatSync(path);
    if (current.dev !== opened.dev || current.ino !== opened.ino
      || !current.isFile() || current.isSymbolicLink()) return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  unlinkSync(path);
  return true;
}

export interface TurnFeedbackTerminalDelivery {
  publish(
    record: TurnFeedbackTerminalRecord,
    payload?: Extract<WorkerToDaemon, { type: 'turn_terminal' }>,
    onPersisted?: () => void,
  ): void;
  acknowledge(message: Extract<DaemonToWorker, { type: 'turn_terminal_persisted' }>): boolean;
  flush(): void;
  pendingCount(): number;
  allPendingPersisted(): boolean;
  dispose(): void;
}

export function createTurnFeedbackTerminalDelivery(deps: {
  dataDir: string;
  send(message: Extract<WorkerToDaemon, { type: 'turn_terminal' }>): void;
  ipcLive(): boolean;
  now(): number;
  onConflict?(record: TurnFeedbackTerminalRecord): void;
  persist?(record: TurnFeedbackTerminalRecord): void;
}): TurnFeedbackTerminalDelivery {
  const pending = new Map<string, {
    record: TurnFeedbackTerminalRecord;
    payload: Extract<WorkerToDaemon, { type: 'turn_terminal' }>;
    attempt: number;
    persisted: boolean;
    finalized: boolean;
    stopped: boolean;
    onPersisted?: () => void;
    timer?: ReturnType<typeof setTimeout>;
  }>();
  const delays = [2_000, 5_000, 15_000, 30_000];

  const exactAck = (
    record: TurnFeedbackTerminalRecord,
    message: Extract<DaemonToWorker, { type: 'turn_terminal_persisted' }>,
  ): boolean => message.terminalRequestId === record.terminalRequestId
    && message.sessionId === record.sessionId
    && message.turnId === record.turnId
    && message.dispatchAttempt === record.dispatchAttempt
    && message.status === record.status;

  const schedule = (entry: (typeof pending extends Map<string, infer V> ? V : never)): void => {
    if (entry.stopped || entry.timer) return;
    const delay = delays[Math.min(entry.attempt, delays.length - 1)];
    entry.attempt += 1;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (pending.get(entry.record.terminalRequestId) !== entry || entry.stopped) return;
      transmit(entry);
    }, delay);
    entry.timer.unref?.();
  };

  const transmit = (entry: (typeof pending extends Map<string, infer V> ? V : never)): void => {
    if (entry.stopped) return;
    if (!entry.persisted) {
      try {
        (deps.persist ?? ((record: TurnFeedbackTerminalRecord) => {
          writeTurnFeedbackTerminalOutbox(deps.dataDir, record);
        }))(entry.record);
        entry.persisted = true;
        entry.attempt = 0;
      } catch {
        schedule(entry);
        return;
      }
    }
    if (!entry.finalized) {
      try {
        entry.onPersisted?.();
        entry.finalized = true;
      } catch {
        schedule(entry);
        return;
      }
    }
    try {
      if (deps.ipcLive()) deps.send(entry.payload);
    } catch {
      // Durable outbox + timer own retransmission; never crash the worker here.
    } finally {
      schedule(entry);
    }
  };

  return {
    publish(input, payload, onPersisted) {
      const record = validateTurnFeedbackTerminalRecord(input);
      const existing = pending.get(record.terminalRequestId);
      if (existing) {
        if (!sameRecord(existing.record, record)) throw new Error('terminal delivery identity conflict');
        return;
      }
      const message = payload ?? {
        type: 'turn_terminal',
        terminalRequestId: record.terminalRequestId,
        sessionId: record.sessionId,
        turnId: record.turnId,
        status: record.status,
        ...(record.dispatchAttempt !== undefined ? { dispatchAttempt: record.dispatchAttempt } : {}),
        ...(record.completedAtMs !== undefined ? { completedAtMs: record.completedAtMs } : {}),
        ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
      };
      if (message.terminalRequestId !== record.terminalRequestId
        || message.sessionId !== record.sessionId
        || message.turnId !== record.turnId
        || message.dispatchAttempt !== record.dispatchAttempt
        || message.status !== record.status) {
        throw new Error('terminal delivery payload does not match durable record');
      }
      const entry = {
        record, payload: structuredClone(message), attempt: 0, persisted: false,
        finalized: false, stopped: false, onPersisted,
      };
      pending.set(record.terminalRequestId, entry);
      transmit(entry);
    },
    acknowledge(message) {
      const entry = pending.get(message.terminalRequestId);
      if (!entry || !exactAck(entry.record, message)) return false;
      if (message.result === 'retry') return true;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = undefined;
      if (message.result === 'conflict') {
        entry.stopped = true;
        pending.delete(message.terminalRequestId);
        try { quarantineTurnFeedbackTerminalOutbox(deps.dataDir, entry.record, deps.now()); }
        catch { /* conflict is terminal; startup scan will quarantine unsafe residue */ }
        deps.onConflict?.(entry.record);
        return true;
      }
      if (!removeTurnFeedbackTerminalOutbox(deps.dataDir, entry.record)) {
        try {
          if (readTurnFeedbackTerminalOutbox(deps.dataDir, entry.record) !== undefined) {
            entry.attempt = Math.max(0, entry.attempt - 1);
            schedule(entry);
            return false;
          }
        } catch {
          entry.attempt = Math.max(0, entry.attempt - 1);
          schedule(entry);
          return false;
        }
      }
      pending.delete(message.terminalRequestId);
      return true;
    },
    flush() {
      for (const entry of pending.values()) {
        if (!entry.stopped) transmit(entry);
      }
    },
    pendingCount: () => pending.size,
    allPendingPersisted: () => [...pending.values()].every(entry => entry.persisted),
    dispose() {
      for (const entry of pending.values()) if (entry.timer) clearTimeout(entry.timer);
      pending.clear();
    },
  };
}
