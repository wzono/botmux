import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pluginMaterializedPath, pluginRegistryPath, pluginRuntimeDir, pluginServiceStatePath } from '../src/core/plugins/paths.js';
import { repairPlugins } from '../src/core/plugins/repair.js';

vi.mock('../src/core/plugins/supervisor-client.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/core/plugins/supervisor-client.js')>();
  return {
    ...original,
    readPluginProcesses: () => [{
      name: 'botmux-plugin-demo', status: 'online', pid: process.pid,
      processStart: 'test-process-start',
    }],
  };
});
vi.mock('../src/utils/process-identity.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/utils/process-identity.js')>();
  return { ...original, readDurableProcessIdentity: () => 'test-process-start' };
});

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'plugin-repair-'));
  vi.stubEnv('HOME', home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function legacyFixture() {
  const runtime = pluginRuntimeDir('demo');
  mkdirSync(join(runtime, 'service'), { recursive: true });
  writeFileSync(join(home, '.botmux', 'plugins', 'demo', 'package.json'), JSON.stringify({
    name: '@botmux/plugin-demo', version: '1.0.0', keywords: ['botmux-plugin'],
    botmux: { schemaVersion: 1, id: 'demo', service: { mode: 'auto' } },
  }));
  mkdirSync(join(runtime, 'service-http'), { recursive: true });
  mkdirSync(join(runtime, 'dashboard'), { recursive: true });
  writeFileSync(join(runtime, 'dashboard', 'index.js'), 'export default {}');
  writeFileSync(join(runtime, 'service-http', 'index.json'), JSON.stringify({
    schemaVersion: 1, routes: [{ method: 'GET', path: '/api/snapshot' }],
  }));
  writeFileSync(join(runtime, 'service', 'index.js'), `export default {
    port: 43210,
    pm2: { script: 'service/server.js', env: { HOST: '127.0.0.1' } }
  };`);
  writeFileSync(join(runtime, 'service', 'server.js'), 'setInterval(() => {}, 1000);');
  const now = '2026-10-28T00:00:00.000Z';
  mkdirSync(join(home, '.botmux'), { recursive: true });
  writeFileSync(pluginRegistryPath(), JSON.stringify({ schemaVersion: 1, plugins: { demo: {
    id: 'demo', packageName: '@botmux/plugin-demo', version: '1.0.0',
    source: { type: 'local', spec: '/original/source' },
    manifest: { schemaVersion: 1, id: 'demo', service: { mode: 'auto' } },
    contributions: {
      dashboard: [{ id: 'demo', entry: 'dashboard/index.js' }],
      service: { entry: 'service/index.js', mode: 'auto' },
    }, installedAt: now, updatedAt: now,
  } } }, null, 2));
  writeFileSync(pluginMaterializedPath('demo'), JSON.stringify({
    schemaVersion: 1, pluginId: 'demo', dashboard: [{ id: 'demo', entry: 'dashboard/index.js' }],
    service: [{ name: 'demo' }], updatedAt: now,
  }, null, 2));
  writeFileSync(pluginServiceStatePath('demo'), JSON.stringify({
    pluginId: 'demo', status: 'online', port: 43210, updatedAt: now,
  }, null, 2));
}

describe('plugin repair', () => {
  it('migrates a real legacy registry/materialized/state fixture without replacing content or process', async () => {
    legacyFixture();
    const runtimeBefore = readFileSync(join(pluginRuntimeDir('demo'), 'service', 'server.js'), 'utf8');

    await expect(repairPlugins(['demo'])).resolves.toEqual([{ pluginId: 'demo', action: 'repaired' }]);
    const registry = JSON.parse(readFileSync(pluginRegistryPath(), 'utf8'));
    const materialized = JSON.parse(readFileSync(pluginMaterializedPath('demo'), 'utf8'));
    const state = JSON.parse(readFileSync(pluginServiceStatePath('demo'), 'utf8'));
    expect(registry.plugins.demo.contributions.serviceHttp.routes).toEqual([
      { method: 'GET', path: '/api/snapshot' },
    ]);
    expect(materialized.serviceHttp).toEqual(registry.plugins.demo.contributions.serviceHttp);
    expect(state).toMatchObject({
      host: '127.0.0.1', port: 43210, pid: process.pid, processStart: 'test-process-start',
    });
    expect(readFileSync(join(pluginRuntimeDir('demo'), 'service', 'server.js'), 'utf8')).toBe(runtimeBefore);
    await expect(repairPlugins(['demo'])).resolves.toEqual([{ pluginId: 'demo', action: 'unchanged' }]);
  });

  it('dry-run reports repair without changing exact legacy bytes', async () => {
    legacyFixture();
    const before = [pluginRegistryPath(), pluginMaterializedPath('demo'), pluginServiceStatePath('demo')]
      .map(path => readFileSync(path));
    await expect(repairPlugins(['demo'], { dryRun: true }))
      .resolves.toEqual([{ pluginId: 'demo', action: 'repaired' }]);
    const after = [pluginRegistryPath(), pluginMaterializedPath('demo'), pluginServiceStatePath('demo')]
      .map(path => readFileSync(path));
    expect(after).toEqual(before);
  });
});
