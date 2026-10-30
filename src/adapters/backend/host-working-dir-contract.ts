import { probePathUsability, type PathIdentity } from '../../core/path-usability.js';
import type { SpawnOpts } from './types.js';

/** Immutable host-side path authority for backends that start execution only
 * when the first business input is submitted. */
export class HostWorkingDirContract {
  private expected: { path: string; identity: PathIdentity } | null = null;

  capture(opts: SpawnOpts): void {
    this.expected = opts.expectedWorkingDirIdentity
      ? { path: opts.cwd, identity: { ...opts.expectedWorkingDirIdentity } }
      : null;
  }

  matches(): boolean {
    const expected = this.expected;
    return expected === null
      || probePathUsability(expected.path, { expectedIdentity: expected.identity }).ok;
  }

  validatedProof(): { workingDir: string; identity: PathIdentity } | undefined {
    const expected = this.expected;
    if (expected === null
      || !probePathUsability(expected.path, { expectedIdentity: expected.identity }).ok) return undefined;
    return { workingDir: expected.path, identity: { ...expected.identity } };
  }
}
