import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from 'node:child_process';
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEntrySpawn } from './self-spawn.js';

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
  | { ok: true; identity: PathIdentity }
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

type EnterProbeRunner = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

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

const ENTER_PROBE_OUTPUT_LIMIT = 128;
const ENTER_PROBE_TIMEOUT_MS = 5_000;
const ENTER_PROBE_OUTPUT = /^(0|[1-9]\d*) (0|[1-9]\d*)\n$/;

export function createProcessDirectoryEnterProbe(
  runner: EnterProbeRunner = spawnSync,
): DirectoryEnterProbe {
  return normalizedPath => {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const sourceExecArgs = process.execArgv.map((arg, index, args) =>
      args[index - 1] === '--import' && arg === 'tsx' ? createRequire(import.meta.url).resolve('tsx') : arg);
    const entry = basename(moduleDir) === 'core' && basename(dirname(moduleDir)) === 'src'
      ? { command: process.execPath, args: [...sourceExecArgs, resolve(moduleDir, '../path-usability-runner.ts')] }
      : resolveEntrySpawn('path-usability-runner', resolve(moduleDir, '..'));
    const child = runner(entry.command, entry.args, {
      cwd: normalizedPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: ENTER_PROBE_TIMEOUT_MS,
      maxBuffer: ENTER_PROBE_OUTPUT_LIMIT,
    });
    if (child.error) return { ok: false, code: errorCode(child.error) };
    if (child.status !== 0 || child.signal !== null || !ENTER_PROBE_OUTPUT.test(child.stdout)) {
      return { ok: false };
    }
    const [dev, ino] = child.stdout.trimEnd().split(' ');
    return { ok: true, identity: { dev, ino } };
  };
}

const processDirectoryEnterProbe = createProcessDirectoryEnterProbe();

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
  if (!sameIdentity(before.identity, entered.identity)
    || (options.expectedIdentity && !sameIdentity(entered.identity, options.expectedIdentity))) {
    return { ok: false, normalizedPath, reason: 'changed' };
  }

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
