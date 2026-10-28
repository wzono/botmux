import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  verifyCapacitySidebandEventV3,
  type CapacitySidebandEventV3,
} from '../src/services/capacity-sideband-consumer.js';

const KEY_PAIR = generateKeyPairSync('ed25519');
const PUBLIC_KEY = KEY_PAIR.publicKey.export({ format: 'der', type: 'spki' });
const KEY_ID = createHash('sha256').update(PUBLIC_KEY).digest('hex');
const AT = '2026-10-28T09:00:00.000Z';

function signed(overrides: Partial<CapacitySidebandEventV3> = {}): CapacitySidebandEventV3 {
  const unsigned = {
    schema_version: 'capacity-wait.v3' as const, adapter: 'codex' as const,
    owner_app_id: 'cli_test', signer_key_id: KEY_ID, signer_epoch: 4,
    native_turn_id: 'native-turn', request_id: 'request-1', state: 'waiting' as const,
    position: 8, observed_at: AT, sequence: 1, ...overrides,
  };
  return {
    ...unsigned,
    signature: sign(null, Buffer.from(JSON.stringify(unsigned)), KEY_PAIR.privateKey).toString('base64url'),
  };
}

describe('capacity-wait.v3 verification', () => {
  const keyring = [{ keyId: KEY_ID, publicKeyDer: PUBLIC_KEY, minEpoch: 3, maxEpoch: 4 }];

  it('accepts an authentic exact-owner event', () => {
    const event = signed();
    expect(verifyCapacitySidebandEventV3(JSON.stringify(event), keyring, Date.parse(AT), 'cli_test'))
      .toEqual(event);
  });

  it.each([
    signed({ owner_app_id: 'cli_other' }),
    signed({ signer_epoch: 5 }),
    signed({ schema_version: 'capacity-wait.v2' as never }),
    { ...signed(), prompt: 'secret' },
    signed({ state: 'clear', position: 8 }),
    signed({ adapter: 'claude-code', native_session_id: undefined }),
  ])('rejects wrong owner, epoch, schema, fields, shape, or native identity', event => {
    expect(verifyCapacitySidebandEventV3(JSON.stringify(event), keyring, Date.parse(AT), 'cli_test'))
      .toBeUndefined();
  });

  it('rejects tampering, stale clocks, and oversized input', () => {
    const event = signed();
    expect(verifyCapacitySidebandEventV3(JSON.stringify({ ...event, position: 9 }), keyring, Date.parse(AT), 'cli_test'))
      .toBeUndefined();
    expect(verifyCapacitySidebandEventV3(JSON.stringify(event), keyring, Date.parse(AT) + 25 * 60 * 60_000, 'cli_test'))
      .toBeUndefined();
    expect(verifyCapacitySidebandEventV3(' '.repeat(16 * 1024 + 1), keyring, Date.parse(AT), 'cli_test'))
      .toBeUndefined();
  });

  it.each(['waiting', 'clear', 'terminal'])('keeps the %s fixture aligned with the wire shape', state => {
    const fixture = JSON.parse(readFileSync(
      join(process.cwd(), `test/fixtures/capacity-sideband/v3-${state}.json`),
      'utf8',
    )) as CapacitySidebandEventV3;
    expect(fixture.schema_version).toBe('capacity-wait.v3');
    expect(fixture.state).toBe(state);
    expect(Object.keys(fixture).every(key => [
      'schema_version', 'adapter', 'owner_app_id', 'signer_key_id', 'signer_epoch',
      'native_session_id', 'native_turn_id', 'request_id', 'queue_id', 'state',
      'position', 'observed_at', 'sequence', 'signature',
    ].includes(key))).toBe(true);
    if (state !== 'waiting') expect(fixture.position).toBeUndefined();
    if (fixture.adapter === 'claude-code') expect(fixture.native_session_id).toBeTruthy();
  });
});
