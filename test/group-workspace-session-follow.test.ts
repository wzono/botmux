import { describe, expect, it, vi } from 'vitest';
import {
  resolveGroupWorkspaceFollowTarget,
  runGroupWorkspaceSessionFollow,
} from '../src/core/session-cwd.js';

type HarnessOptions = {
  source?: string; scope?: 'chat' | 'thread'; revision?: number; idle?: boolean;
  local?: boolean; adopted?: boolean; workerless?: boolean;
  fail?: 'retire' | 'persist' | 'spawn' | 'ready' | 'cwd';
  journalPhase?: 'prepared' | 'old_exited' | 'persisted' | 'spawned';
};

function harness(opts: HarnessOptions = {}) {
  const order: string[] = [];
  const session: any = {
    sessionId: 's1', workingDir: '/x1', workingDirSource: opts.source ?? 'group',
    groupWorkspaceRevision: opts.revision ?? 1, workerGeneration: 4,
    ...(opts.journalPhase ? { groupWorkspaceFollow: {
      schemaVersion: 2, journalRevision: 0, targetWorkingDir: '/x2', targetRevision: 2, targetWorkspaceIdentity: { path: '/x2', dev: '1', ino: '2' }, previousRevision: 1, previousGeneration: 4,
      nextGeneration: 5, phase: opts.journalPhase,
    } } : {}),
  };
  let liveWorkers = opts.workerless || opts.journalPhase === 'old_exited' || opts.journalPhase === 'persisted' ? 0 : 1;
  const ds: any = { scope: opts.scope ?? 'chat', session, workingDir: session.workingDir,
    adoptedFrom: opts.adopted ? { cwd: '/x1' } : undefined };
  const deps: any = {
    isIdle: () => opts.idle ?? true,
    supportsReplacement: () => opts.local ?? true,
    isWorkerLive: () => liveWorkers === 1,
    persist: (mutation: any) => {
      order.push(`persist:${mutation.phase ?? mutation.source}`);
      if (opts.fail === 'persist' && mutation.source === 'group') throw new Error('disk');
      const currentRevision = session.groupWorkspaceFollow?.journalRevision ?? null;
      if (currentRevision !== mutation.expectedJournalRevision) return false;
      if (mutation.source) Object.assign(session, { workingDir: mutation.workingDir,
        workingDirSource: mutation.source, groupWorkspaceRevision: mutation.groupWorkspaceRevision,
        workerGeneration: mutation.workerGeneration });
      session.groupWorkspaceFollow = mutation.journal;
      return true;
    },
    retire: async () => { order.push('retire'); if (opts.fail === 'retire') return false; liveWorkers = 0; return true; },
    spawn: (_ds: unknown, reserved: (generation: number) => void) => { order.push('spawn'); if (liveWorkers) throw new Error('double worker');
      if (opts.fail === 'spawn') return false; reserved(5); liveWorkers = 1; return true; },
    awaitReady: async () => { order.push('ready'); if (opts.fail === 'ready') return { ready: false };
      return { ready: true, workingDir: opts.fail === 'cwd' ? '/wrong' : '/x2' }; },
    notice: (kind: string) => order.push(`notice:${kind}`),
  };
  return { ds, deps, order, liveWorkers: () => liveWorkers };
}

