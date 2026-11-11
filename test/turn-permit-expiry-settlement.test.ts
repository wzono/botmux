import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TurnPermitStore } from '../src/services/turn-permit-store.js';

describe('business permit expiry preserves exact in-flight settlement', () => {
  it.each(['dispatching', 'ambiguous'] as const)('rejects expired execution without destroying %s receipt authority', async phase => {
    const directory = mkdtempSync(join(tmpdir(), 'permit-expiry-settlement-'));
    let now = 1;
    try {
      const store = new TurnPermitStore(directory, { now: () => now });
      const input = { sessionId: 'session', turnId: 'turn', workerGeneration: 7,
        workspace: { path: directory, dev: '1', ino: '2' }, expiresAt: 10 };
      const permit = (await store.issueBusiness(input))!;
      expect(await store.beginBusinessDispatch(permit, 'payload')).toEqual({ status: 'acquired' });
      if (phase === 'ambiguous') expect(await store.reconcileBusinessDispatch(permit, { safeToRetry: false })).toEqual({ status: 'ambiguous' });
      now = 11;
      expect(await store.beginBusinessDispatch(permit, 'payload')).toEqual({ status: 'expired' });
      expect((await store.issueBusiness({ ...input, expiresAt: 20 }))?.permitId).toBe(permit.permitId);
      expect(await store.acknowledgeBusinessDelivery({ sessionId: 'session', turnId: 'turn', workerGeneration: 8 })).toEqual({ status: 'rejected' });
      expect((await store.acknowledgeBusinessDelivery({ sessionId: 'session', turnId: 'turn', workerGeneration: 7 })).status).toBe('delivered');
      const reloaded = new TurnPermitStore(directory, { now: () => now });
      expect((await reloaded.beginBusinessDispatch(permit, 'payload')).status).toBe('delivered');
      expect(await reloaded.beginBusinessDispatch(permit, 'different')).toEqual({ status: 'rejected' });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
