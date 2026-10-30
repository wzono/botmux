import type { TenantHumanId } from '../services/bot-admin-unions-store.js';

export interface VerifiedAppTenant { appId: string; tenantKey: string; verifiedAt: number; source: 'app_api' | 'signed_callback' }
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
