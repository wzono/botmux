import { describe, expect, it } from 'vitest';
import { createCapacitySidebandRuntime, type CapacitySidebandBinding } from '../src/services/capacity-sideband-runtime.js';

function binding(patch: Partial<CapacitySidebandBinding> = {}): CapacitySidebandBinding {
  return {
    adapter: 'codex', sessionId: 'session-a', turnId: 'turn-a',
    dispatchAttempt: 1, workerGeneration: 2, nativeTurnId: 'native-a',
    ...patch,
  };
}

describe('owner-scoped sideband runtime', () => {
  it('binds Codex by native turn and Claude by native session plus prompt', () => {
    const runtime = createCapacitySidebandRuntime();
    const codex = binding();
    const claude = binding({
      adapter: 'claude-code', nativeTurnId: 'prompt-a', nativeSessionId: 'claude-a',
    });
    expect(runtime.bind(codex)).toBe(true);
    expect(runtime.bind(claude)).toBe(true);
    expect(runtime.resolve({ adapter: 'codex', nativeTurnId: 'native-a' })).toEqual(codex);
    expect(runtime.resolve({ adapter: 'claude-code', nativeTurnId: 'prompt-a', nativeSessionId: 'claude-a' }))
      .toEqual(claude);
    expect(runtime.resolve({ adapter: 'claude-code', nativeTurnId: 'prompt-a', nativeSessionId: 'claude-b' }))
      .toBeUndefined();
  });

  it('rejects foreign active ownership and stale attempt/generation replacement', () => {
    const runtime = createCapacitySidebandRuntime();
    const first = binding();
    expect(runtime.bind(first)).toBe(true);
    expect(runtime.bind(binding({ sessionId: 'session-b', turnId: 'turn-b' }))).toBe(false);
    expect(runtime.bind(binding({ dispatchAttempt: 0, workerGeneration: 1 }))).toBe(false);
    expect(runtime.resolve({ adapter: 'codex', nativeTurnId: 'native-a' })).toEqual(first);
  });

  it('restores persisted bindings and retires only the exact worker generation', () => {
    const runtime = createCapacitySidebandRuntime();
    const first = binding();
    runtime.restore(first);
    runtime.retireWorker('session-a', 1);
    expect(runtime.resolve({ adapter: 'codex', nativeTurnId: 'native-a' })).toEqual(first);
    runtime.retireWorker('session-a', 2);
    expect(runtime.resolve({ adapter: 'codex', nativeTurnId: 'native-a' })).toBeUndefined();
  });

  it('does not resolve a binding that is no longer live', () => {
    let active = true;
    const runtime = createCapacitySidebandRuntime(() => active);
    const first = binding();
    expect(runtime.bind(first)).toBe(true);
    active = false;

    expect(runtime.resolve({ adapter: 'codex', nativeTurnId: 'native-a' })).toBeUndefined();
  });
});
