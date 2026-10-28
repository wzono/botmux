import {
  existsSync, lstatSync, readFileSync, realpathSync, rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { readDurableProcessIdentity } from '../../utils/process-identity.js';
import {
  readPluginRegistry,
  writePluginRegistry,
} from '../../services/plugin-registry-store.js';
import { scanPluginContributions } from './convention-scanner.js';
import { materializePlugin } from './materializer.js';
import {
  pluginHome, pluginMaterializedPath, pluginRegistryPath, pluginRuntimeDir, pluginServiceStatePath,
} from './paths.js';
import { loadPluginServiceDefinition } from './runtime.js';
import {
  readPluginServiceState, serviceUrls, withPluginServiceLock,
} from './service-manager.js';
import { readPluginProcesses } from './supervisor-client.js';
import { pluginServiceName } from './supervisor-store.js';
import type { InstalledPluginRecord } from './types.js';

export interface PluginRepairReport {
  pluginId: string;
  action: 'repaired' | 'unchanged' | 'failed';
  warning?: string;
}

type Snapshot = { exists: boolean; bytes?: Buffer };
const snapshot = (path: string): Snapshot => existsSync(path)
  ? { exists: true, bytes: readFileSync(path) }
  : { exists: false };

function restore(path: string, value: Snapshot): void {
  if (!value.exists) {
    rmSync(path, { force: true });
    return;
  }
  atomicWriteFileSync(path, value.bytes!, { mode: 0o600 });
}

function assertRuntimeIdentity(record: InstalledPluginRecord): string {
  const runtime = pluginRuntimeDir(record.id);
  const stat = lstatSync(runtime);
  const actual = realpathSync(runtime);
  if (record.source.link) {
    if (record.source.type !== 'local' || !stat.isSymbolicLink()) {
      throw new Error(`plugin_repair_runtime_identity_mismatch:${record.id}`);
    }
    const expected = realpathSync(join(resolve(record.source.spec), 'dist'));
    if (actual !== expected) throw new Error(`plugin_repair_runtime_identity_mismatch:${record.id}`);
  } else {
    if (stat.isSymbolicLink() || actual !== realpathSync(pluginRuntimeDir(record.id))) {
      throw new Error(`plugin_repair_runtime_identity_mismatch:${record.id}`);
    }
    const root = `${realpathSync(pluginHome(record.id))}/`;
    if (!actual.startsWith(root)) throw new Error(`plugin_repair_runtime_identity_mismatch:${record.id}`);
  }
  return runtime;
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

async function repairOne(pluginId: string, dryRun: boolean): Promise<PluginRepairReport> {
  const registry = readPluginRegistry();
  const record = registry.plugins[pluginId];
  if (!record) throw new Error(`plugin_not_installed:${pluginId}`);
  const runtime = assertRuntimeIdentity(record);
  const scanned = scanPluginContributions(runtime, record.manifest);
  const { mcp: _privateMcp, ...publicScanned } = scanned ?? {};
  const contributions = scanned ? {
    ...publicScanned,
    ...(record.contributions?.mcp ? { mcp: record.contributions.mcp } : {}),
  } : undefined;
  const nextRecord: InstalledPluginRecord = {
    ...record,
    ...(contributions ? { contributions } : { contributions: undefined }),
  };

  const state = readPluginServiceState(pluginId);
  let nextState = state;
  if (record.manifest.service) {
    const definition = await loadPluginServiceDefinition(nextRecord);
    if (!definition) throw new Error(`plugin_service_definition_not_found:${pluginId}`);
    const app = readPluginProcesses().find(proc => proc.name === pluginServiceName(pluginId));
    if (app?.status !== 'online' || typeof app.pid !== 'number' || typeof app.processStart !== 'string'
      || readDurableProcessIdentity(app.pid) !== app.processStart) {
      throw new Error(`plugin_repair_service_identity_invalid:${pluginId}`);
    }
    nextState = {
      ...state,
      pluginId,
      version: record.version,
      runtimeDir: runtime,
      runtimeRealpath: realpathSync(runtime),
      updatedAt: state?.updatedAt ?? record.updatedAt,
      status: app.status,
      pid: app.pid,
      processStart: app.processStart,
      ...serviceUrls(nextRecord, definition),
      processName: app.name,
      supervisor: 'builtin',
    };
  }

  const unchanged = stable(record.contributions) === stable(nextRecord.contributions)
    && stable(state) === stable(nextState);
  if (unchanged || dryRun) return { pluginId, action: unchanged ? 'unchanged' : 'repaired' };

  const paths = [
    pluginMaterializedPath(pluginId), pluginServiceStatePath(pluginId),
  ];
  const beforeRegistry = snapshot(pluginRegistryPath());
  const beforeFiles = paths.map(snapshot);
  try {
    registry.plugins[pluginId] = nextRecord;
    writePluginRegistry(registry);
    materializePlugin(pluginId);
    if (nextState) {
      atomicWriteFileSync(pluginServiceStatePath(pluginId), `${JSON.stringify(nextState, null, 2)}\n`, { mode: 0o600 });
    }
    return { pluginId, action: 'repaired' };
  } catch (error) {
    restore(pluginRegistryPath(), beforeRegistry);
    paths.forEach((path, index) => restore(path, beforeFiles[index]));
    throw error;
  }
}

export async function repairPlugins(
  pluginIds?: readonly string[],
  options: { dryRun?: boolean } = {},
): Promise<PluginRepairReport[]> {
  return withPluginServiceLock(async () => {
    const ids = pluginIds?.length ? [...pluginIds] : Object.keys(readPluginRegistry().plugins).sort();
    const reports: PluginRepairReport[] = [];
    for (const id of ids) {
      try {
        reports.push(await repairOne(id, options.dryRun === true));
      } catch (error) {
        reports.push({
          pluginId: id,
          action: 'failed',
          warning: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return reports;
  });
}
