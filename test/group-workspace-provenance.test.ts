import { describe, expect, it, vi } from 'vitest';

import type { DaemonSession } from '../src/core/types.js';
import {
  applySessionWorkingDir,
  normalizeSessionWorkingDirProvenance,
  type SessionWorkingDirMutation,
} from '../src/core/session-cwd.js';
import { resolveGroupWorkspaceCwd } from '../src/core/group-workspace-policy.js';
import * as sessionStore from '../src/services/session-store.js';

function daemonSession(): DaemonSession {
  return {
    workingDir: '/old',
    session: { sessionId: 's1', workingDir: '/old', workingDirSource: 'group', groupWorkspaceRevision: 1 },
  } as DaemonSession;
}

describe('session cwd provenance', () => {
  it.each<SessionWorkingDirMutation>([
    { workingDir: '/group', source: 'group', groupWorkspaceRevision: 7 },
    { workingDir: '/repo', source: 'explicit' },
    { workingDir: '/cd', source: 'explicit' },
    { workingDir: '/worktree', source: 'worktree' },
    { workingDir: '/ipc', source: 'explicit' },
    { workingDir: '/oncall', source: 'oncall-explicit' },
    { workingDir: '/default-oncall', source: 'oncall-default-auto' },
    { workingDir: '/bot-default', source: 'bot-default' },
  ])('atomically persists $source cwd metadata', mutation => {
    const ds = daemonSession();
    const update = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});

    applySessionWorkingDir(ds, mutation);

    expect(ds.workingDir).toBe(mutation.workingDir);
    expect(ds.session.workingDir).toBe(mutation.workingDir);
    expect(ds.session.workingDirSource).toBe(mutation.source);
    expect(ds.session.groupWorkspaceRevision).toBe(mutation.source === 'group' ? mutation.groupWorkspaceRevision : undefined);
    expect(update).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });

  it('keeps explicit /cd and IPC repins detached from later group revisions across restore', () => {
    for (const workingDir of ['/cd-Y', '/ipc-Y']) {
      const ds = daemonSession();
      vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
      applySessionWorkingDir(ds, { workingDir, source: 'explicit' });
      const restored = normalizeSessionWorkingDirProvenance(structuredClone(ds.session));
      expect(restored).toMatchObject({ workingDir, workingDirSource: 'explicit' });
      expect(restored.groupWorkspaceRevision).toBeUndefined();
      vi.restoreAllMocks();
    }
  });

  it('preserves persisted provenance on resume/recovery instead of inferring from equal paths', () => {
    const resumed = normalizeSessionWorkingDirProvenance({
      sessionId: 'resume', workingDir: '/same-as-group', workingDirSource: 'explicit', status: 'active',
    } as any);
    expect(resumed.workingDirSource).toBe('explicit');
    expect(resumed.groupWorkspaceRevision).toBeUndefined();
  });

  it('migrates absent legacy provenance conservatively and never infers group', () => {
    const legacy = normalizeSessionWorkingDirProvenance({
      sessionId: 'legacy', workingDir: '/same-as-group', status: 'active',
    } as any);
    expect(legacy.workingDirSource).toBe('legacy-unknown');
    expect(legacy.groupWorkspaceRevision).toBeUndefined();
  });

  it.each([
    { workingDir: '/x', source: 'group' },
    { workingDir: '/x', source: 'explicit', groupWorkspaceRevision: 1 },
    { workingDir: '/x', source: 'invented-source' },
  ] as any[])('rejects impossible metadata pair %#', mutation => {
    expect(() => normalizeSessionWorkingDirProvenance({
      sessionId: 'bad', status: 'active', workingDir: mutation.workingDir,
      workingDirSource: mutation.source, groupWorkspaceRevision: mutation.groupWorkspaceRevision,
    } as any)).toThrow();
  });

  it('returns group revision with the group resolver and clears it for non-group layers', () => {
    expect(resolveGroupWorkspaceCwd({ groupWorkingDir: '/group', groupWorkspaceRevision: 4 }))
      .toEqual({ workingDir: '/group', source: 'group', groupWorkspaceRevision: 4 });
    expect(resolveGroupWorkspaceCwd({
      oncall: { workingDir: '/oncall', provenance: 'oncall-explicit' },
      groupWorkingDir: '/group', groupWorkspaceRevision: 4,
    })).toEqual({ workingDir: '/oncall', source: 'oncall-explicit' });
  });
});
