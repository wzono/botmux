import type { WorkspaceIdentity } from './turn-admission.js';

export type WorkingDirSource = 'explicit' | 'oncall-explicit' | 'group' | 'oncall-default-auto' | 'bot-default' | 'legacy-unknown';
export type RepoCandidate = { path: string; label: string };
export type WorkspaceResolution =
  | { status: 'resolved'; source: WorkingDirSource; identity: WorkspaceIdentity; groupRevision?: number }
  | { status: 'needs_picker'; candidates: RepoCandidate[] }
  | { status: 'unbound' }
  | { status: 'store_unavailable' | 'invalid_dir' | 'inaccessible'; detail: string }
  | { status: 'identity_changed'; expected: WorkspaceIdentity; actual?: WorkspaceIdentity };

export interface WorkspaceResolveInput {
  explicit(): Promise<WorkspaceResolution>;
  oncallExplicit(): Promise<WorkspaceResolution>;
  group(): Promise<WorkspaceResolution>;
  defaults(): Promise<WorkspaceResolution>;
  picker(): Promise<WorkspaceResolution>;
}

export async function resolveWorkspace(input: WorkspaceResolveInput): Promise<WorkspaceResolution> {
  for (const layer of [input.explicit, input.oncallExplicit, input.group, input.defaults, input.picker]) {
    const result = await layer();
    if (result.status !== 'unbound') return result;
  }
  return { status: 'unbound' };
}
