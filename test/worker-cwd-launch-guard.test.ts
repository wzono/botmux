import { describe, expect, it, vi } from 'vitest';
import { awaitAuthoritativeWorkerCwd } from '../src/core/worker-cwd-launch-guard.js';

const ID = { dev: '1', ino: '2' };

describe('worker cwd launch guard', () => {
  it('waits for a delayed backend child pid before validating cwd', async () => {
    let reads = 0;
    const sleep = vi.fn(async () => {});
    const result = await awaitAuthoritativeWorkerCwd({
      expectedWorkingDir: '/expected',
      expectedIdentity: ID,
      getChildPid: () => (++reads < 3 ? null : 42),
      readCwd: pid => pid === 42 ? '/expected' : undefined,
      probe: (path, identity) => path === '/expected' && identity === ID,
      sleep,
      timeoutMs: 100,
      pollMs: 10,
      now: (() => { let now = 0; return () => (now += 10); })(),
    });

    expect(result).toEqual({ ok: true, pid: 42, cwd: '/expected' });
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('fails closed when no authoritative child pid appears before the deadline', async () => {
    const result = await awaitAuthoritativeWorkerCwd({
      expectedWorkingDir: '/expected',
      expectedIdentity: ID,
      getChildPid: () => null,
      readCwd: () => undefined,
      probe: () => true,
      sleep: async () => {},
      timeoutMs: 20,
      pollMs: 10,
      now: (() => { let now = 0; return () => (now += 10); })(),
    });

    expect(result).toEqual({ ok: false, reason: 'pid_unavailable' });
  });

  it('fails closed on a mismatched process cwd', async () => {
    const result = await awaitAuthoritativeWorkerCwd({
      expectedWorkingDir: '/expected',
      expectedIdentity: ID,
      getChildPid: () => 7,
      readCwd: () => '/other',
      probe: (path) => path === '/expected',
      sleep: async () => {},
      timeoutMs: 20,
      pollMs: 10,
      now: () => 0,
    });

    expect(result).toEqual({ ok: false, reason: 'cwd_mismatch', pid: 7, cwd: '/other' });
  });
});
