import { describe, expect, it } from 'vitest';
import { resolveWorkspace } from '../src/core/workspace-resolver.js';
import { consumeWorkspace } from '../src/core/workspace-consumption.js';
import { resolveGroupWorkspaceCwdAsync } from '../src/core/group-workspace-policy.js';

const identity = (path: string, ino = '2') => ({ path, dev: '1', ino });
const resolved = (path: string, source: any, extra = {}) => ({ status: 'resolved' as const, source, identity: identity(path), ...extra });

describe('async workspace resolver', () => {
  it.each([
    [{ explicit: resolved('/explicit', 'explicit') }, '/explicit', 'explicit'],
    [{ oncall: resolved('/oncall', 'oncall-explicit') }, '/oncall', 'oncall-explicit'],
    [{ group: resolved('/group', 'group', { groupRevision: 3 }) }, '/group', 'group'],
    [{ oncall: resolved('/auto', 'oncall-default-auto') }, '/auto', 'oncall-default-auto'],
    [{ botDefault: resolved('/default', 'bot-default') }, '/default', 'bot-default'],
  ] as const)('uses precedence for %#', async (layers, path, source) => {
    const result = await resolveWorkspace({
      explicit: async () => (layers as any).explicit ?? { status: 'unbound' },
      oncallExplicit: async () => (layers as any).oncall?.source === 'oncall-explicit' ? (layers as any).oncall : { status: 'unbound' },
      group: async () => (layers as any).group ?? { status: 'unbound' },
      defaults: async () => (layers as any).oncall ?? (layers as any).botDefault ?? { status: 'unbound' },
      picker: async () => ({ status: 'needs_picker', candidates: [] }),
    });
    expect(result).toMatchObject({ status: 'resolved', source, identity: { path } });
  });

  it.each(['store_unavailable', 'invalid_dir', 'inaccessible', 'identity_changed'] as const)
  ('does not fall back after %s', async status => {
    let lowerCalled = false;
    const failure: any = status === 'identity_changed'
      ? { status, expected: identity('/x'), actual: identity('/x', '9') }
      : { status, detail: status };
    const result = await resolveWorkspace({ explicit: async () => ({ status: 'unbound' }), oncallExplicit: async () => ({ status: 'unbound' }),
      group: async () => failure, defaults: async () => { lowerCalled = true; return resolved('/fallback', 'bot-default'); },
      picker: async () => ({ status: 'needs_picker', candidates: [] }) });
    expect(result.status).toBe(status); expect(lowerCalled).toBe(false);
  });

  it('allows only unbound to advance to picker', async () => {
    const result = await resolveWorkspace({ explicit: async () => ({ status: 'unbound' }), oncallExplicit: async () => ({ status: 'unbound' }),
      group: async () => ({ status: 'unbound' }), defaults: async () => ({ status: 'unbound' }),
      picker: async () => ({ status: 'needs_picker', candidates: [{ path: '/x', label: 'x' }] }) });
    expect(result).toMatchObject({ status: 'needs_picker' });
  });

  it.each(['store_unavailable', 'invalid_dir', 'inaccessible', 'identity_changed'] as const)
  ('preserves %s through the existing group policy compatibility boundary', async status => {
    const failure: any = status === 'identity_changed'
      ? { status, expected: identity('/group'), actual: identity('/group', '9') }
      : { status, detail: status };
    let defaultsCalled = false;
    const result = await resolveGroupWorkspaceCwdAsync({
      explicit: async () => ({ status: 'unbound' }),
      oncallExplicit: async () => ({ status: 'unbound' }),
      group: async () => failure,
      defaults: async () => { defaultsCalled = true; return resolved('/fallback', 'bot-default'); },
      picker: async () => ({ status: 'needs_picker', candidates: [] }),
    });
    expect(result.status).toBe(status);
    expect(defaultsCalled).toBe(false);
  });
});

describe('workspace consumption', () => {
  it.each(['session_commit', 'spawn', 'ready', 'backend_submit'] as const)('revalidates path identity at %s', async point => {
    const calls: string[] = [];
    const result = await consumeWorkspace({ expected: identity('/repo'), point, probe: async path => { calls.push(`${point}:${path}`); return { status: 'resolved', identity: identity('/repo') }; } });
    expect(result).toEqual({ status: 'consumed', identity: identity('/repo'), point }); expect(calls).toEqual([`${point}:/repo`]);
  });
  it('rejects same path with changed inode', async () => {
    const result = await consumeWorkspace({ expected: identity('/repo'), point: 'spawn', probe: async () => ({ status: 'resolved', identity: identity('/repo', '9') }) });
    expect(result).toEqual({ status: 'identity_changed', expected: identity('/repo'), actual: identity('/repo', '9') });
  });
});
