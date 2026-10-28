import {
  existsSync, lstatSync, readFileSync, realpathSync, readdirSync, rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { parsePluginPackageManifest } from './manifest.js';
import { join, resolve } from 'node:path';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { readDurableProcessIdentity } from '../../utils/process-identity.js';
import {
  readPluginRegistry,
  readPluginRegistryWithoutMigration,
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

function runtimeIdentity(runtime: string): string {
  const hash = createHash('sha256');
  const visit = (dir: string, rel = ''): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const child = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('plugin_repair_runtime_identity_mismatch');
      if (stat.isDirectory()) visit(path, child);
      else if (stat.isFile()) hash.update(child).update('\0').update(readFileSync(path));
    }
  };
  visit(runtime);
  return hash.digest('hex');
}

function materializedProjection(record: InstalledPluginRecord): Record<string, unknown> {
  return {
    schemaVersion: 1,
    pluginId: record.id,
    ...(record.contributions?.cli?.commands?.length
      ? { cli: record.contributions.cli.commands.map(command => ({ name: command.name })) }
      : {}),
    ...(record.contributions?.dashboard?.length
      ? { dashboard: record.contributions.dashboard.map(entry => ({ id: entry.id, entry: entry.entry })) }
      : {}),
    ...(record.contributions?.service ? { service: [{ name: record.id }] } : {}),
    ...(record.contributions?.serviceHttp ? { serviceHttp: record.contributions.serviceHttp } : {}),
    ...(record.contributions?.cardActions ? { cardActions: record.contributions.cardActions } : {}),
  };
}

function safeRepairWarning(error: unknown): string {
  if (!(error instanceof Error)) return 'plugin_repair_failed';
  const match = error.message.match(/^(plugin_[a-z0-9_]+)/);
  return match?.[1] ?? 'plugin_repair_failed';
}

async function repairOne(pluginId: string, dryRun: boolean): Promise<PluginRepairReport> {
  const registry = dryRun ? readPluginRegistryWithoutMigration() : readPluginRegistry();
  const record = registry.plugins[pluginId];
  if (!record) throw new Error(`plugin_not_installed:${pluginId}`);
  const runtime = assertRuntimeIdentity(record);
  if (record.source.type !== 'local') {
    throw new Error(`plugin_repair_package_identity_unavailable:${record.id}`);
  }
  const sourceRoot = resolve(record.source.spec);
  const packageFile = join(sourceRoot, 'package.json');
  const sourceRuntime = join(sourceRoot, 'dist');
  if (!existsSync(packageFile) || !existsSync(sourceRuntime)) {
    throw new Error(`plugin_repair_package_identity_mismatch:${record.id}`);
  }
  const pkg = parsePluginPackageManifest(JSON.parse(readFileSync(packageFile, 'utf8')));
  if (pkg.name !== record.packageName || pkg.version !== record.version || pkg.botmux.id !== record.id
    || (!record.source.link && runtimeIdentity(runtime) !== runtimeIdentity(sourceRuntime))) {
    throw new Error(`plugin_repair_package_identity_mismatch:${record.id}`);
  }
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
    const definition = await loadPluginServiceDefinition(nextRecord, { readOnlyConfig: true });
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

  let materialized: Record<string, unknown> | undefined;
  try {
    materialized = existsSync(pluginMaterializedPath(pluginId))
      ? JSON.parse(readFileSync(pluginMaterializedPath(pluginId), 'utf8'))
      : undefined;
  } catch { materialized = undefined; }
  const expectedMaterialized = materializedProjection(nextRecord);
  const currentMaterialized = materialized ? { ...materialized } : undefined;
  if (currentMaterialized) delete currentMaterialized.updatedAt;
  const materializedCurrent = stable(currentMaterialized) === stable(expectedMaterialized);
  const unchanged = stable(record.contributions) === stable(nextRecord.contributions)
    && stable(state) === stable(nextState)
    && materializedCurrent;
  if (unchanged || dryRun) return { pluginId, action: unchanged ? 'unchanged' : 'repaired' };

  const paths = [
    pluginMaterializedPath(pluginId), pluginServiceStatePath(pluginId),
  ];
  const beforeRegistry = snapshot(pluginRegistryPath());
  const beforeFiles = paths.map(snapshot);
  let registryWritten = false;
  try {
    const currentRegistry = readPluginRegistry();
    if (stable(currentRegistry.plugins[pluginId]) !== stable(record)) {
      throw new Error(`plugin_repair_registry_changed:${pluginId}`);
    }
    currentRegistry.plugins[pluginId] = nextRecord;
    writePluginRegistry(currentRegistry);
    registryWritten = true;
    materializePlugin(pluginId);
    if (nextState) {
      atomicWriteFileSync(pluginServiceStatePath(pluginId), `${JSON.stringify(nextState, null, 2)}\n`, { mode: 0o600 });
    }
    return { pluginId, action: 'repaired' };
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const [path, value] of [
      ...(registryWritten ? [[pluginRegistryPath(), beforeRegistry] as const] : []),
      ...paths.map((path, index) => [path, beforeFiles[index]] as const),
    ] as const) {
      try { restore(path, value); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (rollbackErrors.length > 0) throw new Error(`plugin_repair_rollback_failed:${pluginId}`);
    throw error;
  }
}

export async function repairPlugins(
  pluginIds?: readonly string[],
  options: { dryRun?: boolean } = {},
): Promise<PluginRepairReport[]> {
  return withPluginServiceLock(async () => {
    const registry = options.dryRun ? readPluginRegistryWithoutMigration() : readPluginRegistry();
    const ids = pluginIds?.length ? [...pluginIds] : Object.keys(registry.plugins).sort();
    const reports: PluginRepairReport[] = [];
    for (const id of ids) {
      try {
        reports.push(await repairOne(id, options.dryRun === true));
      } catch (error) {
        reports.push({
          pluginId: id,
          action: 'failed',
          warning: safeRepairWarning(error),
        });
      }
    }
    return reports;
  });
}
