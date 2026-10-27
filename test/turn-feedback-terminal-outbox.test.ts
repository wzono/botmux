import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createTurnFeedbackTerminalDelivery,
  createTurnFeedbackSuspendWriteFence,
  __testOnly_setTerminalCapacityProcessIdentityReader,
  listTurnFeedbackTerminalOutbox,
  readTurnFeedbackTerminalRequest,
  readTurnFeedbackTerminalOutbox,
  removeTurnFeedbackTerminalOutbox,
  validateTurnFeedbackTerminalRecord,
  writeTurnFeedbackTerminalOutbox,
  type TurnFeedbackTerminalRecord,
} from '../src/services/turn-feedback-terminal-outbox.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

const NOW = 1_800_000_000_000;

function record(patch: Partial<TurnFeedbackTerminalRecord> = {}): TurnFeedbackTerminalRecord {
  return {
    version: 1,
    terminalRequestId: '11111111-1111-4111-8111-111111111111',
    ownerAppId: 'app-a',
    sessionId: 'session-a',
    turnId: 'turn:a',
    dispatchAttempt: 2,
    workerGeneration: 3,
    status: 'completed',
    completedAtMs: NOW - 10,
    durationMs: 10,
    savedAtMs: NOW,
    ...patch,
  };
}

describe('turn feedback terminal outbox', () => {
  it('defers terminal writes during suspend prepare, then replays or discards them explicitly', () => {
    const fence = createTurnFeedbackSuspendWriteFence();
    const writes: string[] = [];

    expect(fence.submit(() => writes.push('active'))).toBe('written');
    fence.prepare();
    expect(fence.submit(() => writes.push('first'))).toBe('deferred');
    expect(fence.submit(() => writes.push('second'))).toBe('deferred');
    expect(writes).toEqual(['active']);
    expect(fence.pendingCount()).toBe(2);

    fence.resume();
    expect(writes).toEqual(['active', 'first', 'second']);
    fence.prepare();
    fence.commit();
    expect(fence.submit(() => writes.push('rejected'))).toBe('rejected');
    fence.discard();
    expect(writes).toEqual(['active', 'first', 'second']);
    expect(fence.pendingCount()).toBe(0);
  });

  it('fences the full asynchronous terminal write transaction', async () => {
    const fence = createTurnFeedbackSuspendWriteFence();
    const writes: string[] = [];
    fence.prepare();
    const deferred = fence.submitAsync(async () => {
      await Promise.resolve();
      writes.push('replayed');
    });
    expect(fence.pendingCount()).toBe(1);
    expect(writes).toEqual([]);
    fence.resume();
    await expect(deferred).resolves.toBe('deferred');
    expect(writes).toEqual(['replayed']);

    fence.prepare();
    fence.commit();
    await expect(fence.submitAsync(async () => { writes.push('rejected'); }))
      .resolves.toBe('rejected');
    expect(writes).toEqual(['replayed']);
  });

  it('replays mixed async and sync terminal writes in one global FIFO', async () => {
    const fence = createTurnFeedbackSuspendWriteFence();
    const writes: string[] = [];
    fence.prepare();
    const first = fence.submitAsync(async () => {
      writes.push('async-start');
      await Promise.resolve();
      writes.push('async-end');
    });
    expect(fence.submit(() => writes.push('sync-second'))).toBe('deferred');

    fence.resume();
    await expect(first).resolves.toBe('deferred');
    await vi.waitFor(() => expect(writes).toEqual([
      'async-start', 'async-end', 'sync-second',
    ]));
  });

  it('keeps writes arriving during async replay behind the draining queue', async () => {
    const fence = createTurnFeedbackSuspendWriteFence();
    const writes: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    fence.prepare();
    const first = fence.submitAsync(async () => {
      writes.push('first-start');
      await firstGate;
      writes.push('first-end');
    });
    expect(fence.submit(() => writes.push('second-old'))).toBe('deferred');

    fence.resume();
    await vi.waitFor(() => expect(writes).toEqual(['first-start']));
    expect(fence.submit(() => writes.push('third-new'))).toBe('deferred');
    expect(writes).toEqual(['first-start']);
    releaseFirst();
    await expect(first).resolves.toBe('deferred');
    await vi.waitFor(() => expect(writes).toEqual([
      'first-start', 'first-end', 'second-old', 'third-new',
    ]));
  });

  it('keeps one drain owner across a reentrant prepare and resume', async () => {
    const fence = createTurnFeedbackSuspendWriteFence();
    const writes: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    fence.prepare();
    const first = fence.submitAsync(async () => {
      writes.push('first-start');
      await firstGate;
      writes.push('first-end');
    });
    expect(fence.submit(() => writes.push('second-old'))).toBe('deferred');
    fence.resume();
    await vi.waitFor(() => expect(writes).toEqual(['first-start']));

    fence.prepare();
    fence.resume();
    expect(writes).toEqual(['first-start']);
    releaseFirst();
    await expect(first).resolves.toBe('deferred');
    await vi.waitFor(() => expect(writes).toEqual([
      'first-start', 'first-end', 'second-old',
    ]));
  });

  it('reports a deferred sync write failure and continues the FIFO', () => {
    const errors: unknown[] = [];
    const fence = createTurnFeedbackSuspendWriteFence(error => errors.push(error));
    const writes: string[] = [];
    fence.prepare();
    fence.submit(() => { throw new Error('detached backend'); });
    fence.submit(() => writes.push('continued'));

    expect(() => fence.resume()).not.toThrow();
    expect(errors).toEqual([expect.objectContaining({ message: 'detached backend' })]);
    expect(writes).toEqual(['continued']);
  });

  it('writes crash-durable 0600 privacy-minimized records and removes only an exact match', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-terminal-outbox-'));
    const value = record();

    const path = writeTurnFeedbackTerminalOutbox(dataDir, value);

    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(value);
    expect(readTurnFeedbackTerminalOutbox(dataDir, value)).toEqual(value);
    expect(JSON.stringify(value)).not.toMatch(/prompt|output|messageId|chatId|model|error|secret|credential/i);
    expect(removeTurnFeedbackTerminalOutbox(dataDir, { ...value, status: 'failed' })).toBe(false);
    expect(removeTurnFeedbackTerminalOutbox(dataDir, value)).toBe(true);
    expect(readTurnFeedbackTerminalOutbox(dataDir, value)).toBeUndefined();
  });

  it.each([
    { unknown: true },
    { terminalRequestId: '../escape' },
    { ownerAppId: '../app' },
    { sessionId: 'a'.repeat(129) },
    { turnId: '' },
    { workerGeneration: -1 },
    { dispatchAttempt: -1 },
    { completedAtMs: -1 },
    { durationMs: -1 },
    { savedAtMs: Number.NaN },
    { status: 'other' },
    { prompt: 'private text' },
  ])('rejects malformed or privacy-expanding record %j', patch => {
    expect(() => validateTurnFeedbackTerminalRecord({ ...record(), ...patch }))
      .toThrow();
  });

  it('rejects oversized records and symlink leaves/directories without following them', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-terminal-outbox-'));
    expect(() => validateTurnFeedbackTerminalRecord(record({ turnId: 't'.repeat(4096) })))
      .toThrow();
    const value = record();
    const path = writeTurnFeedbackTerminalOutbox(dataDir, value);
    removeTurnFeedbackTerminalOutbox(dataDir, value);
    symlinkSync('/tmp', path);
    expect(() => writeTurnFeedbackTerminalOutbox(dataDir, value)).toThrow(/symlink/i);

    const otherDir = mkdtempSync(join(tmpdir(), 'botmux-terminal-outbox-target-'));
    const appDir = join(dataDir, 'turn-feedback-terminal-outbox', 'evil-app');
    mkdirSync(join(dataDir, 'turn-feedback-terminal-outbox'), { recursive: true });
    symlinkSync(otherDir, appDir);
    expect(() => writeTurnFeedbackTerminalOutbox(dataDir, record({ ownerAppId: 'evil-app' })))
      .toThrow(/symlink/i);
  });

  it('quarantines malformed, unsafe-mode, and expired files while returning valid records', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-terminal-outbox-'));
    const current = record();
    const malformed = record({ terminalRequestId: '22222222-2222-4222-8222-222222222222' });
    const unsafe = record({ terminalRequestId: '33333333-3333-4333-8333-333333333333' });
    const expired = record({
      terminalRequestId: '44444444-4444-4444-8444-444444444444',
      savedAtMs: NOW - 31 * 86_400_000,
    });
    writeTurnFeedbackTerminalOutbox(dataDir, current);
    const malformedPath = writeTurnFeedbackTerminalOutbox(dataDir, malformed);
    writeFileSync(malformedPath, '{broken', { mode: 0o600 });
    const unsafePath = writeTurnFeedbackTerminalOutbox(dataDir, unsafe);
    chmodSync(unsafePath, 0o644);
    writeTurnFeedbackTerminalOutbox(dataDir, expired);

    const listed = listTurnFeedbackTerminalOutbox(dataDir, 'app-a', NOW);

    expect(listed.records.map(item => item.record.terminalRequestId)).toEqual([current.terminalRequestId]);
    expect(listed.quarantined).toHaveLength(3);
  });

  it('binds record identity to its directory and filename', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-terminal-outbox-'));
    const value = record();
    const path = writeTurnFeedbackTerminalOutbox(dataDir, value);
    writeFileSync(path, JSON.stringify({ ...value, sessionId: 'different-session' }), { mode: 0o600 });

    const listed = listTurnFeedbackTerminalOutbox(dataDir, 'app-a', NOW);

    expect(listed.records).toEqual([]);
    expect(listed.quarantined).toHaveLength(1);
  });

  it('reads an exact request identity and rejects any tuple mismatch', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-terminal-outbox-'));
    const value = record();
    writeTurnFeedbackTerminalOutbox(dataDir, value);
    expect(readTurnFeedbackTerminalRequest(dataDir, {
      ownerAppId: value.ownerAppId, sessionId: value.sessionId,
      workerGeneration: value.workerGeneration, terminalRequestId: value.terminalRequestId,
    })).toEqual(value);
    expect(readTurnFeedbackTerminalRequest(dataDir, {
      ownerAppId: value.ownerAppId, sessionId: value.sessionId,
      workerGeneration: value.workerGeneration + 1, terminalRequestId: value.terminalRequestId,
    })).toBeUndefined();
  });

  it('bounds quarantine evidence by count', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-terminal-outbox-'));
    const value = record();
    writeTurnFeedbackTerminalOutbox(dataDir, value);
    const quarantine = join(dataDir, 'turn-feedback-terminal-outbox', 'quarantine');
    mkdirSync(quarantine, { mode: 0o700 });
    for (let index = 0; index < 270; index += 1) {
      writeFileSync(
        join(quarantine, `bad.${NOW}.${index.toString(16).padStart(8, '0')}.quarantine`),
        'bad', { mode: 0o600 },
      );
    }
    mkdirSync(join(quarantine, `old.${NOW - 31 * 86_400_000}.aaaaaaaa.quarantine`));

    listTurnFeedbackTerminalOutbox(dataDir, 'app-a', NOW);

    expect(readdirSync(quarantine)).toHaveLength(256);
  });

  it('caps valid pending records without evicting any existing uncommitted record', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-terminal-outbox-'));
    for (let index = 0; index < 512; index += 1) {
      const suffix = index.toString(16).padStart(12, '0');
      writeTurnFeedbackTerminalOutbox(dataDir, record({
        terminalRequestId: `11111111-1111-4111-8111-${suffix}`,
        turnId: `turn-${index}`,
      }));
    }
    expect(() => writeTurnFeedbackTerminalOutbox(dataDir, record({
      terminalRequestId: '99999999-9999-4999-8999-999999999999',
    }))).toThrow(/capacity/i);
    expect(listTurnFeedbackTerminalOutbox(dataDir, 'app-a', NOW).records).toHaveLength(512);
  });

  it('a capacity write failure sends nothing and autonomously retries after capacity is released', async () => {
    vi.useFakeTimers();
    try {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-terminal-outbox-'));
    for (let index = 0; index < 512; index += 1) {
      const suffix = index.toString(16).padStart(12, '0');
      writeTurnFeedbackTerminalOutbox(dataDir, record({
        terminalRequestId: `11111111-1111-4111-8111-${suffix}`, turnId: `turn-${index}`,
      }));
    }
    const sent: WorkerToDaemon[] = [];
    const delivery = createTurnFeedbackTerminalDelivery({
      dataDir, send: message => sent.push(message), ipcLive: () => true, now: () => NOW,
    });
    const pending = record({ terminalRequestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' });

    delivery.publish(pending);
    expect(delivery.pendingCount()).toBe(1);
    expect(sent).toEqual([]);
    const first = listTurnFeedbackTerminalOutbox(dataDir, 'app-a', NOW).records[0].record;
    expect(removeTurnFeedbackTerminalOutbox(dataDir, first)).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toHaveLength(1);
    expect(delivery.pendingCount()).toBe(1);
    delivery.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resends one immutable payload until an exact committed ACK removes its outbox', async () => {
    vi.useFakeTimers();
    try {
      const dataDir = mkdtempSync(join(tmpdir(), 'botmux-terminal-outbox-'));
      const sent: WorkerToDaemon[] = [];
      const delivery = createTurnFeedbackTerminalDelivery({
        dataDir,
        send: message => sent.push(structuredClone(message)),
        ipcLive: () => true,
        now: () => NOW,
      });
      const value = record();

      delivery.publish(value);
      expect(sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2_000 + 5_000 + 15_000 + 30_000);
      expect(sent).toHaveLength(5);
      expect(sent.every(message => JSON.stringify(message) === JSON.stringify(sent[0]))).toBe(true);
      expect(delivery.pendingCount()).toBe(1);

      const terminal = sent[0] as Extract<WorkerToDaemon, { type: 'turn_terminal' }>;
      const wrong: DaemonToWorker = {
        type: 'turn_terminal_persisted', terminalRequestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        sessionId: value.sessionId, turnId: value.turnId, dispatchAttempt: value.dispatchAttempt,
        status: value.status, result: 'committed',
      };
      expect(delivery.acknowledge(wrong)).toBe(false);
      expect(delivery.pendingCount()).toBe(1);
      expect(delivery.acknowledge({
        type: 'turn_terminal_persisted', terminalRequestId: value.terminalRequestId,
        sessionId: value.sessionId, turnId: value.turnId, dispatchAttempt: value.dispatchAttempt,
        status: value.status, result: 'committed',
      })).toBe(true);
      expect(delivery.pendingCount()).toBe(0);
      expect(readTurnFeedbackTerminalOutbox(dataDir, value)).toBeUndefined();
      expect(terminal.terminalRequestId).toBe(value.terminalRequestId);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retry/lost ACK retain and resend, conflict stops resend but preserves evidence', async () => {
    vi.useFakeTimers();
    try {
      const dataDir = mkdtempSync(join(tmpdir(), 'botmux-terminal-outbox-'));
      const sent: WorkerToDaemon[] = [];
      const delivery = createTurnFeedbackTerminalDelivery({
        dataDir, send: message => sent.push(message), ipcLive: () => true, now: () => NOW,
      });
      const retrying = record();
      delivery.publish(retrying);
      delivery.acknowledge({
        type: 'turn_terminal_persisted', terminalRequestId: retrying.terminalRequestId,
        sessionId: retrying.sessionId, turnId: retrying.turnId,
        dispatchAttempt: retrying.dispatchAttempt, status: retrying.status, result: 'retry',
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(sent).toHaveLength(2);
      const conflicting = record({
        terminalRequestId: '22222222-2222-4222-8222-222222222222', turnId: 'turn:b',
      });
      delivery.publish(conflicting);
      expect(delivery.acknowledge({
        type: 'turn_terminal_persisted', terminalRequestId: conflicting.terminalRequestId,
        sessionId: conflicting.sessionId, turnId: conflicting.turnId,
        dispatchAttempt: conflicting.dispatchAttempt, status: conflicting.status, result: 'conflict',
      })).toBe(true);
      const conflictCalls = () => sent.filter(message =>
        message.type === 'turn_terminal' && message.turnId === conflicting.turnId).length;
      expect(conflictCalls()).toBe(1);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(conflictCalls()).toBe(1);
      expect(sent.filter(message => message.type === 'turn_terminal'
        && message.turnId === retrying.turnId).length).toBeGreaterThan(2);
      expect(readTurnFeedbackTerminalOutbox(dataDir, conflicting)).toBeUndefined();
      expect(readdirSync(join(dataDir, 'turn-feedback-terminal-outbox', 'quarantine')))
        .toHaveLength(1);
      expect(delivery.pendingCount()).toBe(1);
      delivery.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('513 conflicts move evidence into bounded quarantine without exhausting active capacity', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-terminal-outbox-'));
    const delivery = createTurnFeedbackTerminalDelivery({
      dataDir, send: () => undefined, ipcLive: () => true, now: () => NOW,
    });
    for (let index = 0; index < 513; index += 1) {
      const suffix = index.toString(16).padStart(12, '0');
      const value = record({
        terminalRequestId: `dddddddd-dddd-4ddd-8ddd-${suffix}`, turnId: `conflict-${index}`,
      });
      delivery.publish(value);
      expect(delivery.acknowledge({
        type: 'turn_terminal_persisted', terminalRequestId: value.terminalRequestId,
        sessionId: value.sessionId, turnId: value.turnId, dispatchAttempt: value.dispatchAttempt,
        status: value.status, result: 'conflict',
      })).toBe(true);
    }
    expect(listTurnFeedbackTerminalOutbox(dataDir, 'app-a', NOW).records).toHaveLength(0);
    expect(readdirSync(join(dataDir, 'turn-feedback-terminal-outbox', 'quarantine')))
      .toHaveLength(256);
    delivery.dispose();
  });

  it('keeps durable evidence when IPC is unavailable and resumes when flushed', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-terminal-outbox-'));
    const sent: WorkerToDaemon[] = [];
    let live = false;
    const delivery = createTurnFeedbackTerminalDelivery({
      dataDir, send: message => sent.push(message), ipcLive: () => live, now: () => NOW,
    });
    const value = record();
    delivery.publish(value);
    expect(sent).toEqual([]);
    expect(readTurnFeedbackTerminalOutbox(dataDir, value)).toEqual(value);
    live = true;
    delivery.flush();
    expect(sent).toHaveLength(1);
    delivery.dispose();
  });

  it('flush never sends before durable persistence succeeds', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-terminal-outbox-'));
    const sent: WorkerToDaemon[] = [];
    const delivery = createTurnFeedbackTerminalDelivery({
      dataDir, send: message => sent.push(message), ipcLive: () => true, now: () => NOW,
      persist: () => { throw new Error('disk unavailable'); },
    });
    delivery.publish(record());
    delivery.flush();
    expect(sent).toEqual([]);
    delivery.dispose();
  });

  it('retries post-persist finalization before sending any IPC', async () => {
    vi.useFakeTimers();
    try {
      const dataDir = mkdtempSync(join(tmpdir(), 'botmux-terminal-outbox-'));
      const sent: WorkerToDaemon[] = [];
      let finalizations = 0;
      const delivery = createTurnFeedbackTerminalDelivery({
        dataDir, send: message => sent.push(message), ipcLive: () => true, now: () => NOW,
      });
      delivery.publish(record(), undefined, () => {
        finalizations += 1;
        if (finalizations === 1) throw new Error('finalization interrupted');
      });
      expect(sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(finalizations).toBe(2);
      expect(sent).toHaveLength(1);
      delivery.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('autonomously retries an EIO durable write and finalizes only after the file exists', async () => {
    vi.useFakeTimers();
    try {
      const dataDir = mkdtempSync(join(tmpdir(), 'botmux-terminal-outbox-'));
      const sent: WorkerToDaemon[] = [];
      let attempts = 0;
      let finalized = 0;
      const delivery = createTurnFeedbackTerminalDelivery({
        dataDir, send: message => sent.push(message), ipcLive: () => true, now: () => NOW,
        persist: value => {
          attempts += 1;
          if (attempts === 1) throw Object.assign(new Error('disk EIO'), { code: 'EIO' });
          writeTurnFeedbackTerminalOutbox(dataDir, value);
        },
      });
      const value = record();

      delivery.publish(value, undefined, () => { finalized += 1; });
      expect(sent).toEqual([]);
      expect(finalized).toBe(0);
      expect(readTurnFeedbackTerminalOutbox(dataDir, value)).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(readTurnFeedbackTerminalOutbox(dataDir, value)).toEqual(value);
      expect(sent).toHaveLength(1);
      expect(finalized).toBe(1);
      delivery.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('swallows synchronous IPC send failure and lets the timer resend', async () => {
    vi.useFakeTimers();
    try {
      const dataDir = mkdtempSync(join(tmpdir(), 'botmux-terminal-outbox-'));
      let calls = 0;
      const delivery = createTurnFeedbackTerminalDelivery({
        dataDir, ipcLive: () => true, now: () => NOW,
        send: () => { calls += 1; if (calls === 1) throw new Error('IPC write failed'); },
      });
      const value = record();
      expect(() => delivery.publish(value)).not.toThrow();
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(calls).toBe(2);
      delivery.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes concurrent capacity reservations across worker processes', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-terminal-outbox-'));
    for (let index = 0; index < 511; index += 1) {
      const suffix = index.toString(16).padStart(12, '0');
      writeTurnFeedbackTerminalOutbox(dataDir, record({
        terminalRequestId: `bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`, turnId: `seed-${index}`,
      }));
    }
    const source = (requestId: string, turnId: string) => `
      import { writeTurnFeedbackTerminalOutbox } from './src/services/turn-feedback-terminal-outbox.js';
      const value = ${JSON.stringify(record({ terminalRequestId: requestId, turnId }))};
      try { writeTurnFeedbackTerminalOutbox(${JSON.stringify(dataDir)}, value); process.stdout.write('ok'); }
      catch (error) { process.stdout.write(String(error).includes('capacity') ? 'capacity' : 'other'); }
    `;
    const children = [
      spawnTsEvalWithRepoImports(source('cccccccc-cccc-4ccc-8ccc-000000000001', 'race-1'), { cwd: process.cwd() }),
      spawnTsEvalWithRepoImports(source('cccccccc-cccc-4ccc-8ccc-000000000002', 'race-2'), { cwd: process.cwd() }),
    ];
    const outputs = await Promise.all(children.map(child => new Promise<string>((resolve, reject) => {
      let output = '';
      child.stdout?.on('data', chunk => { output += String(chunk); });
      child.on('error', reject);
      child.on('exit', () => resolve(output));
    })));

    expect(outputs.sort()).toEqual(['capacity', 'ok']);
    expect(listTurnFeedbackTerminalOutbox(dataDir, 'app-a', NOW).records).toHaveLength(512);
  });

  it('recovers a capacity lock left by a dead worker', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-terminal-outbox-'));
    const first = record();
    writeTurnFeedbackTerminalOutbox(dataDir, first);
    expect(removeTurnFeedbackTerminalOutbox(dataDir, first)).toBe(true);
    const appDir = join(dataDir, 'turn-feedback-terminal-outbox', 'app-a');
    writeFileSync(join(appDir, '.capacity.lock'), JSON.stringify({
      pid: process.pid, processStart: 'reused-pid-start', createdAtMs: NOW,
    }), { mode: 0o600 });
    const next = record({ terminalRequestId: 'abababab-abab-4bab-8bab-abababababab' });
    expect(writeTurnFeedbackTerminalOutbox(dataDir, next)).toContain(next.terminalRequestId);
    expect(readTurnFeedbackTerminalOutbox(dataDir, next)).toEqual(next);
  });

  it('never steals a stale malformed capacity lock because its creator may still resume', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-terminal-outbox-'));
    const first = record();
    writeTurnFeedbackTerminalOutbox(dataDir, first);
    expect(removeTurnFeedbackTerminalOutbox(dataDir, first)).toBe(true);
    const lock = join(dataDir, 'turn-feedback-terminal-outbox', 'app-a', '.capacity.lock');
    writeFileSync(lock, '', { mode: 0o600 });
    const old = new Date(Date.now() - 6_000);
    utimesSync(lock, old, old);
    const next = record({ terminalRequestId: 'adadadad-adad-4dad-8dad-adadadadadad' });
    expect(() => writeTurnFeedbackTerminalOutbox(dataDir, next)).toThrow(/lock unavailable/i);
    expect(lstatSync(lock).isFile()).toBe(true);
  });

  it('does not steal an old lock from a live PID when process identity is absent', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-terminal-outbox-'));
    const first = record();
    writeTurnFeedbackTerminalOutbox(dataDir, first);
    expect(removeTurnFeedbackTerminalOutbox(dataDir, first)).toBe(true);
    const lock = join(dataDir, 'turn-feedback-terminal-outbox', 'app-a', '.capacity.lock');
    writeFileSync(lock, JSON.stringify({
      version: 1, pid: process.pid, createdAtMs: Date.now() - 60_000,
    }), { mode: 0o600 });
    expect(() => writeTurnFeedbackTerminalOutbox(dataDir, record({
      terminalRequestId: 'dededede-dede-4ded-8ded-dededededede',
    }))).toThrow(/lock unavailable/i);
    expect(lstatSync(lock).isFile()).toBe(true);
  });

  it('does not steal a live-PID lock when its current process identity is unreadable', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-terminal-outbox-'));
    const first = record();
    writeTurnFeedbackTerminalOutbox(dataDir, first);
    expect(removeTurnFeedbackTerminalOutbox(dataDir, first)).toBe(true);
    const lock = join(dataDir, 'turn-feedback-terminal-outbox', 'app-a', '.capacity.lock');
    writeFileSync(lock, JSON.stringify({
      version: 1, pid: process.pid, processStart: 'recorded-start', createdAtMs: NOW,
    }), { mode: 0o600 });
    __testOnly_setTerminalCapacityProcessIdentityReader(() => undefined);
    try {
      expect(() => writeTurnFeedbackTerminalOutbox(dataDir, record({
        terminalRequestId: 'dfdfdfdf-dfdf-4fdf-8fdf-dfdfdfdfdfdf',
      }))).toThrow(/lock unavailable/i);
      expect(lstatSync(lock).isFile()).toBe(true);
    } finally {
      __testOnly_setTerminalCapacityProcessIdentityReader();
    }
  });

  it('can hold and clean up its own lock when process identity is unavailable', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-terminal-outbox-'));
    const value = record({ terminalRequestId: 'edededed-eded-4ede-8ede-edededededed' });
    __testOnly_setTerminalCapacityProcessIdentityReader(() => undefined);
    try {
      expect(writeTurnFeedbackTerminalOutbox(dataDir, value)).toContain(value.terminalRequestId);
      expect(readTurnFeedbackTerminalOutbox(dataDir, value)).toEqual(value);
    } finally {
      __testOnly_setTerminalCapacityProcessIdentityReader();
    }
  });

  it('does not remove a fresh empty capacity lock', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-terminal-outbox-'));
    const first = record();
    writeTurnFeedbackTerminalOutbox(dataDir, first);
    expect(removeTurnFeedbackTerminalOutbox(dataDir, first)).toBe(true);
    const lock = join(dataDir, 'turn-feedback-terminal-outbox', 'app-a', '.capacity.lock');
    writeFileSync(lock, '', { mode: 0o600 });
    expect(() => writeTurnFeedbackTerminalOutbox(dataDir, record({
      terminalRequestId: 'aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae',
    }))).toThrow(/lock unavailable/i);
    expect(lstatSync(lock).isFile()).toBe(true);
  });

  it('never follows a symlink capacity lock or touches its target', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-terminal-outbox-'));
    const first = record();
    writeTurnFeedbackTerminalOutbox(dataDir, first);
    expect(removeTurnFeedbackTerminalOutbox(dataDir, first)).toBe(true);
    const lock = join(dataDir, 'turn-feedback-terminal-outbox', 'app-a', '.capacity.lock');
    const outside = join(mkdtempSync(join(tmpdir(), 'botmux-lock-target-')), 'target');
    writeFileSync(outside, 'outside');
    symlinkSync(outside, lock);
    expect(() => writeTurnFeedbackTerminalOutbox(dataDir, record({
      terminalRequestId: 'bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc',
    }))).toThrow(/unsafe/i);
    expect(readFileSync(outside, 'utf8')).toBe('outside');
  });

  it('malformed-lock handling never deletes or replaces its inode', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-terminal-outbox-'));
    const first = record();
    writeTurnFeedbackTerminalOutbox(dataDir, first);
    expect(removeTurnFeedbackTerminalOutbox(dataDir, first)).toBe(true);
    const lock = join(dataDir, 'turn-feedback-terminal-outbox', 'app-a', '.capacity.lock');
    writeFileSync(lock, '', { mode: 0o600 });
    const old = new Date(Date.now() - 6_000);
    utimesSync(lock, old, old);
    const before = lstatSync(lock);
    expect(() => writeTurnFeedbackTerminalOutbox(dataDir, record({
      terminalRequestId: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
    }))).toThrow(/lock unavailable/i);
    const after = lstatSync(lock);
    expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
  });

  it('fails closed on a symlink inside the capacity tree without touching its target', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-terminal-outbox-'));
    writeTurnFeedbackTerminalOutbox(dataDir, record());
    const outside = mkdtempSync(join(tmpdir(), 'botmux-terminal-outside-'));
    writeFileSync(join(outside, 'sentinel'), 'safe');
    symlinkSync(outside, join(dataDir, 'turn-feedback-terminal-outbox', 'app-a', 'linked'));
    expect(() => writeTurnFeedbackTerminalOutbox(dataDir, record({
      terminalRequestId: 'acacacac-acac-4cac-8cac-acacacacacac',
    }))).toThrow(/symlink/i);
    expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('safe');
  });

  it('keeps resending when committed ACK cannot remove the exact file', async () => {
    vi.useFakeTimers();
    try {
      const dataDir = mkdtempSync(join(tmpdir(), 'botmux-terminal-outbox-'));
      const sent: WorkerToDaemon[] = [];
      const delivery = createTurnFeedbackTerminalDelivery({
        dataDir, send: message => sent.push(message), ipcLive: () => true, now: () => NOW,
      });
      const value = record();
      delivery.publish(value);
      const path = writeTurnFeedbackTerminalOutbox(dataDir, value);
      chmodSync(path, 0o644);

      expect(delivery.acknowledge({
        type: 'turn_terminal_persisted', terminalRequestId: value.terminalRequestId,
        sessionId: value.sessionId, turnId: value.turnId, dispatchAttempt: value.dispatchAttempt,
        status: value.status, result: 'committed',
      })).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(sent).toHaveLength(2);
      expect(delivery.pendingCount()).toBe(1);
      delivery.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retires committed delivery when suspend cleanup already removed the exact file', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-terminal-outbox-'));
    const delivery = createTurnFeedbackTerminalDelivery({
      dataDir, send: () => undefined, ipcLive: () => true, now: () => NOW,
    });
    const value = record();
    delivery.publish(value);
    expect(removeTurnFeedbackTerminalOutbox(dataDir, value)).toBe(true);

    expect(delivery.acknowledge({
      type: 'turn_terminal_persisted', terminalRequestId: value.terminalRequestId,
      sessionId: value.sessionId, turnId: value.turnId, dispatchAttempt: value.dispatchAttempt,
      status: value.status, result: 'committed',
    })).toBe(true);
    expect(delivery.pendingCount()).toBe(0);
  });
});
