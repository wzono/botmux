import type { WorkspaceIdentity } from './turn-admission.js';

export type WorkspaceConsumptionPoint = 'session_commit' | 'spawn' | 'ready' | 'backend_submit';
export type WorkspaceProbeResult =
  | { status: 'resolved'; identity: WorkspaceIdentity }
  | { status: 'invalid_dir' | 'inaccessible' | 'store_unavailable'; detail: string };
export type WorkspaceConsumptionResult =
  | { status: 'consumed'; identity: WorkspaceIdentity; point: WorkspaceConsumptionPoint }
  | Exclude<WorkspaceProbeResult, { status: 'resolved' }>
  | { status: 'identity_changed'; expected: WorkspaceIdentity; actual?: WorkspaceIdentity };

export async function consumeWorkspace(input: {
  expected: WorkspaceIdentity; point: WorkspaceConsumptionPoint; probe(path: string): Promise<WorkspaceProbeResult>;
}): Promise<WorkspaceConsumptionResult> {
  const result = await input.probe(input.expected.path);
  if (result.status !== 'resolved') return result;
  const actual = result.identity;
  if (actual.path !== input.expected.path || actual.dev !== input.expected.dev || actual.ino !== input.expected.ino) {
    return { status: 'identity_changed', expected: input.expected, actual };
  }
  return { status: 'consumed', identity: actual, point: input.point };
}
