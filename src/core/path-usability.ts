import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

export interface PathIdentity {
  dev: string;
  ino: string;
}

export type PathUsabilityFailureReason =
  | 'missing'
  | 'not_directory'
  | 'inaccessible'
  | 'changed'
  | 'io_error';

export type PathUsabilityResult =
  | { ok: true; normalizedPath: string; identity: PathIdentity }
  | {
    ok: false;
    normalizedPath: string;
    reason: PathUsabilityFailureReason;
    code?: string;
  };

export type DirectoryEnterProbeResult =
  | { ok: true }
  | { ok: false; code?: string };

/**
 * Attempts to start a no-op child with the directory as cwd. The operating
 * system performs the chdir using the daemon's real uid/gid before exec, so
 * the parent cwd is never changed and no directory write permission is needed.
 */
export type DirectoryEnterProbe = (normalizedPath: string) => DirectoryEnterProbeResult;

export interface PathUsabilityProbeOptions {
  expectedIdentity?: PathIdentity;
  enterProbe?: DirectoryEnterProbe;
}

function identityOf(path: string): { identity: PathIdentity; isDirectory: boolean } {
  const stat = statSync(path, { bigint: true });
  return {
    identity: { dev: stat.dev.toString(), ino: stat.ino.toString() },
    isDirectory: stat.isDirectory(),
  };
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof (error as NodeJS.ErrnoException).code === 'string'
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function failureForCode(
  normalizedPath: string,
  code: string | undefined,
): Extract<PathUsabilityResult, { ok: false }> {
  if (code === 'ENOENT') return { ok: false, normalizedPath, reason: 'missing' };
  if (code === 'ENOTDIR') return { ok: false, normalizedPath, reason: 'not_directory' };
  if (code === 'EACCES' || code === 'EPERM') {
    return { ok: false, normalizedPath, reason: 'inaccessible' };
  }
  return {
    ok: false,
    normalizedPath,
    reason: 'io_error',
    ...(code ? { code } : {}),
  };
}

const processDirectoryEnterProbe: DirectoryEnterProbe = normalizedPath => {
  const child = spawnSync('/bin/sh', ['-c', 'exit 0'], {
    cwd: normalizedPath,
    stdio: 'ignore',
    timeout: 5_000,
  });
  if (child.error) return { ok: false, code: errorCode(child.error) };
  if (child.status !== 0) return { ok: false };
  return { ok: true };
};

export function probePathUsability(
  path: string,
  options: PathUsabilityProbeOptions = {},
): PathUsabilityResult {
  const normalizedPath = resolve(path);
  let before: ReturnType<typeof identityOf>;
  try {
    before = identityOf(normalizedPath);
  } catch (error) {
    return failureForCode(normalizedPath, errorCode(error));
  }
  if (!before.isDirectory) return { ok: false, normalizedPath, reason: 'not_directory' };
  if (options.expectedIdentity && !sameIdentity(before.identity, options.expectedIdentity)) {
    return { ok: false, normalizedPath, reason: 'changed' };
  }

  const entered = (options.enterProbe ?? processDirectoryEnterProbe)(normalizedPath);
  if (!entered.ok) return failureForCode(normalizedPath, entered.code);

  try {
    const after = identityOf(normalizedPath);
    if (!after.isDirectory || !sameIdentity(before.identity, after.identity)) {
      return { ok: false, normalizedPath, reason: 'changed' };
    }
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: false, normalizedPath, reason: 'changed' };
    }
    return failureForCode(normalizedPath, code);
  }

  return { ok: true, normalizedPath, identity: before.identity };
}
