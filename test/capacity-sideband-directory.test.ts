import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createCapacitySidebandDirectoryConsumer,
  type CapacitySidebandEventV3,
} from '../src/services/capacity-sideband-consumer.js';

const KEYS = generateKeyPairSync('ed25519');
const PUBLIC = KEYS.publicKey.export({ format: 'der', type: 'spki' });
const KEY_ID = createHash('sha256').update(PUBLIC).digest('hex');
const AT = '2026-10-28T09:00:00.000Z';

function event(owner = 'cli_test'): CapacitySidebandEventV3 {
  const unsigned = {
    schema_version: 'capacity-wait.v3' as const, adapter: 'codex' as const, owner_app_id: owner,
    signer_key_id: KEY_ID, signer_epoch: 1, native_turn_id: 'native-a', request_id: 'request-a',
    state: 'waiting' as const, position: 4, observed_at: AT, sequence: 1,
  };
  return { ...unsigned, signature: sign(null, Buffer.from(JSON.stringify(unsigned)), KEYS.privateKey).toString('base64url') };
}

function fixture() {
  const root = join(process.env.SESSION_DATA_DIR!, `sideband-dir-${Math.random().toString(36).slice(2)}`);
  const ownerDirectory = join(root, 'owners', 'cli_test', 'events');
  mkdirSync(ownerDirectory, { recursive: true, mode: 0o700 });
  chmodSync(ownerDirectory, 0o700);
  return { root, ownerDirectory };
}

