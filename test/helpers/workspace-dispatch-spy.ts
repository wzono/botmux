import { vi } from 'vitest';
import * as pool from '../../src/core/worker-pool.js';
import { frozenSessionWorkspace } from '../../src/core/admitted-turn-dispatch.js';

export async function dispatchAdmittedThroughWorkerSpy(input: any): Promise<boolean> {
  const permit = { sessionId: input.ds.session.sessionId, turnId: input.turnId,
    workerGeneration: input.ds.workerGeneration ?? input.ds.session.workerGeneration ?? 1,
    workspace: frozenSessionWorkspace(input.ds)?.workspace, expiresAt: Date.now() + 60_000 };
  if (input.resource?.acquire && !await input.resource.acquire(permit)) return false;
  if (input.resource?.markAttempting && !await input.resource.markAttempting(permit)) return false;
  if (input.ds.worker && !input.ds.worker.killed) {
    return pool.sendWorkerInput(input.ds, input.payload, input.turnId, input.options);
  }
  return pool.forkWorker(input.ds, input.payload, { ...input.options, turnId: input.turnId }) !== false;
}

/** Keep routing/idempotency tests' existing send/fork fault injection behind
 * the newly shared admission seam. Production admission is exercised by the
 * group architecture/real-worker tests; this adapter still runs the caller's
 * exact lifecycle and persistent claim checks before touching its worker. */
export function installWorkspaceDispatchSpy() {
  return vi.spyOn(pool, 'dispatchWorkspaceAdmittedBusinessTurn').mockImplementation(dispatchWorkspaceThroughWorkerSpy);
}

export async function dispatchWorkspaceThroughWorkerSpy(input: Parameters<typeof pool.dispatchWorkspaceAdmittedBusinessTurn>[0]): Promise<boolean> {
    if (!await input.markAttempting()) return false;
    const options = { resume: input.resume, dispatchAttempt: input.dispatchAttempt,
      atMostOnce: input.atMostOnce, codexAppSteerable: input.codexAppSteerable,
      ...(input.queueAfterActiveTurn ? { queueAfterActiveTurn: true as const } : {}),
      trustedCaller: input.trustedCaller };
    if (input.ds.worker && !input.ds.worker.killed) {
      return pool.sendWorkerInput(input.ds, input.payload, input.turnId, options);
    }
    return pool.forkWorker(input.ds, input.payload, { ...options, turnId: input.turnId }) !== false;
}
