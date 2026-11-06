import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import type { DaemonSession } from './types.js';
import type { CliTurnPayload } from '../types.js';
import { probePathUsability } from './path-usability.js';
import { getSessionWorkingDir } from './session-manager.js';
import {
  dispatchAdmittedBusinessTurn as dispatchWithPermit,
  type BlankBootstrapPermit,
  type BusinessSubmitPermit,
  type WorkspaceIdentity,
} from './turn-admission.js';
import { TurnPermitStore } from '../services/turn-permit-store.js';

export type BusinessTurnSubmitOptions = {
  resume: boolean;
  dispatchAttempt?: number;
  durablePrimaryInbox?: true;
  notifyRejection?: false;
  codexAppSteerable?: true;
  atMostOnce?: true;
  queueAfterActiveTurn?: true;
  trustedCaller?: CliTurnPayload['trustedCaller'];
  onIpcDispatchAttempted?: () => void;
};

export type AdmittedTurnWorkerBoundary = {
  reserveGeneration(ds: DaemonSession): number;
  forkBlank(ds: DaemonSession, permit: BlankBootstrapPermit, options: BusinessTurnSubmitOptions): Promise<
    'started' | 'deferred' | 'observing' | 'rejected'
  >;
  submit(ds: DaemonSession, payload: string | CliTurnPayload, permit: BusinessSubmitPermit,
    digest: string, options: BusinessTurnSubmitOptions): Promise<boolean>;
};

export type AdmittedBusinessResource = {
  acquire?(permit: BusinessSubmitPermit): Promise<boolean>;
  markAttempting?(permit: BusinessSubmitPermit): Promise<boolean>;
};

const READY_TIMEOUT_MS = 30_000;
const PERMIT_TTL_MS = 60_000;
const payloadDigest = (payload: string | CliTurnPayload) => createHash('sha256')
  .update(JSON.stringify(payload)).digest('hex');

function exactIdentity(path: string): WorkspaceIdentity | undefined {
  try {
    const canonicalPath = realpathSync(path);
    const proof = probePathUsability(canonicalPath);
    if (!proof.ok) return undefined;
    return { path: canonicalPath, ...proof.identity };
  } catch { return undefined; }
}

export function frozenSessionWorkspace(ds: DaemonSession): { workspace: WorkspaceIdentity; groupRevision?: number } | undefined {
  const path = getSessionWorkingDir(ds);
  if (!path) return undefined;
  const actual = exactIdentity(path);
  if (!actual) return undefined;
  if (ds.session.workingDirSource !== 'group') return { workspace: actual };
  // The accepted binding may preserve an absolute symlink spelling while the
  // dispatch boundary deliberately returns a canonical path. Bind that spelling
  // to the session's frozen path plus the probed inode; never realpath it a second
  // time, because a symlink swap between probes must fail rather than authorize a
  // different target.
  const persisted = ds.session.groupWorkspaceIdentity ?? (ds.session.groupWorkspaceDirectoryIdentity
    ? { path: actual.path, ...ds.session.groupWorkspaceDirectoryIdentity }
    : undefined);
  if (!persisted || persisted.path !== path
    || persisted.dev !== actual.dev || persisted.ino !== actual.ino
    || ds.session.groupWorkspaceRevision === undefined) return undefined;
  return { workspace: { path, dev: actual.dev, ino: actual.ino }, groupRevision: ds.session.groupWorkspaceRevision };
}

export function authoritativeWorkerWorkspaceIdentity(ds: DaemonSession): WorkspaceIdentity | undefined {
  const backendType = ds.initConfig?.backendType ?? ds.session.backendType;
  const remote = ds.lastWorkerReadyHostWorkingDirContract;
  if (backendType === 'remote-runner') return undefined;
  if (backendType === 'riff' || backendType === 'mojo') {
    if (!remote) return undefined;
    const actual = exactIdentity(remote.workingDir);
    if (!actual || actual.dev !== remote.identity.dev || actual.ino !== remote.identity.ino) return undefined;
    return actual;
  }
  if (remote) return undefined;
  const cwd = ds.lastWorkerReadyCwd;
  if (!cwd) return undefined;
  try {
    const real = realpathSync(cwd);
    const stat = statSync(real, { bigint: true });
    return { path: real, dev: String(stat.dev), ino: String(stat.ino) };
  } catch { return undefined; }
}

function sameWorkspaceIdentity(a: WorkspaceIdentity, b: WorkspaceIdentity): boolean {
  return a.path === b.path && a.dev === b.dev && a.ino === b.ino;
}

