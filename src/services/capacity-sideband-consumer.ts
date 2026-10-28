import { createPublicKey, verify } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { readProcessStartIdentity } from '../utils/process-identity.js';

export interface CapacitySidebandEventV3 {
  schema_version: 'capacity-wait.v3';
  adapter: 'codex' | 'claude-code';
  owner_app_id: string;
  signer_key_id: string;
  signer_epoch: number;
  native_session_id?: string;
  native_turn_id: string;
  request_id: string;
  queue_id?: string;
  state: 'waiting' | 'clear' | 'terminal';
  position?: number;
  observed_at: string;
  sequence: number;
  signature: string;
}

export interface CapacitySidebandKey {
  keyId: string;
  publicKeyDer: Buffer;
  minEpoch: number;
  maxEpoch: number;
}

const MAX_BYTES = 16 * 1024;
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60_000;
const MAX_PENDING_EVENTS = 512;
const MAX_PENDING_AGE_MS = 24 * 60 * 60_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const ALLOWED = new Set([
  'schema_version', 'adapter', 'owner_app_id', 'signer_key_id', 'signer_epoch',
  'native_session_id', 'native_turn_id', 'request_id', 'queue_id', 'state',
  'position', 'observed_at', 'sequence', 'signature',
]);

function unsigned(event: CapacitySidebandEventV3): Omit<CapacitySidebandEventV3, 'signature'> {
  const { signature: _signature, ...rest } = event;
  return rest;
}

export function verifyCapacitySidebandEventV3(
  raw: string,
  keyring: readonly CapacitySidebandKey[],
  nowMs = Date.now(),
  expectedOwnerAppId?: string,
): CapacitySidebandEventV3 | undefined {
  if (Buffer.byteLength(raw) > MAX_BYTES) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).some(key => !ALLOWED.has(key))) return undefined;
  if (value.schema_version !== 'capacity-wait.v3'
    || value.adapter !== 'codex' && value.adapter !== 'claude-code') return undefined;
  if (typeof value.owner_app_id !== 'string' || !ID.test(value.owner_app_id)
    || expectedOwnerAppId !== undefined && value.owner_app_id !== expectedOwnerAppId) return undefined;
  if (typeof value.signer_key_id !== 'string' || !/^[0-9a-f]{64}$/.test(value.signer_key_id)
    || !Number.isSafeInteger(value.signer_epoch)) return undefined;
  if (value.state !== 'waiting' && value.state !== 'clear' && value.state !== 'terminal') return undefined;
  if (typeof value.native_turn_id !== 'string' || !ID.test(value.native_turn_id)) return undefined;
  if (value.native_session_id !== undefined
    && (typeof value.native_session_id !== 'string' || !ID.test(value.native_session_id))) return undefined;
  if (value.adapter === 'claude-code' && value.native_session_id === undefined) return undefined;
  if (typeof value.request_id !== 'string' || !ID.test(value.request_id)) return undefined;
  if (value.queue_id !== undefined && (typeof value.queue_id !== 'string' || !ID.test(value.queue_id))) return undefined;
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1) return undefined;
  if (value.position !== undefined
    && (!Number.isSafeInteger(value.position) || (value.position as number) < 1)) return undefined;
  if (value.state !== 'waiting' && value.position !== undefined) return undefined;
  if (typeof value.observed_at !== 'string') return undefined;
  const observedAtMs = Date.parse(value.observed_at);
  if (!Number.isFinite(observedAtMs) || Math.abs(nowMs - observedAtMs) > MAX_CLOCK_SKEW_MS) return undefined;
  if (typeof value.signature !== 'string' || !SIGNATURE.test(value.signature)) return undefined;
  const event = value as unknown as CapacitySidebandEventV3;
  const key = keyring.find(candidate => candidate.keyId === event.signer_key_id
    && event.signer_epoch >= candidate.minEpoch && event.signer_epoch <= candidate.maxEpoch);
  if (!key) return undefined;
  try {
    return verify(
      null, Buffer.from(JSON.stringify(unsigned(event))),
      createPublicKey({ key: key.publicKeyDer, format: 'der', type: 'spki' }),
      Buffer.from(event.signature, 'base64url'),
    ) ? event : undefined;
  } catch {
    return undefined;
  }
}

export interface CapacitySidebandResolvedTarget {
  sessionId: string;
  turnId: string;
  dispatchAttempt: number;
  workerGeneration: number;
}

export interface CapacitySidebandDirectoryDeps {
  root: string;
  ownerAppId: string;
  keyring: readonly CapacitySidebandKey[];
  now?(): number;
  resolve(event: CapacitySidebandEventV3): CapacitySidebandResolvedTarget | undefined;
  observe(
    target: CapacitySidebandResolvedTarget,
    observation: { state: 'waiting' | 'clear'; position?: number; observedAtMs: number },
    event: CapacitySidebandEventV3,
  ): void | boolean | Promise<void | boolean>;
  quarantine?(event: { ownerAppId: string; reason: 'invalid' | 'untrusted' }): void | Promise<void>;
}

