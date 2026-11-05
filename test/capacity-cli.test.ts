import { describe, expect, it } from 'vitest';
import { parseCapacityCommand, runCapacityCommand } from '../src/cli/capacity-command.js';

describe('capacity host CLI', () => {
  it('parses strict status, phase, disable and enable forms', () => {
    expect(parseCapacityCommand(['status', '--json'])).toEqual({ type: 'status', json: true });
    expect(parseCapacityCommand(['phase', 'full'])).toEqual({ type: 'phase', phase: 'full', json: false });
    expect(parseCapacityCommand(['disable', 'cli_app', 'codex', '--reason', 'false positive', '--json']))
      .toEqual({ type: 'disable', appId: 'cli_app', adapter: 'codex', reason: 'false positive', json: true });
    expect(parseCapacityCommand(['enable', 'cli_app', 'codex'])).toEqual({
      type: 'enable', appId: 'cli_app', adapter: 'codex', json: false,
    });
  });

  it.each([
    ['phase'],
    ['phase', 'pilot'],
    ['disable', 'cli_app', 'unknown'],
    ['disable', '../app', 'codex'],
    ['enable', 'cli_app', 'codex', '--force'],
    ['status', 'extra'],
  ])('rejects malformed or unknown arguments: %j', args => {
    expect(() => parseCapacityCommand(args)).toThrow(/usage|invalid|unknown/i);
  });

  it('mutates and reads the same rollout store', () => {
    const calls: string[] = [];
    const store = {
      phase: () => 'shadow' as const,
      snapshot: () => ({ version: 1 as const, phase: 'shadow' as const, disabled: {} }),
      setPhase: (phase: string) => calls.push(`phase:${phase}`),
      disable: (appId: string, adapter: string, reason: string) => calls.push(`disable:${appId}:${adapter}:${reason}`),
      enable: (appId: string, adapter: string) => calls.push(`enable:${appId}:${adapter}`),
    };
    expect(runCapacityCommand({ type: 'status', json: true }, store as any)).toMatchObject({
      ok: true, phase: 'shadow', disabled: {},
    });
    runCapacityCommand({ type: 'phase', phase: 'full', json: false }, store as any);
    runCapacityCommand({ type: 'disable', appId: 'cli_app', adapter: 'codex', reason: 'fp', json: false }, store as any);
    runCapacityCommand({ type: 'enable', appId: 'cli_app', adapter: 'codex', json: false }, store as any);
    expect(calls).toEqual(['phase:full', 'disable:cli_app:codex:fp', 'enable:cli_app:codex']);
  });
});