describe('group workspace pre-turn worker follow', () => {
  it('uses the committed record identity for a newer revision without re-probing mutable path state', () => {
    const workspaceIdentity = { path: '/x2', dev: '7', ino: '9' };
    expect(resolveGroupWorkspaceFollowTarget({
      currentRevision: 1,
      group: { status: 'available', record: {
        revision: 2, directory: { kind: 'bound', workingDir: '/x2' }, workspaceIdentity,
      } },
    })).toEqual({ kind: 'follow', target: { workingDir: '/x2', revision: 2, workspaceIdentity } });
  });
  it.each(['prepared', 'old_exited', 'persisted', 'spawned'] as const)(
    'keeps the durable %s target authoritative after the group is unbound',
    phase => {
      const journal = {
        schemaVersion: 2, journalRevision: 0, targetWorkingDir: '/x2', targetRevision: 2, targetWorkspaceIdentity: { path: '/x2', dev: '1', ino: '2' }, previousRevision: 1,
        previousGeneration: 4, nextGeneration: 5, phase,
      };
      expect(resolveGroupWorkspaceFollowTarget({
        journal,
        group: { status: 'available', record: { revision: 3, directory: { kind: 'unbound' } } },
      })).toEqual({ kind: 'follow', target: { workingDir: '/x2', revision: 2, workspaceIdentity: { path: '/x2', dev: '1', ino: '2' } } });
    },
  );

  it('does not admit an unbound group session while its follow journal is unresolved', () => {
    expect(resolveGroupWorkspaceFollowTarget({
      journal: {
        schemaVersion: 2, journalRevision: 0, targetWorkingDir: '/x2', targetRevision: 2, targetWorkspaceIdentity: { path: '/x2', dev: '1', ino: '2' }, previousRevision: 1,
        previousGeneration: 4, nextGeneration: 5, phase: 'persisted',
      },
      group: { status: 'available', record: { revision: 3, directory: { kind: 'unbound' } } },
    }).kind).not.toBe('continue');
  });

  it.each(['prepared', 'old_exited', 'persisted', 'spawned'] as const)(
    'recovers the durable %s target even while the group store is unavailable',
    phase => {
      expect(resolveGroupWorkspaceFollowTarget({
        journal: {
          schemaVersion: 2, journalRevision: 0, targetWorkingDir: '/x2', targetRevision: 2, targetWorkspaceIdentity: { path: '/x2', dev: '1', ino: '2' }, previousRevision: 1,
          previousGeneration: 4, nextGeneration: 5, phase,
        },
        group: { status: 'store_unavailable' },
      })).toEqual({ kind: 'follow', target: { workingDir: '/x2', revision: 2, workspaceIdentity: { path: '/x2', dev: '1', ino: '2' } } });
    },
  );

  it('adopts a newer binding for a workerless local session before its blank business bootstrap', async () => {
    const h = harness({ workerless: true, idle: false });
    const result = await runGroupWorkspaceSessionFollow(h.ds, {
      workingDir: '/x2', revision: 2, workspaceIdentity: { path: '/x2', dev: '1', ino: '2' },
    }, h.deps);
    expect(result).toEqual({ kind: 'migrated' });
    expect(h.order).toEqual(['persist:prepared', 'retire', 'persist:old_exited', 'persist:group',
      'spawn', 'persist:spawned', 'ready', 'persist:complete', 'notice:migrated']);
    expect(h.ds.session.workingDir).toBe('/x2');
  });

  it.each(['claude', 'codex'])('replaces an idle local PTY generation before delivering on %s', async () => {
    const h = harness();
    const result = await runGroupWorkspaceSessionFollow(h.ds, { workingDir: '/x2', revision: 2, workspaceIdentity: { path: '/x2', dev: '1', ino: '2' } }, h.deps);
    h.order.push('deliver');
    expect(result).toEqual({ kind: 'migrated' });
    expect(h.order).toEqual(['persist:prepared', 'retire',
      'persist:old_exited', 'persist:group', 'spawn', 'persist:spawned', 'ready',
      'persist:complete', 'notice:migrated', 'deliver']);
    expect(h.ds.workingDir).toBe('/x2');
    expect(h.ds.session.groupWorkspaceRevision).toBe(2);
    expect(h.liveWorkers()).toBe(1);
  });

  it.each([
    ['busy', { idle: false }], ['thread', { scope: 'thread' }], ['explicit', { source: 'explicit' }],
    ['oncall explicit', { source: 'oncall-explicit' }], ['oncall auto', { source: 'oncall-default-auto' }],
    ['bot default', { source: 'bot-default' }], ['legacy', { source: 'legacy-unknown' }],
  ])('defers or skips %s without lifecycle mutation', async (_name, options) => {
    const h = harness(options as HarnessOptions);
    const result = await runGroupWorkspaceSessionFollow(h.ds, { workingDir: '/x2', revision: 2, workspaceIdentity: { path: '/x2', dev: '1', ino: '2' } }, h.deps);
    expect(result.kind).toMatch(/deferred|unchanged/);
    expect(h.order).toEqual([]);
  });

  it.each(['retire', 'persist', 'spawn', 'ready', 'cwd'] as const)(
    'fails closed once when %s fails', async fail => {
      const h = harness({ fail });
      const result = await runGroupWorkspaceSessionFollow(h.ds, { workingDir: '/x2', revision: 2, workspaceIdentity: { path: '/x2', dev: '1', ino: '2' } }, h.deps);
      expect(result.kind).toBe('failed');
      expect(h.order.filter(x => x === 'notice:failed')).toHaveLength(1);
      if (fail === 'retire') expect(h.order).not.toContain('spawn');
    });

  it.each([['remote', { local: false }], ['adopt', { adopted: true }]])(
    'fails closed and retains the old cwd for %s sessions', async (_name, options) => {
      const h = harness(options as HarnessOptions);
      const result = await runGroupWorkspaceSessionFollow(h.ds, { workingDir: '/x2', revision: 2, workspaceIdentity: { path: '/x2', dev: '1', ino: '2' } }, h.deps);
      expect(result.kind).toBe('failed');
      expect(h.ds.session.workingDir).toBe('/x1');
      expect(h.order).toEqual(['notice:failed']);
    });

  it('does not overwrite an explicit repin that wins during old-worker exit', async () => {
    const h = harness();
    h.deps.retire = async () => {
      h.order.push('retire');
      h.ds.session.workingDir = '/manual';
      h.ds.session.workingDirSource = 'explicit';
      return true;
    };
    const result = await runGroupWorkspaceSessionFollow(h.ds, { workingDir: '/x2', revision: 2, workspaceIdentity: { path: '/x2', dev: '1', ino: '2' } }, h.deps);
    expect(result.kind).toBe('failed');
    expect(h.ds.session.workingDir).toBe('/manual');
    expect(h.order).not.toContain('spawn');
  });

  it('publishes neither replacement metadata nor effects when persistence fails', async () => {
    const h = harness({ fail: 'persist' });
    const result = await runGroupWorkspaceSessionFollow(h.ds, { workingDir: '/x2', revision: 2,
      workspaceIdentity: { path: '/x2', dev: '1', ino: '2' } }, h.deps);
    expect(result.kind).toBe('failed');
    expect(h.ds.workingDir).toBe('/x1');
    expect(h.ds.session.workingDir).toBe('/x1');
    expect(h.order).not.toContain('spawn');
  });

  it('defers an overlapping runner while the winner awaits worker retirement', async () => {
    const h = harness();
    let releaseRetire!: (retired: boolean) => void;
    h.deps.retire = vi.fn(async () => new Promise<boolean>(resolve => { releaseRetire = retired => {
      if (retired) {
        h.deps.isWorkerLive = () => false;
        h.deps.spawn = (_ds: unknown, reserved: (generation: number) => void) => {
          h.order.push('spawn'); reserved(5); return true;
        };
      }
      resolve(retired);
    }; }));
    const first = runGroupWorkspaceSessionFollow(h.ds, { workingDir: '/x2', revision: 2,
      workspaceIdentity: { path: '/x2', dev: '1', ino: '2' } }, h.deps);
    await vi.waitFor(() => expect(h.deps.retire).toHaveBeenCalledTimes(1));
    const loser = await runGroupWorkspaceSessionFollow(h.ds, { workingDir: '/x2', revision: 2,
      workspaceIdentity: { path: '/x2', dev: '1', ino: '2' } }, h.deps);
    expect(loser).toEqual({ kind: 'deferred' });
    expect(h.deps.retire).toHaveBeenCalledTimes(1);
    releaseRetire(true);
    expect(await first).toEqual({ kind: 'migrated' });
  });

  it('defers when a newer journal revision wins during a worker await', async () => {
    const h = harness();
    h.deps.retire = async () => {
      h.order.push('retire');
      h.ds.session.groupWorkspaceFollow = {
        ...h.ds.session.groupWorkspaceFollow,
        journalRevision: 1,
      };
      return true;
    };
    const result = await runGroupWorkspaceSessionFollow(h.ds, { workingDir: '/x2', revision: 2,
      workspaceIdentity: { path: '/x2', dev: '1', ino: '2' } }, h.deps);
    expect(result).toEqual({ kind: 'deferred' });
    expect(h.order).not.toContain('spawn');
    expect(h.order).not.toContain('notice:failed');
  });

  it.each(['prepared', 'old_exited', 'persisted', 'spawned'] as const)('recovers %s journal without overlapping workers', async phase => {
    const h = harness({ journalPhase: phase });
    const result = await runGroupWorkspaceSessionFollow(h.ds, { workingDir: '/x2', revision: 2, workspaceIdentity: { path: '/x2', dev: '1', ino: '2' } }, h.deps);
    expect(result.kind).toBe('migrated');
    expect(h.order.filter(x => x === 'spawn')).toHaveLength(phase === 'spawned' ? 0 : 1);
  });

  it('does not reserve again when persisted already records the replacement generation', async () => {
    const h = harness({ journalPhase: 'persisted' });
    h.ds.session.workerGeneration = 5;
    h.deps.isWorkerLive = () => true;
    const result = await runGroupWorkspaceSessionFollow(h.ds, { workingDir: '/x2', revision: 2, workspaceIdentity: { path: '/x2', dev: '1', ino: '2' } }, h.deps);
    expect(result.kind).toBe('migrated');
    expect(h.order).not.toContain('spawn');
  });

  it('spawns at most once when a spawned recovery lost its prior process', async () => {
    const h = harness({ journalPhase: 'spawned' });
    h.deps.isWorkerLive = () => false;
    h.deps.spawn = (_ds: unknown, reserved: (generation: number) => void) => {
      h.order.push('spawn');
      reserved(6);
      return true;
    };
    const result = await runGroupWorkspaceSessionFollow(h.ds, { workingDir: '/x2', revision: 2, workspaceIdentity: { path: '/x2', dev: '1', ino: '2' } }, h.deps);
    expect(result.kind).toBe('migrated');
    expect(h.order.filter(x => x === 'spawn')).toHaveLength(1);
  });
});
