import {
  existsSync, lstatSync, readFileSync, realpathSync, readdirSync, rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { parsePluginPackageManifest } from './manifest.js';
import { join, resolve } from 'node:path';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { readDurableProcessIdentity } from '../../utils/process-identity.js';
import {
  compareAndSwapInstalledPlugin,
  readPluginRegistry,
  readPluginRegistryWithoutMigration,
  restoreInstalledPluginAfterFailedRepair,
} from '../../services/plugin-registry-store.js';
import { scanPluginContributions } from './convention-scanner.js';
import { materializePlugin, projectMaterializedPlugin } from './materializer.js';
import {
  pluginConfigPath, pluginHome, pluginMaterializedPath, pluginRuntimeDir,
  pluginServiceStatePath, pluginSettingsPath,
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

function restoreAll(paths: readonly string[], values: readonly Snapshot[], pluginId: string): void {
  const errors: unknown[] = [];
  paths.forEach((path, index) => {
    try { restore(path, values[index]); } catch (error) { errors.push(error); }
  });
  if (errors.length > 0) throw new Error(`plugin_repair_rollback_failed:${pluginId}`);
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

const PUBLIC_REPAIR_ERRORS = new Set([
  'plugin_not_installed',
  'plugin_repair_package_identity_mismatch',
  'plugin_repair_package_identity_unavailable',
  'plugin_repair_registry_changed',
  'plugin_repair_rollback_failed',
  'plugin_repair_runtime_identity_mismatch',
  'plugin_repair_service_identity_invalid',
]);

function safeRepairWarning(error: unknown): string {
  if (!(error instanceof Error)) return 'plugin_repair_failed';
  const code = error.message.split(':', 1)[0];
  return PUBLIC_REPAIR_ERRORS.has(code) ? code : 'plugin_repair_failed';
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
  const mutablePaths = [pluginConfigPath(pluginId), pluginSettingsPath(pluginId)];
  const beforeMutable = mutablePaths.map(snapshot);
  let existingMaterialized: Record<string, unknown> | undefined;
  try {
    existingMaterialized = existsSync(pluginMaterializedPath(pluginId))
      ? JSON.parse(readFileSync(pluginMaterializedPath(pluginId), 'utf8'))
      : undefined;
  } catch { existingMaterialized = undefined; }
  const expectedMaterialized = projectMaterializedPlugin(nextRecord);
  const currentComparable = existingMaterialized ? { ...existingMaterialized } : undefined;
  if (currentComparable) delete currentComparable.updatedAt;
  const { updatedAt: _expectedUpdatedAt, ...expectedComparable } = expectedMaterialized;
  const materializedCurrent = stable(currentComparable) === stable(expectedComparable);
  const currentProcess = record.manifest.service
    ? readPluginProcesses().find(proc => proc.name === pluginServiceName(pluginId))
    : undefined;
  const supervisorIdentityValid = !record.manifest.service || (
    currentProcess?.status === 'online'
    && typeof currentProcess.pid === 'number'
    && typeof currentProcess.processStart === 'string'
    && readDurableProcessIdentity(currentProcess.pid) === currentProcess.processStart
  );
  const cachedIdentityCurrent = !record.manifest.service || (
    supervisorIdentityValid
    && state?.status === 'online'
    && state.pid === currentProcess?.pid
    && state.processStart === currentProcess?.processStart
  );
  if (dryRun) {
    const needsRepair = stable(record.contributions) !== stable(nextRecord.contributions)
      || !materializedCurrent
      || !cachedIdentityCurrent
      || (record.manifest.service && typeof state?.host !== 'string');
    return { pluginId, action: needsRepair ? 'repaired' : 'unchanged' };
  }
  let nextState = state;
  if (record.manifest.service) {
    let definition;
    try {
      definition = await loadPluginServiceDefinition(nextRecord, { readOnlyConfig: true });
    } catch (error) {
      restoreAll(mutablePaths, beforeMutable, pluginId);
      throw error;
    }
    const mutated = mutablePaths.some((path, index) => {
      const current = snapshot(path);
      const before = beforeMutable[index];
      return current.exists !== before.exists
        || (current.exists && !current.bytes!.equals(before.bytes!));
    });
    if (mutated) {
      restoreAll(mutablePaths, beforeMutable, pluginId);
      throw new Error(`plugin_repair_config_write_forbidden:${pluginId}`);
    }
    if (!definition) throw new Error(`plugin_service_definition_not_found:${pluginId}`);
    const app = readPluginProcesses().find(proc => proc.name === pluginServiceName(pluginId));
    if (app?.status !== 'online' || typeof app.pid !== 'number' || typeof app.processStart !== 'string'
      || readDurableProcessIdentity(app.pid) !== app.processStart) {
      throw new Error(`plugin_repair_service_identity_invalid:${pluginId}`);
    }
    let urls;
    try {
      urls = serviceUrls(nextRecord, definition);
    } catch (error) {
      restoreAll(mutablePaths, beforeMutable, pluginId);
      throw error;
    }
    const urlsMutated = mutablePaths.some((path, index) => {
      const current = snapshot(path);
      const before = beforeMutable[index];
      return current.exists !== before.exists
        || (current.exists && !current.bytes!.equals(before.bytes!));
    });
    if (urlsMutated) {
      restoreAll(mutablePaths, beforeMutable, pluginId);
      throw new Error(`plugin_repair_config_write_forbidden:${pluginId}`);
    }
    const latestApp = readPluginProcesses().find(proc => proc.name === pluginServiceName(pluginId));
    if (latestApp?.status !== 'online' || latestApp.pid !== app.pid
      || latestApp.processStart !== app.processStart
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
      ...urls,
      processName: app.name,
      supervisor: 'builtin',
    };
  }

  const unchanged = stable(record.contributions) === stable(nextRecord.contributions)
    && stable(state) === stable(nextState)
    && materializedCurrent;
  if (unchanged) return { pluginId, action: 'unchanged' };

  const paths = [pluginMaterializedPath(pluginId), pluginServiceStatePath(pluginId)];
  const beforeFiles = paths.map(snapshot);
  const rollbackPaths = [...paths, ...mutablePaths];
  const rollbackFiles = [...beforeFiles, ...beforeMutable];
  let registryWritten = false;
  try {
    compareAndSwapInstalledPlugin(pluginId, record, nextRecord);
    registryWritten = true;
    materializePlugin(pluginId);
    if (nextState) {
      atomicWriteFileSync(pluginServiceStatePath(pluginId), `${JSON.stringify(nextState, null, 2)}\n`, { mode: 0o600 });
    }
    return { pluginId, action: 'repaired' };
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    if (registryWritten) {
      try { restoreInstalledPluginAfterFailedRepair(pluginId, nextRecord, record); }
      catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    for (const [path, value] of rollbackPaths.map((path, index) => [path, rollbackFiles[index]] as const)) {
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
