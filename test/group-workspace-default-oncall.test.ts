import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(_options: unknown) {} }
  return { Client: FakeClient };
});

const dirs: string[] = [];

async function setup(options: { oncallChats?: Array<Record<string, unknown>> } = {}) {
  vi.resetModules();
  const root = mkdtempSync(join(tmpdir(), 'botmux-group-default-oncall-'));
  dirs.push(root);
  const groupDir = join(root, 'group');
  const oncallDir = join(root, 'oncall');
  mkdirSync(groupDir);
  mkdirSync(oncallDir);
  const configPath = join(root, 'bots.json');
  writeFileSync(configPath, JSON.stringify([{
    larkAppId: 'app_test',
    larkAppSecret: 'secret',
    cliId: 'claude-code',
    allowedUsers: ['ou_owner'],
    defaultOncall: { enabled: true, workingDir: oncallDir, since: 1 },
    ...(options.oncallChats ? { oncallChats: options.oncallChats } : {}),
  }]));
  process.env.BOTS_CONFIG = configPath;
  const registry = await import('../src/bot-registry.js');
  registry.loadBotConfigs().forEach(config => registry.registerBot(config));
  process.env.SESSION_DATA_DIR = root;
  const dispatcher = await import('../src/im/lark/event-dispatcher.js');
  const oncallStore = await import('../src/services/oncall-store.js');
  const policy = await import('../src/core/group-workspace-policy.js');
  const groupStoreModule = await import('../src/services/group-workspace-store.js');
  const daemon = await import('../src/daemon.js');
  return { root, groupDir, oncallDir, configPath, registry, dispatcher, oncallStore, policy, groupStoreModule, daemon };
}

afterEach(() => {
  delete process.env.BOTS_CONFIG;
  delete process.env.SESSION_DATA_DIR;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('defaultOncall provenance and group workspace precedence', () => {
  it('keeps dispatcher authorization while an auto binding yields to the group directory', async () => {
    const h = await setup();

    await h.dispatcher.__testOnly_bindDefaultOncallBeforeTalk('app_test', 'oc_group', 'group');

    const entry = h.registry.findOncallChat('app_test', 'oc_group');
    expect(entry).toEqual({
      chatId: 'oc_group',
      workingDir: h.oncallDir,
      provenance: 'oncall-default-auto',
    });
    expect(h.dispatcher.evaluateTalk('app_test', 'oc_group', 'ou_stranger', undefined, undefined, 'group'))
      .toMatchObject({ allowed: true, reason: 'oncall' });
    expect(h.policy.resolveGroupWorkspaceCwd({
      oncall: entry, groupWorkingDir: h.groupDir, groupWorkspaceRevision: 1,
    })).toEqual({ workingDir: h.groupDir, source: 'group', groupWorkspaceRevision: 1 });

    const persisted = JSON.parse(readFileSync(h.configPath, 'utf8'))[0].oncallChats[0];
    expect(persisted.provenance).toBe('oncall-default-auto');

    const groupStore = new h.groupStoreModule.GroupWorkspaceStore(h.root);
    const actor = { tenantKey: 'tenant-1', unionId: 'on_owner' };
    const source = h.groupStoreModule.canonicalTextSourceEventId({
      tenantKey: actor.tenantKey, chatId: 'oc_group', messageId: 'om_1',
    });
    expect(source.ok).toBe(true);
    if (!source.ok) throw new Error(source.reason);
    const committed = await groupStore.mutate({
      kind: 'set', chatId: 'oc_group', sourceEventId: source.sourceEventId, originMessageId: 'om_1',
      requestedWorkingDir: h.groupDir, expectedRevision: 0, actor, authorized: true,
      directoryValid: true, now: 1,
    });
    expect(committed.outcome).toBe('committed');
    const realResolution = await h.daemon.__testOnly_resolvePinnedWorkingDir({
      scope: 'chat', anchor: 'oc_group', chatId: 'oc_group', chatType: 'group', larkAppId: 'app_test',
    });
    expect(realResolution).toMatchObject({
      pinnedWorkingDir: h.groupDir,
      workingDirMutation: { workingDir: h.groupDir, source: 'group', groupWorkspaceRevision: 1 },
      pinnedFromBotDefault: false,
    });
  });

  it('manual oncall is explicit and outranks the group directory', async () => {
    const h = await setup();
    const result = await h.oncallStore.bindOncall('app_test', 'oc_group', h.oncallDir);
    expect(result.ok).toBe(true);
    const entry = h.registry.findOncallChat('app_test', 'oc_group');
    expect(entry?.provenance).toBe('oncall-explicit');
    expect(h.policy.resolveGroupWorkspaceCwd({ oncall: entry, groupWorkingDir: h.groupDir }))
      .toEqual({ workingDir: h.oncallDir, source: 'oncall-explicit' });
  });

  it('treats a legacy oncall entry without provenance conservatively as explicit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-group-default-oncall-legacy-'));
    dirs.push(root);
    const oncallDir = join(root, 'oncall');
    mkdirSync(oncallDir);
    const h = await setup({ oncallChats: [{ chatId: 'oc_group', workingDir: oncallDir }] });
    const entry = h.registry.findOncallChat('app_test', 'oc_group');
    expect(entry?.provenance).toBeUndefined();
    expect(h.policy.resolveGroupWorkspaceCwd({ oncall: entry, groupWorkingDir: h.groupDir }))
      .toEqual({ workingDir: oncallDir, source: 'oncall-explicit' });
  });
});
