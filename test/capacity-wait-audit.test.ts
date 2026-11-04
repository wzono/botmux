import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendCapacityAuditRecord, capacityEpisodeId, projectCapacityAuditRecord } from '../src/services/capacity-wait-audit.js';

describe('capacity privacy audit ledger', () => {
  it('serializes only opaque and enum-shaped evidence', () => {
    const record = projectCapacityAuditRecord({
      episodeId: 'ep_0123456789abcdef0123456789abcdef',
      adapter: 'codex', schemaVersion: 'capacity-wait.v3', event: 'waiting',
      observedAt: '2026-10-28T09:00:00.000Z', positionKnown: true,
      visibility: 'dashboard', latencyMs: 1200, signerKeyId: 'a'.repeat(64), signerEpoch: 4, verdict: 'accepted',
    });
    const serialized = JSON.stringify(record);
    expect(record).toMatchObject({ adapter: 'codex', event: 'waiting', verdict: 'accepted' });
    expect(serialized).not.toMatch(/app|chat|session|turn|message|path|prompt|output|secret|token|credential/i);
  });

  it.each([
    { episodeId: 'raw-session-id', adapter: 'codex', schemaVersion: 'capacity-wait.v3', event: 'waiting', observedAt: '2026-10-28T09:00:00.000Z', positionKnown: false, visibility: 'none', latencyMs: 0, verdict: 'accepted' },
    { episodeId: 'ep_0123456789abcdef0123456789abcdef', adapter: 'other', schemaVersion: 'capacity-wait.v3', event: 'waiting', observedAt: '2026-10-28T09:00:00.000Z', positionKnown: false, visibility: 'none', latencyMs: 0, verdict: 'accepted' },
  ])('rejects non-opaque ids and unknown enums', input => {
    expect(() => projectCapacityAuditRecord(input as any)).toThrow();
  });

  it('appends a mode-0600 JSONL record without raw identity inputs', () => {
    const episodeId = capacityEpisodeId(['cli_app', 'session-a', 'turn-a', '1000']);
    appendCapacityAuditRecord(process.env.SESSION_DATA_DIR!, {
      episodeId, adapter: 'traex', schemaVersion: 'traex-viewport.v1', event: 'waiting',
      observedAt: '2026-10-28T09:00:00.000Z', positionKnown: false, visibility: 'work-card',
      latencyMs: 800, verdict: 'accepted',
    });
    const raw = readFileSync(join(process.env.SESSION_DATA_DIR!, 'capacity-feedback', 'audit.jsonl'), 'utf8');
    expect(raw).toContain(episodeId);
    expect(raw).not.toContain('cli_app');
    expect(raw).not.toContain('session-a');
    expect(raw).not.toContain('turn-a');
  });
});
