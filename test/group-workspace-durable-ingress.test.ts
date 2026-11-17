import { describe, expect, it } from 'vitest';
import { terminalWorkspaceBytesAllowed } from '../src/worker.js';
import { classifyTurn, resumeAdmittedControlReply } from '../src/core/turn-admission.js';
import { TurnPermitStore } from '../src/services/turn-permit-store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workspace = (path = '/old') => ({ path, dev: '1', ino: '2' });

describe('group workspace durable ingress', () => {
  it('fences terminal bytes against the current group revision and directory identity', () => {
    const frozen = { source: 'group' as const, groupRevision: 1, workspaceIdentity: workspace() };
    expect(terminalWorkspaceBytesAllowed(frozen, {
      type: 'terminal_workspace_fence', source: 'group', groupRevision: 1, workspaceIdentity: workspace(),
    })).toBe(true);
    expect(terminalWorkspaceBytesAllowed(frozen, {
      type: 'terminal_workspace_fence', source: 'group', groupRevision: 2, workspaceIdentity: workspace(),
    })).toBe(false);
    expect(terminalWorkspaceBytesAllowed(frozen, {
      type: 'terminal_workspace_fence', source: 'group', groupRevision: 1, workspaceIdentity: workspace('/new'),
    })).toBe(false);
  });

  it('keeps output delivery outside business admission classification', () => {
    expect(classifyTurn({ origin: 'durable_output' })).toBe('output_delivery');
    expect(classifyTurn({ origin: 'terminal_bytes' })).toBe('terminal_bytes');
  });

  it('does not let a duplicate observer release the owner spawning permit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-task9-spawn-owner-'));
    try {
      const store = new TurnPermitStore(dir);
      const permit = await store.issueBlank({ sessionId: 's', turnId: 't', reservedGeneration: 2,
        target: workspace(), expiresAt: Date.now() + 60_000 });
      const owner = await store.beginSpawn(permit);
      expect(owner.status).toBe('acquired');
      expect(await store.releasePreForkFailure(permit, 'duplicate-observer')).toBe(false);
      expect((await store.beginSpawn(permit)).status).toBe('observing');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reissues an expired permit only when no spawn attempt ever owned it', async () => {
    let now = 1;
    const dir = mkdtempSync(join(tmpdir(), 'botmux-task9-expired-'));
    try {
      const store = new TurnPermitStore(dir, { now: () => now });
      const first = await store.issueBlank({ sessionId: 's', turnId: 'expired', reservedGeneration: 2,
        target: workspace(), expiresAt: 2 });
      now = 3;
      expect((await store.beginSpawn(first)).status).toBe('expired');
      const second = await store.issueBlank({ sessionId: 's', turnId: 'expired', reservedGeneration: 2,
        target: workspace(), expiresAt: 100 });
      expect(second.permitId).not.toBe(first.permitId);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('recovers a crashed spawn owner only after reserved generation retirement proof', async () => {
    let now = 1;
    const dir = mkdtempSync(join(tmpdir(), 'botmux-task9-crashed-spawn-'));
    try {
      const store = new TurnPermitStore(dir, { now: () => now });
      const first = await store.issueBlank({ sessionId: 's', turnId: 'crash', reservedGeneration: 4,
        target: workspace(), expiresAt: 2 });
      expect((await store.beginSpawn(first)).status).toBe('acquired');
      now = 3;
      expect((await store.beginSpawn(first)).status).toBe('expired');
      expect(await store.recoverExpiredSpawn(first, { observedGeneration: 3, reservedGenerationRetired: false })).toBe(false);
      expect(await store.recoverExpiredSpawn(first, { observedGeneration: 3, reservedGenerationRetired: true })).toBe(true);
      const second = await store.issueBlank({ sessionId: 's', turnId: 'crash', reservedGeneration: 5,
        target: workspace(), expiresAt: 100 });
      expect(second.permitId).not.toBe(first.permitId);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('persists one exact control reply receipt and makes duplicates observe it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-task9-control-'));
    try {
      const store = new TurnPermitStore(dir);
      const permit = await store.issueControlReply({
        sessionId: 's', originalTurnId: 't', wait: { kind: 'ask', askId: 'a' },
        expectedGeneration: 3, workspace: workspace(), groupRevision: 1, expiresAt: Date.now() + 60_000,
      });
      let sends = 0;
      const run = () => resumeAdmittedControlReply({
        authorizeFresh: async () => true,
        issuePermit: async () => permit,
        beginDispatch: async p => (await store.beginControlReplyDispatch(p, 'digest', {
          sessionId: 's', originalTurnId: 't', wait: { kind: 'ask', askId: 'a' },
          workerGeneration: 3, workspace: workspace(), groupRevision: 1,
          originalState: 'needs_user', authorized: true,
        })).status as 'acquired' | 'observing' | 'delivered' | 'rejected',
        resume: async p => {
          sends++;
          await store.acknowledgeControlReplyByDispatch({
            controlDispatchId: p.controlDispatchId, replyDigest: 'digest', workerGeneration: 3,
          });
          return true;
        },
        abort: async p => { await store.abortControlReplyDispatch(p, 'digest'); },
      });
      expect(await run()).toBe(true);
      expect(await run()).toEqual({ status: 'already_delivered' });
      expect(sends).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects a settled original Ask without a receipt even with frozen needs_user state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-task9-terminal-ask-'));
    try {
      const store = new TurnPermitStore(dir);
      const permit = await store.issueControlReply({ sessionId: 's', originalTurnId: 't',
        wait: { kind: 'ask', askId: 'a' }, expectedGeneration: 3, workspace: workspace(),
        groupRevision: 1, expiresAt: Date.now() + 60_000 });
      expect((await store.beginControlReplyDispatch(permit, 'digest', {
        sessionId: 's', originalTurnId: 't', wait: { kind: 'ask', askId: 'a' },
        workerGeneration: 3, workspace: workspace(), groupRevision: 1,
        originalState: 'terminal', authorized: true,
      })).status).toBe('rejected');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

});