describe('owner directory capacity sideband consumer', () => {
  it('claims only its owner, persists checkpoint after observe, and removes accepted file', async () => {
    const { root, ownerDirectory } = fixture();
    writeFileSync(join(ownerDirectory, '1.json'), JSON.stringify(event()), { mode: 0o600 });
    const observe = vi.fn();
    const consumer = createCapacitySidebandDirectoryConsumer({
      root, ownerAppId: 'cli_test', keyring: [{ keyId: KEY_ID, publicKeyDer: PUBLIC, minEpoch: 1, maxEpoch: 1 }],
      now: () => Date.parse(AT),
      resolve: () => ({ sessionId: 'session-a', turnId: 'turn-a', dispatchAttempt: 2, workerGeneration: 3 }),
      observe,
    });

    await expect(consumer.poll()).resolves.toBe(1);
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: 'turn-a' }),
      expect.objectContaining({ state: 'waiting', position: 4 }),
      expect.objectContaining({ owner_app_id: 'cli_test' }),
    );
    expect(readdirSync(ownerDirectory)).toContain('.checkpoint.json');
    expect(readdirSync(ownerDirectory)).not.toContain('1.json');
  });

  it('does not claim a foreign owner and leaves unmatched valid events pending', async () => {
    const { root, ownerDirectory } = fixture();
    writeFileSync(join(ownerDirectory, 'foreign.json'), JSON.stringify(event('cli_other')), { mode: 0o600 });
    writeFileSync(join(ownerDirectory, 'pending.json'), JSON.stringify(event()), { mode: 0o600 });
    const consumer = createCapacitySidebandDirectoryConsumer({
      root, ownerAppId: 'cli_test', keyring: [{ keyId: KEY_ID, publicKeyDer: PUBLIC, minEpoch: 1, maxEpoch: 1 }],
      now: () => Date.parse(AT), resolve: () => undefined, observe: vi.fn(),
    });

    await expect(consumer.poll()).resolves.toBe(0);
    expect(readdirSync(ownerDirectory)).toEqual(expect.arrayContaining(['foreign.json', 'pending.json.pending']));
  });

  it('quarantines invalid shape without advancing checkpoint', async () => {
    const { root, ownerDirectory } = fixture();
    writeFileSync(join(ownerDirectory, 'bad.json'), '{bad', { mode: 0o600 });
    const consumer = createCapacitySidebandDirectoryConsumer({
      root, ownerAppId: 'cli_test', keyring: [{ keyId: KEY_ID, publicKeyDer: PUBLIC, minEpoch: 1, maxEpoch: 1 }],
      now: () => Date.parse(AT), resolve: () => undefined, observe: vi.fn(),
    });

    await expect(consumer.poll()).resolves.toBe(0);
    expect(readdirSync(ownerDirectory)).toContain('bad.json.quarantine-invalid');
  });

  it('latches the owner adapters off after an untrusted event and stops the poll', async () => {
    const { root, ownerDirectory } = fixture();
    writeFileSync(join(ownerDirectory, '1-bad.json'), '{bad', { mode: 0o600 });
    writeFileSync(join(ownerDirectory, '2-valid.json'), JSON.stringify(event()), { mode: 0o600 });
    const quarantine = vi.fn();
    const observe = vi.fn();
    const consumer = createCapacitySidebandDirectoryConsumer({
      root, ownerAppId: 'cli_test', keyring: [{ keyId: KEY_ID, publicKeyDer: PUBLIC, minEpoch: 1, maxEpoch: 1 }],
      now: () => Date.parse(AT), quarantine,
      resolve: () => ({ sessionId: 'session-a', turnId: 'turn-a', dispatchAttempt: 2, workerGeneration: 3 }),
      observe,
    });

    await expect(consumer.poll()).resolves.toBe(0);
    expect(quarantine).toHaveBeenCalledWith({ ownerAppId: 'cli_test', reason: 'invalid' });
    expect(observe).not.toHaveBeenCalled();
    expect(readdirSync(ownerDirectory)).toContain('2-valid.json');
  });

  it('retries pending events after a binding becomes available', async () => {
    const { root, ownerDirectory } = fixture();
    writeFileSync(join(ownerDirectory, 'pending.json'), JSON.stringify(event()), { mode: 0o600 });
    let bound = false;
    const observe = vi.fn();
    const consumer = createCapacitySidebandDirectoryConsumer({
      root, ownerAppId: 'cli_test', keyring: [{ keyId: KEY_ID, publicKeyDer: PUBLIC, minEpoch: 1, maxEpoch: 1 }],
      now: () => Date.parse(AT),
      resolve: () => bound
        ? { sessionId: 'session-a', turnId: 'turn-a', dispatchAttempt: 2, workerGeneration: 3 }
        : undefined,
      observe,
    });

    await expect(consumer.poll()).resolves.toBe(0);
    bound = true;
    consumer.retryPending();
    await expect(consumer.poll()).resolves.toBe(1);
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it('rejects symlink and group-readable event files before parsing them', async () => {
    const { root, ownerDirectory } = fixture();
    const outside = join(root, 'outside.json');
    writeFileSync(outside, JSON.stringify(event()), { mode: 0o600 });
    symlinkSync(outside, join(ownerDirectory, 'link.json'));
    writeFileSync(join(ownerDirectory, 'wide.json'), JSON.stringify(event()), { mode: 0o640 });
    const observe = vi.fn();
    const consumer = createCapacitySidebandDirectoryConsumer({
      root, ownerAppId: 'cli_test', keyring: [{ keyId: KEY_ID, publicKeyDer: PUBLIC, minEpoch: 1, maxEpoch: 1 }],
      now: () => Date.parse(AT),
      resolve: () => ({ sessionId: 'session-a', turnId: 'turn-a', dispatchAttempt: 2, workerGeneration: 3 }),
      observe,
    });

    await expect(consumer.poll()).resolves.toBe(0);
    expect(observe).not.toHaveBeenCalled();
    expect(readdirSync(ownerDirectory)).toEqual(expect.arrayContaining([
      'link.json.quarantine-untrusted', 'wide.json',
    ]));
  });

  it('uses one global sequence per signer epoch across request ids', async () => {
    const { root, ownerDirectory } = fixture();
    const newer = event(); newer.sequence = 2; newer.request_id = 'request-new';
    const newerUnsigned = { ...newer } as any; delete newerUnsigned.signature;
    newer.signature = sign(null, Buffer.from(JSON.stringify(newerUnsigned)), KEYS.privateKey).toString('base64url');
    const replay = event(); replay.request_id = 'request-replay';
    const replayUnsigned = { ...replay } as any; delete replayUnsigned.signature;
    replay.signature = sign(null, Buffer.from(JSON.stringify(replayUnsigned)), KEYS.privateKey).toString('base64url');
    writeFileSync(join(ownerDirectory, '1-newer.json'), JSON.stringify(newer), { mode: 0o600 });
    writeFileSync(join(ownerDirectory, '2-replay.json'), JSON.stringify(replay), { mode: 0o600 });
    const observe = vi.fn();
    const consumer = createCapacitySidebandDirectoryConsumer({
      root, ownerAppId: 'cli_test', keyring: [{ keyId: KEY_ID, publicKeyDer: PUBLIC, minEpoch: 1, maxEpoch: 1 }],
      now: () => Date.parse(AT),
      resolve: () => ({ sessionId: 'session-a', turnId: 'turn-a', dispatchAttempt: 2, workerGeneration: 3 }),
      observe,
    });

    await expect(consumer.poll()).resolves.toBe(1);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith(expect.anything(), expect.anything(),
      expect.objectContaining({ request_id: 'request-new' }));
  });

  it('recovers a claimed event left by a crashed consumer before polling', async () => {
    const { root, ownerDirectory } = fixture();
    writeFileSync(join(ownerDirectory, 'recovery.json.claim-12345'), JSON.stringify(event()), { mode: 0o600 });
    const observe = vi.fn();
    const consumer = createCapacitySidebandDirectoryConsumer({
      root, ownerAppId: 'cli_test', keyring: [{ keyId: KEY_ID, publicKeyDer: PUBLIC, minEpoch: 1, maxEpoch: 1 }],
      now: () => Date.parse(AT),
      resolve: () => ({ sessionId: 'session-a', turnId: 'turn-a', dispatchAttempt: 2, workerGeneration: 3 }),
      observe,
    });

    consumer.retryPending();
    await expect(consumer.poll()).resolves.toBe(1);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(readdirSync(ownerDirectory).some(name => name.includes('.claim-'))).toBe(false);
  });

  it('does not recover a claim owned by a live process', async () => {
    const { root, ownerDirectory } = fixture();
    writeFileSync(join(ownerDirectory, `live.json.claim-${process.pid}`), JSON.stringify(event()), { mode: 0o600 });
    const observe = vi.fn();
    const consumer = createCapacitySidebandDirectoryConsumer({
      root, ownerAppId: 'cli_test', keyring: [{ keyId: KEY_ID, publicKeyDer: PUBLIC, minEpoch: 1, maxEpoch: 1 }],
      now: () => Date.parse(AT),
      resolve: () => ({ sessionId: 'session-a', turnId: 'turn-a', dispatchAttempt: 2, workerGeneration: 3 }),
      observe,
    });

    consumer.retryPending();
    await expect(consumer.poll()).resolves.toBe(0);
    expect(observe).not.toHaveBeenCalled();
    expect(readdirSync(ownerDirectory)).toContain(`live.json.claim-${process.pid}`);
  });

  it('ignores checkpoint metadata on subsequent empty polls', async () => {
    const { root, ownerDirectory } = fixture();
    writeFileSync(join(ownerDirectory, '1.json'), JSON.stringify(event()), { mode: 0o600 });
    const consumer = createCapacitySidebandDirectoryConsumer({
      root, ownerAppId: 'cli_test', keyring: [{ keyId: KEY_ID, publicKeyDer: PUBLIC, minEpoch: 1, maxEpoch: 1 }],
      now: () => Date.parse(AT),
      resolve: () => ({ sessionId: 'session-a', turnId: 'turn-a', dispatchAttempt: 2, workerGeneration: 3 }),
      observe: vi.fn(),
    });
    await expect(consumer.poll()).resolves.toBe(1);
    await expect(consumer.poll()).resolves.toBe(0);
    expect(readdirSync(ownerDirectory)).toEqual(['.checkpoint.json']);
  });

  it('atomically claims an event so two consumers deliver it once', async () => {
    const { root, ownerDirectory } = fixture();
    writeFileSync(join(ownerDirectory, 'race.json'), JSON.stringify(event()), { mode: 0o600 });
    const observe = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    const make = () => createCapacitySidebandDirectoryConsumer({
      root, ownerAppId: 'cli_test', keyring: [{ keyId: KEY_ID, publicKeyDer: PUBLIC, minEpoch: 1, maxEpoch: 1 }],
      now: () => Date.parse(AT),
      resolve: () => ({ sessionId: 'session-a', turnId: 'turn-a', dispatchAttempt: 2, workerGeneration: 3 }),
      observe,
    });

    await Promise.allSettled([make().poll(), make().poll()]);
    expect(observe).toHaveBeenCalledTimes(1);
  });
});
