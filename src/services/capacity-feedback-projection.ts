import type { DaemonSession } from '../core/types.js';
import type { CapacityWaitPhase } from './capacity-wait-evidence.js';
import type { TurnFeedbackTarget } from './turn-feedback-reconciler.js';

export interface CapacityFeedbackProjectionDeps {
  read(target: TurnFeedbackTarget, turnId: string): CapacityWaitPhase | undefined;
  markStale(target: TurnFeedbackTarget, turnId: string, observedAtMs: number, nowMs: number): boolean;
  patch(ds: DaemonSession, turnId: string): void;
  reminderSync(target: TurnFeedbackTarget, turnId: string): void;
  now(): number;
  trailingMs: number;
  staleMs: number;
}

export function createCapacityFeedbackProjection(deps: CapacityFeedbackProjectionDeps) {
  const trailing = new Map<string, ReturnType<typeof setTimeout>>();
  const stale = new Map<string, ReturnType<typeof setTimeout>>();
  const lastPatched = new Map<string, { state?: string; position?: number; atMs: number }>();
  const keyFor = (target: TurnFeedbackTarget, turnId: string) =>
    JSON.stringify([target.larkAppId, target.session.sessionId, turnId]);

  function clearTimer(map: Map<string, ReturnType<typeof setTimeout>>, key: string): void {
    const timer = map.get(key);
    if (timer) clearTimeout(timer);
    map.delete(key);
  }

  function patchNow(ds: DaemonSession, target: TurnFeedbackTarget, turnId: string): void {
    const key = keyFor(target, turnId);
    const phase = deps.read(target, turnId);
    lastPatched.set(key, {
      state: phase?.state,
      position: phase?.state === 'waiting' ? phase.position : undefined,
      atMs: deps.now(),
    });
    deps.patch(ds, turnId);
  }

  function armStale(ds: DaemonSession, target: TurnFeedbackTarget, turnId: string): void {
    const key = keyFor(target, turnId);
    clearTimer(stale, key);
    const phase = deps.read(target, turnId);
    if (phase?.state !== 'waiting') return;
    const observedAtMs = phase.updatedAtMs;
    const timer = setTimeout(() => {
      stale.delete(key);
      if (!deps.markStale(target, turnId, observedAtMs, deps.now())) return;
      clearTimer(trailing, key);
      patchNow(ds, target, turnId);
      deps.reminderSync(target, turnId);
    }, Math.max(0, observedAtMs + deps.staleMs - deps.now()));
    timer.unref?.();
    stale.set(key, timer);
  }

  function sync(ds: DaemonSession, turnId: string): void {
    const target = { session: ds.session, larkAppId: ds.larkAppId };
    const key = keyFor(target, turnId);
    const phase = deps.read(target, turnId);
    const previous = lastPatched.get(key);
    const edge = previous?.state !== phase?.state;
    const positionOnly = phase?.state === 'waiting'
      && previous?.state === 'waiting'
      && previous.position !== phase.position;

    if (!previous || edge || !positionOnly || deps.now() - previous.atMs >= deps.trailingMs) {
      clearTimer(trailing, key);
      patchNow(ds, target, turnId);
    } else if (!trailing.has(key)) {
      const timer = setTimeout(() => {
        trailing.delete(key);
        patchNow(ds, target, turnId);
      }, Math.max(0, previous.atMs + deps.trailingMs - deps.now()));
      timer.unref?.();
      trailing.set(key, timer);
    }
    armStale(ds, target, turnId);
    deps.reminderSync(target, turnId);
  }

  function restore(sessions: Iterable<DaemonSession>): void {
    for (const ds of sessions) {
      for (const row of Object.values(ds.session.turnFeedback ?? {})) {
        if (row.capacity?.state !== 'waiting' && row.capacity?.state !== 'stale') continue;
        sync(ds, row.turnId);
      }
    }
  }

  function dispose(): void {
    for (const timer of trailing.values()) clearTimeout(timer);
    for (const timer of stale.values()) clearTimeout(timer);
    trailing.clear();
    stale.clear();
    lastPatched.clear();
  }

  return { sync, restore, dispose };
}
