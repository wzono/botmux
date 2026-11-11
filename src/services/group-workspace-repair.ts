import { randomUUID } from 'node:crypto';
import type { TenantHumanId } from './bot-admin-unions-store.js';
import type { GroupWorkspaceStore } from './group-workspace-store.js';
import { probePathUsability, type PathUsabilityResult } from '../core/path-usability.js';
import { repairGroupWorkspaceQuarantineExact } from './session-store.js';

export interface GroupWorkspaceRepairAuthority {
  authorize(input: { actor: TenantHumanId; chatId: string }): Promise<boolean | {
    authorized: boolean;
    release?: () => Promise<void>;
  }> | boolean | { authorized: boolean; release?: () => Promise<void> };
}

/** Production coordinator: authority and group/path proof are always sampled
 * fresh, then the durable session row is changed by one exact SQLite CAS. */
export async function coordinateGroupWorkspaceQuarantineRepair(input: {
  sessionId: string;
  chatId: string;
  actor: TenantHumanId;
  authority: GroupWorkspaceRepairAuthority;
  groupStore: Pick<GroupWorkspaceStore, 'read'>;
  pathProbe?: (path: string) => PathUsabilityResult;
  now?: () => number;
  operationId?: string;
}): Promise<{ status: 'repaired'; operationId: string }
  | { status: 'unauthorized' | 'group_unavailable' | 'unbound' | 'identity_changed'
    | 'not_quarantined' | 'proof_mismatch' | 'conflict' }> {
  const authority = await input.authority.authorize({ actor: input.actor, chatId: input.chatId });
  const authorized = typeof authority === 'boolean' ? authority : authority.authorized;
  const release = typeof authority === 'boolean' ? undefined : authority.release;
  try {
    if (!authorized) return { status: 'unauthorized' };
    const current = await input.groupStore.read(input.chatId);
    if (current.status !== 'available') return { status: 'group_unavailable' };
    if (!current.record || current.record.directory.kind !== 'bound' || !current.record.workspaceIdentity) {
      return { status: 'unbound' };
    }
    const expected = current.record.workspaceIdentity;
    const proof = (input.pathProbe ?? probePathUsability)(current.record.directory.workingDir, {
      expectedIdentity: { dev: expected.dev, ino: expected.ino },
    });
    if (!proof.ok || proof.normalizedPath !== expected.path
      || proof.identity.dev !== expected.dev || proof.identity.ino !== expected.ino) {
      return { status: 'identity_changed' };
    }
    const operationId = input.operationId ?? randomUUID();
    const repaired = repairGroupWorkspaceQuarantineExact({
      sessionId: input.sessionId, operationId, repairedAt: (input.now ?? Date.now)(), actor: input.actor,
      chatId: input.chatId, revision: current.record.revision, identity: expected,
    });
    return repaired.status === 'repaired' ? { status: 'repaired', operationId } : repaired;
  } finally {
    await release?.();
  }
}
