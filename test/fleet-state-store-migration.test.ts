import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFleetState, readFleetState } from '../src/core/fleet-state-store.js';

describe('fleet state migration safety', () => {
  it.each([
    { name: 'botmux-0', appId: 'cli_a', pid: 42, generation: 1, status: 'online', restarts: 0, lastExitCode: null, startedAt: 'now' },
    { name: '', appId: 'cli_a', pid: 42, generation: 1, status: 'online', processStart: 'birth', restarts: 0, lastExitCode: null, startedAt: 'now' },
    { name: 'botmux-0', appId: '', pid: 42, generation: 1, status: 'online', processStart: 'birth', restarts: 0, lastExitCode: null, startedAt: 'now' },
    { name: 'botmux-0', appId: 'cli_a', pid: '42', generation: 1, status: 'online', processStart: 'birth', restarts: 0, lastExitCode: null, startedAt: 'now' },
    { name: 'botmux-0', appId: 'cli_a', pid: 42, generation: 0, status: 'online', processStart: 'birth', restarts: 0, lastExitCode: null, startedAt: 'now' },
    { name: 'botmux-0', appId: 'cli_a', pid: 42, generation: 1, status: 'unknown', processStart: 'birth', restarts: 0, lastExitCode: null, startedAt: 'now' },
  ])('fails closed instead of dropping or stopping a malformed online-looking row', row => {
    expect(() => parseFleetState({ supervisorPid: 1, supervisorStartedAt: 'now', procs: [row] })).toThrow('malformed');
  });

  it('propagates corrupt persisted state to the supervisor migration caller', () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-state-corrupt-'));
    const path = join(root, 'fleet.json');
    writeFileSync(path, JSON.stringify({ supervisorPid: 1, supervisorStartedAt: 'now', procs: [null] }));
    expect(() => readFleetState(path)).toThrow('malformed');
  });
});
