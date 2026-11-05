import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { withFileLockSync } from '../utils/file-lock.js';

export type CapacityAuditInput = {
  episodeId: string;
  adapter: 'traex' | 'codex' | 'claude-code';
  schemaVersion: 'traex-viewport.v1' | 'capacity-wait.v3';
  event: 'waiting' | 'position' | 'clear' | 'terminal' | 'stale';
  observedAt: string;
  positionKnown: boolean;
  visibility: 'none' | 'dashboard' | 'work-card' | 'reaction';
  latencyMs: number;
  signerKeyId?: string;
  signerEpoch?: number;
  verdict: 'accepted' | 'rejected' | 'unsupported' | 'disabled';
};

const EPISODE = /^ep_[0-9a-f]{32}$/;
const KEY_ID = /^[0-9a-f]{64}$/;
const ADAPTERS = new Set(['traex', 'codex', 'claude-code']);
const SCHEMAS = new Set(['traex-viewport.v1', 'capacity-wait.v3']);
const EVENTS = new Set(['waiting', 'position', 'clear', 'terminal', 'stale']);
const VISIBILITY = new Set(['none', 'dashboard', 'work-card', 'reaction']);
const VERDICTS = new Set(['accepted', 'rejected', 'unsupported', 'disabled']);

export function projectCapacityAuditRecord(input: CapacityAuditInput): CapacityAuditInput {
  if (!EPISODE.test(input.episodeId) || !ADAPTERS.has(input.adapter)
    || !SCHEMAS.has(input.schemaVersion) || !EVENTS.has(input.event)
    || !VISIBILITY.has(input.visibility) || !VERDICTS.has(input.verdict)
    || !Number.isFinite(Date.parse(input.observedAt))
    || !Number.isSafeInteger(input.latencyMs) || input.latencyMs < 0
    || typeof input.positionKnown !== 'boolean'
    || input.signerKeyId !== undefined && !KEY_ID.test(input.signerKeyId)
    || input.signerEpoch !== undefined && (!Number.isSafeInteger(input.signerEpoch) || input.signerEpoch < 0)) {
    throw new Error('invalid capacity audit record');
  }
  return structuredClone(input);
}

export function capacityEpisodeId(parts: readonly string[]): string {
  return `ep_${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}`;
}

export function appendCapacityAuditRecord(dataDir: string, input: CapacityAuditInput): void {
  const record = projectCapacityAuditRecord(input);
  const directory = join(dataDir, 'capacity-feedback');
  const path = join(directory, 'audit.jsonl');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  withFileLockSync(path, () => {
    appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(path, 0o600);
  });
}
