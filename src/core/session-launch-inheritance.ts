import type { Session } from '../types.js';
import { setSessionWorkingDirMetadata } from './session-cwd.js';

/** Fork and clean recovery must carry the same recorded launch decisions.
 * Native conversation/pane IDs, routing and caller authority are not launch
 * configuration; each lifecycle entry sets those explicitly. */
export function inheritSessionLaunchConfiguration(
  source: Session,
  target: Session,
  effectiveWorkingDir = source.workingDir,
): void {
  const fields = [
    'cliId', 'cliInstanceBinding', 'cliRuntime', 'cliPathOverride', 'cliConfigDir',
    'wrapperCli', 'cliLaunchMode', 'agentFrozen', 'cliLaunchSnapshot', 'backendType',
    'codexProfile', 'codexProfileHome', 'model', 'modelBackendVariant', 'reasoningEffort', 'serviceTier',
    'sandbox', 'sandboxPaths', 'sandboxScratch', 'sandboxHidePaths',
    'sandboxReadonlyPaths', 'sandboxNetwork', 'sandboxNetworkPolicy', 'autoWorktreeFallbackDir',
  ] as const satisfies readonly (keyof Session)[];
  Object.assign(target, structuredClone(Object.fromEntries(fields.map(key => [key, source[key]]))));
  if (effectiveWorkingDir) {
    setSessionWorkingDirMetadata(target, source.workingDirSource === 'group'
      ? { workingDir: effectiveWorkingDir, source: 'group', groupWorkspaceRevision: source.groupWorkspaceRevision! }
      : { workingDir: effectiveWorkingDir, source: source.workingDirSource ?? 'legacy-unknown' });
  }
}
