import { describe, expect, it, vi } from 'vitest';
import {
  botAdminIdentityConfigFingerprint,
  loadFreshBotAdminUnionSnapshot,
  type BotAdminIdentityConfig,
  type FreshBotAdminUnionSnapshot,
  type TenantHumanId,
} from '../src/services/bot-admin-unions-store.js';
import { canManageGroupWorkspace } from '../src/core/group-workspace-policy.js';

const human: TenantHumanId = { tenantKey: 'tenant-1', unionId: 'on_human' };

function bots(): BotAdminIdentityConfig[] {
  return [
    { larkAppId: 'cli_a', tenantKey: 'tenant-1', resolvedAllowedUsers: ['ou_app_a'] },
    { larkAppId: 'cli_b', tenantKey: 'tenant-1', resolvedAllowedUsers: ['ou_app_b'] },
  ];
}

describe('fresh cross-app administrator identity', () => {
  it('deduplicates two app-scoped open ids into one tenant human', async () => {
    const resolve = vi.fn(async (bot: BotAdminIdentityConfig, entry: string) => {
      expect(entry).toBe(bot.resolvedAllowedUsers[0]);
      return human;
    });

    const snapshot = await loadFreshBotAdminUnionSnapshot({
      registeredBots: bots(),
      resolveAllowedUser: resolve,
    });

    expect(snapshot).toEqual({
      configFingerprint: botAdminIdentityConfigFingerprint(bots()),
      admins: [human],
    });
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('fingerprints every identity-relevant config field while ignoring collection order', () => {
    const original: BotAdminIdentityConfig[] = [
      { larkAppId: 'cli_a', tenantKey: 'tenant-1', brand: 'alpha', resolvedAllowedUsers: ['ou_a1', 'ou_a2'] },
      { larkAppId: 'cli_b', tenantKey: 'tenant-2', brand: 'beta', resolvedAllowedUsers: ['ou_b1'] },
    ];
    const baseline = botAdminIdentityConfigFingerprint(original);
    const variants: Array<[string, BotAdminIdentityConfig[]]> = [
      ['larkAppId', [{ ...original[0], larkAppId: 'cli_changed' }, original[1]]],
      ['tenantKey', [{ ...original[0], tenantKey: 'tenant-changed' }, original[1]]],
      ['brand', [{ ...original[0], brand: 'changed' }, original[1]]],
      ['resolvedAllowedUsers', [{ ...original[0], resolvedAllowedUsers: ['ou_a1', 'ou_changed'] }, original[1]]],
      ['Bot addition', [...original, { larkAppId: 'cli_c', tenantKey: 'tenant-3', resolvedAllowedUsers: ['ou_c1'] }]],
      ['Bot removal', [original[0]]],
    ];

    expect(botAdminIdentityConfigFingerprint([...original].reverse())).toBe(baseline);
    expect(botAdminIdentityConfigFingerprint([
      { ...original[0], resolvedAllowedUsers: [...original[0].resolvedAllowedUsers].reverse() },
      original[1],
    ])).toBe(baseline);
    for (const [field, variant] of variants) {
      expect(botAdminIdentityConfigFingerprint(variant), field).not.toBe(baseline);
    }
  });

  it('reuses only an exact current fingerprint and otherwise recomputes through every signing app', async () => {
    const registered = bots();
    const current: FreshBotAdminUnionSnapshot = {
      configFingerprint: botAdminIdentityConfigFingerprint(registered),
      admins: [human],
    };
    const resolve = vi.fn(async () => human);

    await expect(loadFreshBotAdminUnionSnapshot({ registeredBots: registered, snapshot: current, resolveAllowedUser: resolve }))
      .resolves.toBe(current);
    expect(resolve).not.toHaveBeenCalled();

    const stale: FreshBotAdminUnionSnapshot = { ...current, configFingerprint: 'stale' };
    const refreshed = await loadFreshBotAdminUnionSnapshot({ registeredBots: registered, snapshot: stale, resolveAllowedUser: resolve });
    expect(refreshed).toEqual(current);
    expect(refreshed).not.toBe(stale);
    expect(resolve.mock.calls.map(([bot]) => bot.larkAppId)).toEqual(['cli_a', 'cli_b']);
  });

  it('makes authorization unavailable if any allowed user cannot be conclusively converted', async () => {
    const resolve = vi.fn(async (bot: BotAdminIdentityConfig) => bot.larkAppId === 'cli_a' ? human : undefined);
    await expect(loadFreshBotAdminUnionSnapshot({ registeredBots: bots(), resolveAllowedUser: resolve }))
      .resolves.toBeUndefined();
  });

  it('makes authorization unavailable when stale-snapshot recomputation throws', async () => {
    const stale: FreshBotAdminUnionSnapshot = {
      configFingerprint: 'stale',
      admins: [human],
    };
    const resolve = vi.fn(async () => {
      throw new Error('conversion unavailable');
    });

    await expect(loadFreshBotAdminUnionSnapshot({ registeredBots: bots(), snapshot: stale, resolveAllowedUser: resolve }))
      .resolves.toBeUndefined();
  });

  it('rejects a conversion whose tenant differs from its signing Bot', async () => {
    const registered = [{ larkAppId: 'cli_a', tenantKey: 'tenant-1', resolvedAllowedUsers: ['ou_app_a'] }];
    const resolve = vi.fn(async (bot: BotAdminIdentityConfig) => {
      expect(bot).toBe(registered[0]);
      return { tenantKey: 'tenant-2', unionId: 'on_human' };
    });

    await expect(loadFreshBotAdminUnionSnapshot({ registeredBots: registered, resolveAllowedUser: resolve }))
      .resolves.toBeUndefined();
  });

  it('does not retain a removed administrator from a stale snapshot', async () => {
    const registered = [{ larkAppId: 'cli_a', tenantKey: 'tenant-1', resolvedAllowedUsers: ['ou_current'] }];
    const stale: FreshBotAdminUnionSnapshot = {
      configFingerprint: 'old-config',
      admins: [human],
    };
    const replacement = { tenantKey: 'tenant-1', unionId: 'on_replacement' };
    const fresh = await loadFreshBotAdminUnionSnapshot({
      registeredBots: registered,
      snapshot: stale,
      resolveAllowedUser: async () => replacement,
    });
    expect(canManageGroupWorkspace({ actor: human, freshSnapshot: fresh })).toBe(false);
    expect(canManageGroupWorkspace({ actor: replacement, freshSnapshot: fresh })).toBe(true);
  });
});

describe('group workspace manager policy', () => {
  const freshSnapshot: FreshBotAdminUnionSnapshot = {
    configFingerprint: 'current',
    admins: [human],
  };

  it('matches canonical identity by tenant and union id', () => {
    expect(canManageGroupWorkspace({ actor: { ...human }, freshSnapshot })).toBe(true);
    expect(canManageGroupWorkspace({ actor: { ...human, tenantKey: 'tenant-2' }, freshSnapshot })).toBe(false);
    expect(canManageGroupWorkspace({ actor: { tenantKey: human.tenantKey, unionId: 'on_other' }, freshSnapshot })).toBe(false);
    expect(canManageGroupWorkspace({ actor: { tenantKey: human.tenantKey, unionId: '' }, freshSnapshot })).toBe(false);
  });

  it('rejects absent identities and bot actors', () => {
    expect(canManageGroupWorkspace({ actor: undefined, freshSnapshot })).toBe(false);
    expect(canManageGroupWorkspace({ actor: { kind: 'bot', tenantKey: 'tenant-1', openId: 'ou_bot' }, freshSnapshot })).toBe(false);
    expect(canManageGroupWorkspace({ actor: human, freshSnapshot: undefined })).toBe(false);
  });

  it('uses tenant human ids for workspaceManagers and a nonempty list replaces defaults', () => {
    const manager: TenantHumanId = { tenantKey: 'tenant-1', unionId: 'on_manager' };
    expect(canManageGroupWorkspace({ actor: human, freshSnapshot, workspaceManagers: [manager] })).toBe(false);
    expect(canManageGroupWorkspace({ actor: manager, freshSnapshot, workspaceManagers: [manager] })).toBe(true);
    expect(canManageGroupWorkspace({
      actor: { ...manager, tenantKey: 'tenant-2' },
      freshSnapshot,
      workspaceManagers: [manager],
    })).toBe(false);
  });
});
