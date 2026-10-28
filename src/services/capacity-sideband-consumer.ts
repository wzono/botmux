import { createPublicKey, verify } from 'node:crypto';

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