export function backendMatchesFrozen(ds: DaemonSession, backend: WorkspaceIdentity, frozen: WorkspaceIdentity): boolean {
  if (backend.dev !== frozen.dev || backend.ino !== frozen.ino) return false;
  if (ds.session.workingDirSource !== 'group') return backend.path === frozen.path;
  try { return backend.path === realpathSync(frozen.path); } catch { return false; }
}

async function waitForExactReady(ds: DaemonSession, permit: BlankBootstrapPermit): Promise<{
  actualGeneration: number; cwd: WorkspaceIdentity; backend: WorkspaceIdentity;
} | undefined> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const generation = ds.workerGeneration ?? ds.session.workerGeneration;
    if (generation && generation > permit.reservedGeneration) return undefined;
    if (generation === permit.reservedGeneration && ds.workerReady === true && ds.cliReady === true) {
      const frozen = frozenSessionWorkspace(ds);
      const backend = authoritativeWorkerWorkspaceIdentity(ds);
      if (!frozen || !backend) return undefined;
      if (!backendMatchesFrozen(ds, backend, frozen.workspace)) return undefined;
      return { actualGeneration: generation, cwd: frozen.workspace, backend: frozen.workspace };
    }
    // A durable fork may be accepted but deferred by routing/device isolation.
    // Keep waiting for the exact reserved generation until cancellation/timeout.
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return undefined;
}

export async function dispatchAdmittedBusinessTurn(input: {
  ds: DaemonSession;
  turnId: string;
  payload: string | CliTurnPayload;
  options: BusinessTurnSubmitOptions;
  boundary: AdmittedTurnWorkerBoundary;
  permitStore: Pick<TurnPermitStore, 'issueBlank' | 'proveReady' | 'issueBusiness' | 'abortBootstrap' | 'abortBusinessDispatch'>;
  retireUnproven?(ds: DaemonSession, reservedGeneration: number): Promise<
    | { retiredGeneration: number; workerPid: number | null }
    | undefined
  >;
  resource?: AdmittedBusinessResource;
}): Promise<boolean> {
  const frozen = frozenSessionWorkspace(input.ds);
  if (!frozen) return false;
  return dispatchWithPermit({
    sessionId: input.ds.session.sessionId,
    turnId: input.turnId,
    permitTtlMs: PERMIT_TTL_MS,
    dependencies: {
      hasLiveWorker: () => !!input.ds.worker && !input.ds.worker.killed,
      freezeWorkspace: async () => frozen,
      currentWorkerGeneration: () => input.ds.workerGeneration ?? input.ds.session.workerGeneration,
      proveExistingWorkerReady: async (generation, workspace) => {
        const current = frozenSessionWorkspace(input.ds);
        const backend = authoritativeWorkerWorkspaceIdentity(input.ds);
        return generation === (input.ds.workerGeneration ?? input.ds.session.workerGeneration)
          && input.ds.workerReady === true && input.ds.cliReady === true
          && !!current && sameWorkspaceIdentity(current.workspace, workspace)
          && !!backend && backendMatchesFrozen(input.ds, backend, workspace);
      },
      issueExistingBusiness: async request => input.permitStore.issueBusiness({
        ...request, expiresAt: Date.now() + PERMIT_TTL_MS,
      }),
      reserveWorkerGeneration: () => input.boundary.reserveGeneration(input.ds),
      issueBlank: request => input.permitStore.issueBlank(request),
      forkBlank: permit => input.boundary.forkBlank(input.ds, permit, input.options),
      awaitBlankReady: permit => waitForExactReady(input.ds, permit),
      proveBlankReady: async (permit, proof) => {
        const result = await input.permitStore.proveReady(permit, proof);
        return result.status === 'issued' ? result.permit : undefined;
      },
      abortBlank: async (permit, phase) => {
        if (phase === 'pre_fork') return;
        const currentGeneration = input.ds.workerGeneration ?? input.ds.session.workerGeneration ?? 0;
        const retirement = await input.retireUnproven?.(input.ds, permit.reservedGeneration);
        await input.permitStore.abortBootstrap(permit, {
          phase,
          observedGeneration: currentGeneration,
          orphanRetired: retirement?.retiredGeneration === permit.reservedGeneration,
          ...(retirement ? { retiredGeneration: retirement.retiredGeneration, retiredWorkerPid: retirement.workerPid } : {}),
        });
      },
      abortBusiness: permit => input.permitStore.abortBusinessDispatch(permit, payloadDigest(input.payload)).then(() => undefined),
      ...(input.resource?.acquire ? { acquireResource: input.resource.acquire } : {}),
      ...(input.resource?.markAttempting ? { markAttempting: input.resource.markAttempting } : {}),
      submit: permit => input.boundary.submit(
        input.ds, input.payload, permit, payloadDigest(input.payload), input.options,
      ),
    },
  });
}
