import { describe, expect, it } from 'vitest';
import { authorizeWorkspaceOperation, revalidateWorkspaceCommit, tenantForVerifiedCallback } from '../src/core/workspace-authority.js';

const actor = { tenantKey: 'tenant-a', unionId: 'on_same' };
describe('workspace authority v2', () => {
  it('does not merge equal union strings across tenants or relabel candidates', async () => {
    const result = await authorizeWorkspaceOperation({ recognized: true, actor, verifiedAppTenant: { appId: 'app-a', tenantKey: 'tenant-a', verifiedAt: 1, source: 'app_api' },
      admins: [{ tenantKey: 'tenant-b', unionId: 'on_same' }], configFingerprint: 'f1', liveFingerprint: () => 'f1' });
    expect(result).toEqual({ status: 'recognized_denied', reason: 'unauthorized' });
    expect(await authorizeWorkspaceOperation({ recognized: true, actor: { tenantKey: 'tenant-b', unionId: 'on_same' },
      verifiedAppTenant: { appId: 'app-a', tenantKey: 'tenant-a', verifiedAt: 1, source: 'app_api' }, admins: [{ tenantKey: 'tenant-b', unionId: 'on_same' }],
      configFingerprint: 'f1', liveFingerprint: () => 'f1' })).toEqual({ status: 'recognized_denied', reason: 'tenant_mismatch' });
  });
  it('maps authentic callback app header instead of synthetic card data', () => {
    expect(tenantForVerifiedCallback({ appId: 'app-a', verifiedAppTenants: [{ appId: 'app-a', tenantKey: 'tenant-a', verifiedAt: 1, source: 'app_api' }] })).toBe('tenant-a');
  });
  it('discriminates unrelated, denied and authorized routes', async () => {
    const base = { actor, verifiedAppTenant: { appId: 'app-a', tenantKey: 'tenant-a', verifiedAt: 1, source: 'app_api' as const }, admins: [actor], configFingerprint: 'f1', liveFingerprint: () => 'f1' };
    expect(await authorizeWorkspaceOperation({ ...base, recognized: false })).toEqual({ status: 'not_applicable' });
    expect(await authorizeWorkspaceOperation({ ...base, recognized: true, actor: undefined })).toEqual({ status: 'recognized_denied', reason: 'identity_unavailable' });
    expect(await authorizeWorkspaceOperation({ ...base, recognized: true })).toMatchObject({ status: 'authorized', actor });
  });
  it('rejects a stale fingerprint at authorization and commit', async () => {
    const input = { recognized: true, actor, verifiedAppTenant: { appId: 'app-a', tenantKey: 'tenant-a', verifiedAt: 1, source: 'app_api' as const }, admins: [actor], configFingerprint: 'f1', liveFingerprint: () => 'f2' };
    expect(await authorizeWorkspaceOperation(input)).toEqual({ status: 'recognized_denied', reason: 'stale_config' });
    expect(await revalidateWorkspaceCommit({ actor, admins: [actor], configFingerprint: 'f1', liveFingerprint: () => 'f2' })).toEqual({ status: 'denied', reason: 'stale_config' });
  });
});
