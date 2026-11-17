import type { PathIdentity } from './path-usability.js';

export type WorkerCwdLaunchGuardResult =
  | { ok: true; pid: number; cwd: string }
  | { ok: false; reason: 'pid_unavailable' | 'cwd_unavailable' | 'cwd_mismatch'; pid?: number; cwd?: string };

export async function awaitAuthoritativeWorkerCwd(options: {
  expectedWorkingDir: string;
  expectedIdentity: PathIdentity;
  getChildPid: () => number | null | undefined;
  readCwd: (pid: number) => string | undefined;
  probe: (path: string, expectedIdentity: PathIdentity) => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<WorkerCwdLaunchGuardResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? 3_000;
  const pollMs = options.pollMs ?? 120;
  const deadline = now() + timeoutMs;

  do {
    const pid = options.getChildPid();
    if (pid) {
      const cwd = options.readCwd(pid);
      if (!cwd) return { ok: false, reason: 'cwd_unavailable', pid };
      if (!options.probe(cwd, options.expectedIdentity)
        || !options.probe(options.expectedWorkingDir, options.expectedIdentity)) {
        return { ok: false, reason: 'cwd_mismatch', pid, cwd };
      }
      return { ok: true, pid, cwd };
    }
    if (now() >= deadline) break;
    await sleep(pollMs);
  } while (true);

  return { ok: false, reason: 'pid_unavailable' };
}
