import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TenantHumanId } from '../services/bot-admin-unions-store.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export interface VerifiedAppTenant { appId: string; tenantKey: string; verifiedAt: number; source: 'app_api' | 'signed_callback' }

export class VerifiedAppTenantRegistry {
  protected readonly records = new Map<string, VerifiedAppTenant>();

  observeSignedCallback(appId: string, tenantKey: string, verifiedAt = Date.now()): void {
    const normalized = tenantKey.trim();
    if (!appId || !normalized) return;
    this.records.set(appId, { appId, tenantKey: normalized, verifiedAt, source: 'signed_callback' });
  }

  observe(record: VerifiedAppTenant): void {
    const appId = record.appId.trim();
    const tenantKey = record.tenantKey.trim();
    if (!appId || !tenantKey) return;
    this.records.set(appId, { ...record, appId, tenantKey });
  }

  verifiedTenant(appId: string): VerifiedAppTenant | undefined {
    const record = this.records.get(appId);
    return record ? { ...record } : undefined;
  }

  registeredBots<T extends { larkAppId: string }>(
    bots: readonly T[],
    requestTenantKey: string,
  ): Array<T & { tenantKey: string }> {
    return bots.flatMap(bot => {
      const verified = this.records.get(bot.larkAppId);
      return verified?.tenantKey === requestTenantKey ? [{ ...bot, tenantKey: verified.tenantKey }] : [];
    });
  }
}

const VERIFIED_APP_TENANTS_FILE = 'verified-app-tenants.json';

export class DurableVerifiedAppTenantRegistry extends VerifiedAppTenantRegistry {
  constructor(private readonly dataDir: string) {
    super();
    try {
      const parsed = JSON.parse(readFileSync(join(dataDir, VERIFIED_APP_TENANTS_FILE), 'utf8')) as unknown;
      if (Array.isArray(parsed)) {
        for (const record of parsed) {
          if (record && typeof record === 'object') this.observe(record as VerifiedAppTenant);
        }
      }
    } catch {}
  }

  override observeSignedCallback(appId: string, tenantKey: string, verifiedAt = Date.now()): void {
    super.observeSignedCallback(appId, tenantKey, verifiedAt);
    this.persist();
  }

  private persist(): void {
    mkdirSync(this.dataDir, { recursive: true });
    const serialized = [...this.records.values()].sort((a, b) => a.appId.localeCompare(b.appId));
    atomicWriteFileSync(join(this.dataDir, VERIFIED_APP_TENANTS_FILE), JSON.stringify(serialized, null, 2) + '\n');
  }
}

export const verifiedAppTenantRegistry = new VerifiedAppTenantRegistry();
export type AuthorityRouteResult =
  | { status: 'not_applicable' }
  | { status: 'recognized_denied'; reason: 'identity_unavailable' | 'stale_config' | 'unauthorized' | 'tenant_mismatch' }
  | { status: 'authorized'; actor: TenantHumanId; configFingerprint: string };

const sameActor = (a: TenantHumanId, b: TenantHumanId) => a.tenantKey === b.tenantKey && a.unionId === b.unionId;

export async function authorizeWorkspaceOperation(input: {
  recognized: boolean; actor?: TenantHumanId; verifiedAppTenant: VerifiedAppTenant;
  admins: readonly TenantHumanId[]; configFingerprint: string; liveFingerprint(): string;
}): Promise<AuthorityRouteResult> {
  if (!input.recognized) return { status: 'not_applicable' };
  if (!input.actor) return { status: 'recognized_denied', reason: 'identity_unavailable' };
  if (input.actor.tenantKey !== input.verifiedAppTenant.tenantKey) return { status: 'recognized_denied', reason: 'tenant_mismatch' };
  if (input.liveFingerprint() !== input.configFingerprint) return { status: 'recognized_denied', reason: 'stale_config' };
  if (!input.admins.some(admin => sameActor(admin, input.actor!))) return { status: 'recognized_denied', reason: 'unauthorized' };
  return { status: 'authorized', actor: input.actor, configFingerprint: input.configFingerprint };
}

export async function revalidateWorkspaceCommit(input: {
  actor: TenantHumanId; admins: readonly TenantHumanId[]; configFingerprint: string; liveFingerprint(): string;
}): Promise<{ status: 'authorized' } | { status: 'denied'; reason: 'stale_config' | 'unauthorized' }> {
  if (input.liveFingerprint() !== input.configFingerprint) return { status: 'denied', reason: 'stale_config' };
  return input.admins.some(admin => sameActor(admin, input.actor))
    ? { status: 'authorized' }
    : { status: 'denied', reason: 'unauthorized' };
}

export function tenantForVerifiedCallback(input: { appId: string; verifiedAppTenants: readonly VerifiedAppTenant[] }): string | undefined {
  return input.verifiedAppTenants.find(record => record.appId === input.appId)?.tenantKey;
}
