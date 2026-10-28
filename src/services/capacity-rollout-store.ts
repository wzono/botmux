import { existsSync, lstatSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export type CapacityRolloutPhase = 'shadow' | 'traex' | 'proxy' | 'full' | 'off';
export type CapacityRolloutAdapter = 'traex' | 'codex' | 'claude-code';
export type CapacityRolloutDecision = 'enabled' | 'shadow' | 'unsupported' | 'disabled';

interface State {
  version: 1;
  phase: CapacityRolloutPhase;
  disabled: Record<string, { reason: string; at: string }>;
}

const PHASES = new Set<CapacityRolloutPhase>(['shadow', 'traex', 'proxy', 'full', 'off']);
const keyOf = (appId: string, adapter: CapacityRolloutAdapter) => JSON.stringify([appId, adapter]);

export function createCapacityRolloutStore(dataDir: string) {
  const directory = join(dataDir, 'capacity-feedback');
  const path = join(directory, 'rollout.json');

  function read(): State {
    if (!existsSync(path)) return { version: 1, phase: 'shadow', disabled: {} };
    const leaf = lstatSync(path);
    const info = statSync(path);
    if (leaf.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0) {
      throw new Error('untrusted capacity rollout store');
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as State;
    if (parsed.version !== 1 || !PHASES.has(parsed.phase) || !parsed.disabled
      || typeof parsed.disabled !== 'object' || Array.isArray(parsed.disabled)) {
      throw new Error('invalid capacity rollout store');
    }
    return parsed;
  }

  function write(state: State): void {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    atomicWriteFileSync(path, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600, durable: true, followTargetSymlink: false,
    });
  }

  return {
    path,
    phase: () => read().phase,
    setPhase(phase: CapacityRolloutPhase): void {
      if (!PHASES.has(phase)) throw new Error(`invalid capacity rollout phase: ${phase}`);
      write({ ...read(), phase });
    },
    disable(appId: string, adapter: CapacityRolloutAdapter, reason: string): void {
      const state = read();
      state.disabled[keyOf(appId, adapter)] = { reason, at: new Date().toISOString() };
      write(state);
    },
    enable(appId: string, adapter: CapacityRolloutAdapter): void {
      const state = read();
      delete state.disabled[keyOf(appId, adapter)];
      write(state);
    },
    evaluate(appId: string, adapter: CapacityRolloutAdapter, supported: boolean): CapacityRolloutDecision {
      const state = read();
      if (state.disabled[keyOf(appId, adapter)]) return 'disabled';
      if (!supported) return 'unsupported';
      if (state.phase === 'off' || state.phase === 'shadow') return 'shadow';
      if (state.phase === 'traex') return adapter === 'traex' ? 'enabled' : 'shadow';
      if (state.phase === 'proxy') return adapter === 'traex' || adapter === 'codex' || adapter === 'claude-code'
        ? 'enabled' : 'shadow';
      return 'enabled';
    },
  };
}
