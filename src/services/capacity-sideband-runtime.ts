export interface CapacitySidebandBinding {
  adapter: 'codex' | 'claude-code';
  sessionId: string;
  turnId: string;
  dispatchAttempt: number;
  workerGeneration: number;
  nativeTurnId: string;
  nativeSessionId?: string;
}

export interface CapacitySidebandIdentity {
  adapter: CapacitySidebandBinding['adapter'];
  nativeTurnId: string;
  nativeSessionId?: string;
}

function keyOf(identity: CapacitySidebandIdentity): string | undefined {
  const turnId = identity.nativeTurnId.trim();
  if (!turnId) return undefined;
  if (identity.adapter === 'claude-code') {
    const sessionId = identity.nativeSessionId?.trim();
    if (!sessionId) return undefined;
    return JSON.stringify([identity.adapter, sessionId, turnId]);
  }
  return JSON.stringify([identity.adapter, '', turnId]);
}

export function createCapacitySidebandRuntime(
  bindingIsActive: (binding: CapacitySidebandBinding) => boolean = () => true,
) {
  const bindings = new Map<string, CapacitySidebandBinding>();

  function bind(binding: CapacitySidebandBinding): boolean {
    if (!binding.sessionId || !binding.turnId
      || !Number.isSafeInteger(binding.dispatchAttempt) || binding.dispatchAttempt < 0
      || !Number.isSafeInteger(binding.workerGeneration) || binding.workerGeneration < 1) return false;
    const key = keyOf(binding);
    if (!key) return false;
    const prior = bindings.get(key);
    const sameOwner = prior?.sessionId === binding.sessionId && prior.turnId === binding.turnId;
    if (prior && !sameOwner && bindingIsActive(prior)) return false;
    if (prior && sameOwner && (binding.workerGeneration < prior.workerGeneration
      || binding.workerGeneration === prior.workerGeneration
        && binding.dispatchAttempt < prior.dispatchAttempt)) return false;
    bindings.set(key, { ...binding });
    return true;
  }

  function resolve(identity: CapacitySidebandIdentity): CapacitySidebandBinding | undefined {
    const key = keyOf(identity);
    const hit = key ? bindings.get(key) : undefined;
    if (hit && !bindingIsActive(hit)) {
      bindings.delete(key!);
      return undefined;
    }
    return hit ? { ...hit } : undefined;
  }

  function restore(binding: CapacitySidebandBinding | undefined): void {
    if (binding) bind(binding);
  }

  function retireWorker(sessionId: string, workerGeneration: number): void {
    for (const [key, binding] of bindings) {
      if (binding.sessionId === sessionId && binding.workerGeneration === workerGeneration) {
        bindings.delete(key);
      }
    }
  }

  return { bind, resolve, restore, retireWorker, clear: () => bindings.clear() };
}
