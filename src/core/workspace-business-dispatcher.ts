import type { CliTurnPayload } from '../types.js';
import type { DaemonSession } from './types.js';
import type { WorkspaceIdentity } from './turn-admission.js';

export interface WorkspaceBusinessDispatchInput {
  ds: DaemonSession;
  turnId: string;
  payload: string | CliTurnPayload;
  options: { resume: boolean; dispatchAttempt?: number; atMostOnce?: true; codexAppSteerable?: true; queueAfterActiveTurn?: true; trustedCaller?: CliTurnPayload['trustedCaller'] };
  markAttempting?: () => Promise<boolean>;
  expectedWorkspace?: { workspace: WorkspaceIdentity; groupRevision?: number };
}

export function sameFrozenWorkspace(
  actual: { workspace: WorkspaceIdentity; groupRevision?: number } | undefined,
  expected: { workspace: WorkspaceIdentity; groupRevision?: number },
): boolean {
  return !!actual
    && actual.workspace.path === expected.workspace.path
    && actual.workspace.dev === expected.workspace.dev
    && actual.workspace.ino === expected.workspace.ino
    && actual.groupRevision === expected.groupRevision;
}

/** Daemon-owned orchestration shared by every non-ordinary business ingress. */
export function createWorkspaceBusinessDispatcher(deps: {
  runExclusive<T>(input: WorkspaceBusinessDispatchInput, run: () => Promise<T>): Promise<T>;
  freeze(ds: DaemonSession): { workspace: WorkspaceIdentity; groupRevision?: number } | undefined;
  follow(ds: DaemonSession): Promise<'continue' | 'stop'>;
  dispatch(input: WorkspaceBusinessDispatchInput): Promise<boolean>;
}): (input: WorkspaceBusinessDispatchInput) => Promise<boolean> {
  return input => deps.runExclusive(input, async () => {
    if (input.expectedWorkspace && !sameFrozenWorkspace(deps.freeze(input.ds), input.expectedWorkspace)) return false;
    if (await deps.follow(input.ds) === 'stop') return false;
    if (input.expectedWorkspace && !sameFrozenWorkspace(deps.freeze(input.ds), input.expectedWorkspace)) return false;
    return deps.dispatch(input);
  });
}
