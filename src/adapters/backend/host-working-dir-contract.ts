import { realpathSync, statSync } from 'node:fs';
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

  hasExpectedIdentity(): boolean {
    return this.expected !== null;
  }

  matches(): boolean {
    const expected = this.expected;
    return expected === null
      || probePathUsability(expected.path, { expectedIdentity: expected.identity }).ok;
  }

  /** Cheap send-edge identity fence. Launch/ready still use matches() for the
   * child-chdir usability proof; serialized submits need an exact no-subprocess
   * dev/ino check before and after provider-context derivation. */
  identityMatches(): boolean {
    const expected = this.expected;
    if (expected === null) return true;
    try {
      const path = realpathSync(expected.path);
      const stat = statSync(path, { bigint: true });
      return String(stat.dev) === expected.identity.dev
        && String(stat.ino) === expected.identity.ino;
    } catch { return false; }
  }

  validatedProof(): { workingDir: string; identity: PathIdentity } | undefined {
    const expected = this.expected;
    if (expected === null
      || !probePathUsability(expected.path, { expectedIdentity: expected.identity }).ok) return undefined;
    return { workingDir: expected.path, identity: { ...expected.identity } };
  }
}
