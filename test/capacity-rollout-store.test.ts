import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';
import { createCapacityRolloutStore } from '../src/services/capacity-rollout-store.js';

describe('capacity fleet rollout policy', () => {
  it('supports shadow staging, full default-on, unsupported, and app-adapter latches', () => {
    const root = join(process.env.SESSION_DATA_DIR!, `capacity-rollout-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const store = createCapacityRolloutStore(root);

    expect(store.evaluate('app-a', 'traex', true)).toBe('shadow');
    store.setPhase('traex');
    expect(store.evaluate('app-a', 'traex', true)).toBe('enabled');
    expect(store.evaluate('app-a', 'codex', true)).toBe('shadow');
    store.setPhase('full');
    expect(store.evaluate('app-a', 'codex', false)).toBe('unsupported');
    expect(store.evaluate('app-a', 'codex', true)).toBe('enabled');
    store.disable('app-a', 'codex', 'confirmed false positive');
    expect(store.evaluate('app-a', 'codex', true)).toBe('disabled');
    expect(store.evaluate('app-b', 'codex', true)).toBe('enabled');
  });

  it('persists mode 0600 without secret-shaped values', () => {
    const root = join(process.env.SESSION_DATA_DIR!, `capacity-rollout-persist-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    let store = createCapacityRolloutStore(root);
    store.setPhase('proxy');
    store.disable('app-a', 'claude-code', 'provider mismatch');
    chmodSync(store.path, 0o600);
    store = createCapacityRolloutStore(root);

    expect(store.phase()).toBe('proxy');
    expect(store.evaluate('app-a', 'claude-code', true)).toBe('disabled');
    expect(readFileSync(store.path, 'utf8')).not.toMatch(/secret|token|prompt/i);
  });

  it('keeps one app-adapter kill switch isolated across phase changes', () => {
    const root = join(process.env.SESSION_DATA_DIR!, `capacity-rollout-isolation-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const store = createCapacityRolloutStore(root);
    store.setPhase('full');
    store.disable('app-a', 'codex', 'confirmed false positive');

    expect(store.evaluate('app-a', 'codex', true)).toBe('disabled');
    expect(store.evaluate('app-a', 'claude-code', true)).toBe('enabled');
    expect(store.evaluate('app-b', 'codex', true)).toBe('enabled');
    store.setPhase('shadow');
    store.setPhase('full');
    expect(store.evaluate('app-a', 'codex', true)).toBe('disabled');
  });

  it('serializes read-modify-write updates from independent processes', async () => {
    const root = join(process.env.SESSION_DATA_DIR!, `capacity-rollout-rmw-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const moduleUrl = new URL('../src/services/capacity-rollout-store.js', import.meta.url).href;
    const children = Array.from({ length: 6 }, (_, index) => spawnTsEvalWithRepoImports(
      `import { createCapacityRolloutStore } from ${JSON.stringify(moduleUrl)};`
        + `createCapacityRolloutStore(${JSON.stringify(root)}).disable('app-${index}', 'codex', 'reason-${index}');`,
      { stdio: ['ignore', 'ignore', 'pipe'] },
    ));
    const exits = await Promise.all(children.map(child => new Promise<number | null>(resolve => {
      child.once('exit', code => resolve(code));
    })));
    expect(exits).toEqual(Array(children.length).fill(0));

    const snapshot = createCapacityRolloutStore(root).snapshot();
    for (let index = 0; index < children.length; index++) {
      expect(snapshot.disabled).toHaveProperty(JSON.stringify([`app-${index}`, 'codex']));
    }
  });
});
