import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveGroupWorkspaceCwd } from '../src/core/group-workspace-policy.js';
import { __testOnly_setupWorkerHandlers, initWorkerPool, setActiveSessionsRegistry } from '../src/core/worker-pool.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import { registerBot } from '../src/bot-registry.js';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  class FakeWSClient { start() {} }
  class FakeEventDispatcher { register() {} }
  return { Client: FakeClient, WSClient: FakeWSClient, EventDispatcher: FakeEventDispatcher, LoggerLevel: { info: 2 } };
});

let root = '';
const CHAT = 'oc_shared';

function dir(name: string): string {
  const value = join(root, name);
  mkdirSync(value, { recursive: true });
  return value;
}

async function loadDaemon() {
  vi.resetModules();
  process.env.SESSION_DATA_DIR = dir('sessions');
  const botRegistry = await import('../src/bot-registry.js');
  const groupStore = await import('../src/services/group-workspace-store.js');
  const daemon = await import('../src/daemon.js');
  return { botRegistry, groupStore, daemon };
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'botmux-group-resolution-')); });
afterEach(() => {
  delete process.env.SESSION_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('group workspace resolution', () => {
  it('keeps exact explicit, legacy-oncall, group, automatic-default, bot-default, picker precedence', () => {
    const group = { status: 'usable' as const, workingDir: '/group', revision: 3 };
    expect(resolveGroupWorkspaceCwd({ explicitWorkingDir: '/explicit', oncall: { workingDir: '/oncall' }, group, botDefaultWorkingDir: '/bot' }))
      .toMatchObject({ status: 'selected', source: 'explicit', workingDir: '/explicit' });
    expect(resolveGroupWorkspaceCwd({ oncall: { workingDir: '/legacy' }, group, botDefaultWorkingDir: '/bot' }))
      .toMatchObject({ status: 'selected', source: 'oncall-explicit', workingDir: '/legacy' });
    expect(resolveGroupWorkspaceCwd({ oncall: { workingDir: '/auto', provenance: 'oncall-default-auto' }, group, botDefaultWorkingDir: '/bot' }))
      .toMatchObject({ status: 'selected', source: 'group', workingDir: '/group', groupWorkspaceRevision: 3 });
    expect(resolveGroupWorkspaceCwd({ oncall: { workingDir: '/auto', provenance: 'oncall-default-auto' }, group: { status: 'unbound' }, botDefaultWorkingDir: '/bot' }))
      .toMatchObject({ status: 'selected', source: 'oncall-default-auto', workingDir: '/auto' });
    expect(resolveGroupWorkspaceCwd({ group: { status: 'unbound' }, botDefaultWorkingDir: '/bot' }))
      .toMatchObject({ status: 'selected', source: 'bot-default', workingDir: '/bot' });
    expect(resolveGroupWorkspaceCwd({ group: { status: 'unbound' } })).toEqual({ status: 'picker' });
  });

  it.each([
    [{ status: 'invalid' as const, workingDir: '/group', revision: 1 }, 'invalid'],
    [{ status: 'inaccessible' as const, workingDir: '/group', revision: 1 }, 'inaccessible'],
    [{ status: 'store-unavailable' as const }, 'store-unavailable'],
  ])('fails closed for %s instead of falling through', (group, status) => {
    expect(resolveGroupWorkspaceCwd({ group, botDefaultWorkingDir: '/bot' })).toEqual({ status, ...(status === 'store-unavailable' ? {} : { workingDir: '/group', groupWorkspaceRevision: 1 }) });
  });

  it.each([
    { status: 'invalid' as const, workingDir: '/broken', revision: 1 },
    { status: 'inaccessible' as const, workingDir: '/locked', revision: 2 },
    { status: 'store-unavailable' as const },
  ])('lets explicit repair intent bypass a broken group layer: %s', group => {
    expect(resolveGroupWorkspaceCwd({
      explicitWorkingDir: '/repair',
      oncall: { workingDir: '/legacy' },
      group,
      botDefaultWorkingDir: '/bot',
    })).toMatchObject({ status: 'selected', source: 'explicit', workingDir: '/repair' });
  });

  it('lets a deferred explicit repair route skip reading the broken group layer', async () => {
    const { botRegistry, daemon } = await loadDaemon();
    botRegistry.registerBot({ larkAppId: 'bot-b', larkAppSecret: 's', cliId: 'claude-code' });
    writeFileSync(join(process.env.SESSION_DATA_DIR!, 'group-workspaces.json'), '{broken');

    const result = await daemon.__testOnly_resolvePinnedWorkingDir({
      scope: 'thread', anchor: CHAT, chatId: CHAT, chatType: 'group', larkAppId: 'bot-b',
      explicitRepairIntent: true,
    });
    expect(result.resolution).toEqual({ status: 'picker' });
  });

  it('lets Bot B consume Bot A binding and lets /th resolve without a peer', async () => {
    const { botRegistry, groupStore, daemon } = await loadDaemon();
    const workspace = dir('workspace');
    botRegistry.registerBot({ larkAppId: 'bot-b', larkAppSecret: 's', cliId: 'claude-code' });
    const store = new groupStore.GroupWorkspaceStore(process.env.SESSION_DATA_DIR!);
    const source = groupStore.canonicalTextSourceEventId({ tenantKey: 't', chatId: CHAT, messageId: 'om_set' });
    if (!source.ok) throw new Error(source.reason);
    await store.mutate({ kind: 'set', chatId: CHAT, sourceEventId: source.sourceEventId, requestedWorkingDir: workspace,
      expectedRevision: 0, actor: { tenantKey: 't', unionId: 'on_admin' }, authorized: true, directoryValid: true, now: 1 });

    const result = await daemon.__testOnly_resolvePinnedWorkingDir({ scope: 'thread', anchor: CHAT, chatId: CHAT, chatType: 'group', larkAppId: 'bot-b' });
    expect(result).toMatchObject({ resolution: { status: 'selected', source: 'group', workingDir: workspace }, pinnedWorkingDir: workspace });
    expect(result.inheritedFrom).toBeNull();
  });

  it.each(['corrupt', 'locked'])('fails closed when the shared store is %s', async mode => {
    const { botRegistry, daemon } = await loadDaemon();
    const fallback = dir('bot-default');
    botRegistry.registerBot({ larkAppId: 'bot-b', larkAppSecret: 's', cliId: 'claude-code', defaultWorkingDir: fallback });
    const storePath = join(process.env.SESSION_DATA_DIR!, 'group-workspaces.json');
    if (mode === 'corrupt') writeFileSync(storePath, '{broken');
    else writeFileSync(`${storePath}.lock`, String(process.pid));

    await expect(daemon.__testOnly_resolvePinnedWorkingDir({ scope: 'chat', anchor: CHAT, chatId: CHAT, chatType: 'group', larkAppId: 'bot-b' }))
      .rejects.toThrow('group_workspace_store-unavailable');
  }, 10_000);

  it('re-probes the persisted binding identity immediately before spawn', async () => {
    const { daemon } = await loadDaemon();
    const workspace = dir('workspace');
    const replacement = dir('replacement');
    const initial = daemon.__testOnly_probeWorkspaceBeforeSpawn(workspace);
    expect(initial.ok).toBe(true);
    rmSync(workspace, { recursive: true });
    renameSync(replacement, workspace);
    expect(daemon.__testOnly_probeWorkspaceBeforeSpawn(workspace, initial.ok ? initial.identity : undefined))
      .toMatchObject({ ok: false, reason: 'changed' });
  });

  it('rejects real worker readiness when the backend-observed cwd differs', async () => {
    registerBot({ larkAppId: 'bot-b', larkAppSecret: 's', cliId: 'claude-code' });
    const requested = dir('requested');
    const other = dir('other');
    const worker = new EventEmitter() as any;
    worker.killed = false;
    worker.send = vi.fn();
    worker.kill = vi.fn();
    worker.pid = 123;
    worker.stdout = new EventEmitter();
    worker.stderr = new EventEmitter();
    const ds = {
      session: { sessionId: 'sid', chatId: CHAT, rootMessageId: CHAT, status: 'active', createdAt: new Date(0).toISOString(),
        larkAppId: 'bot-b', chatType: 'group', scope: 'chat', workingDir: requested, workingDirSource: 'group', groupWorkspaceRevision: 1, workerGeneration: 0 },
      worker, workerPort: null, workerToken: null, larkAppId: 'bot-b', chatId: CHAT, chatType: 'group', scope: 'chat',
      spawnedAt: 0, lastMessageAt: 0, hasHistory: false, workerGeneration: 0,
      groupWorkspaceLaunchGuard: { workingDir: requested },
    } as DaemonSession;
    const mismatch = vi.fn();
    initWorkerPool({
      sessionReply: vi.fn(), getSessionWorkingDir: () => requested, getActiveCount: () => 1, closeSession: vi.fn(),
      confirmWorkerReadyCwd: (_ds, actual) => actual === requested,
      onWorkerReadyCwdMismatch: mismatch,
    } as any);
    setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]]));
    __testOnly_setupWorkerHandlers(ds, worker, undefined, 0);

    worker.emit('message', { type: 'ready', port: 0, token: '', cwd: other });

    expect(worker.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mismatch).toHaveBeenCalledWith(ds, other);
    expect(ds.workerReady).not.toBe(true);
  });
});