export function createCapacitySidebandDirectoryConsumer(deps: CapacitySidebandDirectoryDeps) {
  const directory = resolve(deps.root, 'owners', deps.ownerAppId, 'events');
  const checkpointPath = join(directory, '.checkpoint.json');
  let running = false;
  const claimGeneration = readProcessStartIdentity(process.pid)?.replace(/[^A-Za-z0-9._-]/g, '_')
    ?? 'unknown';

  function retryPending(): void {
    if (!existsSync(directory)) return;
    const now = deps.now?.() ?? Date.now();
    const pending = readdirSync(directory)
      .filter(name => name.endsWith('.json.pending'))
      .map(name => {
        const path = join(directory, name);
        return { name, path, mtimeMs: statSync(path).mtimeMs };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));
    for (const [index, entry] of pending.entries()) {
      if (index >= MAX_PENDING_EVENTS || now - entry.mtimeMs > MAX_PENDING_AGE_MS) {
        renameSync(entry.path, `${entry.path}.quarantine-expired`);
        continue;
      }
      renameSync(entry.path, join(directory, entry.name.slice(0, -'.pending'.length)));
    }
    for (const name of readdirSync(directory).filter(name => /\.json\.claim-[0-9]+(?:-[A-Za-z0-9._-]+)?$/.test(name))) {
      const match = /\.claim-([0-9]+)(?:-([A-Za-z0-9._-]+))?$/.exec(name);
      const pid = Number(match?.[1]);
      const generation = match?.[2];
      let live = false;
      if (Number.isSafeInteger(pid) && pid > 1) {
        if (generation && generation !== 'unknown') {
          const current = readProcessStartIdentity(pid);
          live = current === undefined || current.replace(/[^A-Za-z0-9._-]/g, '_') === generation;
        } else {
          try { process.kill(pid, 0); live = true; }
          catch (error) { live = (error as NodeJS.ErrnoException).code === 'EPERM'; }
        }
      }
      if (!live) renameSync(join(directory, name), join(directory, name.replace(/\.claim-[0-9]+(?:-[A-Za-z0-9._-]+)?$/, '')));
    }
  }

  function readCheckpoint(): Record<string, number> {
    if (!existsSync(checkpointPath)) return {};
    try {
      const leaf = lstatSync(checkpointPath);
      const info = statSync(checkpointPath);
      if (leaf.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0) {
        throw new Error('untrusted sideband checkpoint');
      }
      const parsed = JSON.parse(readFileSync(checkpointPath, 'utf8')) as Record<string, unknown>;
      if (Object.values(parsed).some(value => !Number.isSafeInteger(value) || (value as number) < 1)) {
        throw new Error('invalid sideband checkpoint');
      }
      return parsed as Record<string, number>;
    } catch (error) {
      throw new Error(`invalid sideband checkpoint: ${String(error)}`);
    }
  }

  function writeCheckpoint(checkpoint: Record<string, number>): void {
    atomicWriteFileSync(checkpointPath, `${JSON.stringify(checkpoint)}\n`, {
      mode: 0o600, durable: true, followTargetSymlink: false,
    });
  }

  async function poll(): Promise<number> {
    if (running || !existsSync(directory)) return 0;
    const info = statSync(directory);
    const leaf = lstatSync(directory);
    if (leaf.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0) {
      throw new Error('untrusted sideband owner directory');
    }
    running = true;
    let accepted = 0;
    let quarantined = false;
    try {
      const checkpoint = readCheckpoint();
      const names = readdirSync(directory)
        .filter(name => name.endsWith('.json') && name !== '.checkpoint.json')
        .sort();
      for (const name of names) {
        const source = join(directory, name);
        const claimed = `${source}.claim-${process.pid}-${claimGeneration}`;
        try { renameSync(source, claimed); } catch { continue; }
        let fd: number | undefined;
        let raw: string;
        try {
          fd = openSync(claimed, constants.O_RDONLY | constants.O_NOFOLLOW);
          const info = fstatSync(fd);
          if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0
            || typeof process.getuid === 'function' && info.uid !== process.getuid()) {
            throw new Error('untrusted sideband event');
          }
          raw = readFileSync(fd, 'utf8');
        } catch {
          if (fd !== undefined) closeSync(fd);
          renameSync(claimed, `${source}.quarantine-untrusted`);
          quarantined = true;
          await deps.quarantine?.({ ownerAppId: deps.ownerAppId, reason: 'untrusted' });
          break;
        } finally {
          if (fd !== undefined) {
            try { closeSync(fd); } catch { /* already closed */ }
          }
        }
        const event = verifyCapacitySidebandEventV3(
          raw, deps.keyring, deps.now?.() ?? Date.now(), deps.ownerAppId,
        );
        if (!event) {
          let parsedOwner: unknown;
          try { parsedOwner = (JSON.parse(raw) as Record<string, unknown>).owner_app_id; } catch {}
          if (parsedOwner !== undefined && parsedOwner !== deps.ownerAppId) {
            renameSync(claimed, source);
            continue;
          }
          renameSync(claimed, `${source}.quarantine-invalid`);
          quarantined = true;
          await deps.quarantine?.({ ownerAppId: deps.ownerAppId, reason: 'invalid' });
          break;
        }
        const cursorKey = JSON.stringify([
          event.signer_key_id, event.signer_epoch,
        ]);
        if ((checkpoint[cursorKey] ?? 0) >= event.sequence) { unlinkSync(claimed); continue; }
        const target = deps.resolve(event);
        if (!target) { renameSync(claimed, `${source}.pending`); continue; }
        const observation = event.state === 'waiting'
          ? { state: 'waiting' as const, position: event.position, observedAtMs: Date.parse(event.observed_at) }
          : { state: 'clear' as const, observedAtMs: Date.parse(event.observed_at) };
        const observed = await deps.observe(target, observation, event);
        if (observed === false) { renameSync(claimed, `${source}.pending`); continue; }
        checkpoint[cursorKey] = event.sequence;
        writeCheckpoint(checkpoint);
        unlinkSync(claimed);
        accepted += 1;
      }
      return quarantined ? 0 : accepted;
    } finally {
      running = false;
    }
  }

  return {
    directory, checkpointPath, poll,
    retryPending,
    start(intervalMs = 250) {
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
        if (ticks % 20 === 0) retryPending();
        void poll().catch(() => undefined);
      }, intervalMs);
      timer.unref?.();
      void poll().catch(() => undefined);
      return () => clearInterval(timer);
    },
  };
}
