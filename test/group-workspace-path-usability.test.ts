import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  probePathUsability,
  type DirectoryEnterProbe,
} from '../src/core/path-usability.js';
import type { TenantHumanId } from '../src/services/bot-admin-unions-store.js';
import {
  GroupWorkspaceStore,
  canonicalTextSourceEventId,
} from '../src/services/group-workspace-store.js';

const ACTOR: TenantHumanId = { tenantKey: 'tenant-a', unionId: 'on_user' };
const CHAT = 'oc_path_probe';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'botmux-path-usability-'));
}

function source(messageId: string): string {
  const result = canonicalTextSourceEventId({ tenantKey: 'tenant-a', chatId: CHAT, messageId });
  if (!result.ok) throw new Error('unexpected source failure');
  return result.sourceEventId;
}

function setMutation(path: string, messageId = 'om_set') {
  return {
    kind: 'set' as const,
    chatId: CHAT,
    sourceEventId: source(messageId),
    requestedWorkingDir: path,
    expectedRevision: 0,
    expectedSessionGeneration: 1,
    actor: ACTOR,
    authorized: true,
    directoryValid: true,
    now: 100,
  };
}

describe('path usability', () => {
  it('normalizes a traversable directory without requiring write access', () => {
    const root = tempDir();
    const target = join(root, 'target');
    mkdirSync(target, { mode: 0o555 });
    try {
      expect(probePathUsability(join(root, '.', 'target', '..', 'target'))).toMatchObject({
        ok: true,
        normalizedPath: resolve(target),
        identity: { dev: expect.any(String), ino: expect.any(String) },
      });
    } finally {
      chmodSync(target, 0o755);
    }
  });

  it('distinguishes a missing path from a regular file', () => {
    const root = tempDir();
    const file = join(root, 'file');
    writeFileSync(file, 'not a directory');
    expect(probePathUsability(join(root, 'missing'))).toEqual({
      ok: false,
      normalizedPath: join(root, 'missing'),
      reason: 'missing',
    });
    expect(probePathUsability(file)).toEqual({
      ok: false,
      normalizedPath: file,
      reason: 'not_directory',
    });
  });

  it('rejects a directory that stat sees but the daemon identity cannot enter', () => {
    const target = tempDir();
    const enterProbe: DirectoryEnterProbe = () => ({ ok: false, code: 'EACCES' });
    expect(probePathUsability(target, { enterProbe })).toEqual({
      ok: false,
      normalizedPath: target,
      reason: 'inaccessible',
    });
  });

  it('reports I/O failures separately from access failures', () => {
    const target = tempDir();
    const enterProbe: DirectoryEnterProbe = () => ({ ok: false, code: 'EIO' });
    expect(probePathUsability(target, { enterProbe })).toEqual({
      ok: false,
      normalizedPath: target,
      reason: 'io_error',
      code: 'EIO',
    });
  });

  it('detects replacement against the identity captured by validation', () => {
    const root = tempDir();
    const target = join(root, 'workspace');
    const replacement = join(root, 'replacement');
    mkdirSync(target);
    mkdirSync(replacement);
    const first = probePathUsability(target);
    if (!first.ok) throw new Error('unexpected initial probe failure');
    rmSync(target, { recursive: true });
    renameSync(replacement, target);
    expect(probePathUsability(target, { expectedIdentity: first.identity })).toEqual({
      ok: false,
      normalizedPath: target,
      reason: 'changed',
    });
  });

  it('probes before set and mandates a separate probe when the binding is consumed', async () => {
    const dataDir = tempDir();
    const target = tempDir();
    const identity = { dev: '1', ino: '2' };
    const probe = vi.fn()
      .mockReturnValueOnce({ ok: true, normalizedPath: target, identity })
      .mockReturnValueOnce({ ok: false, normalizedPath: target, reason: 'inaccessible' });
    const store = new GroupWorkspaceStore(dataDir, { pathProbe: probe });

    expect(await store.mutate(setMutation(target))).toMatchObject({ outcome: 'committed' });
    expect(probe).toHaveBeenCalledTimes(1);
    await expect(store.probeBoundDirectoryForConsumption(CHAT)).resolves.toEqual({
      status: 'unusable',
      record: expect.objectContaining({ revision: 1, directoryIdentity: identity }),
      usability: { ok: false, normalizedPath: target, reason: 'inaccessible' },
    });
    expect(probe).toHaveBeenLastCalledWith(target, { expectedIdentity: identity });
  });

  it('rejects a path replaced between set validation and consumption', async () => {
    const dataDir = tempDir();
    const root = tempDir();
    const target = join(root, 'workspace');
    const replacement = join(root, 'replacement');
    mkdirSync(target);
    mkdirSync(replacement);
    const store = new GroupWorkspaceStore(dataDir);
    expect(await store.mutate(setMutation(target, 'om_replaced'))).toMatchObject({ outcome: 'committed' });

    rmSync(target, { recursive: true });
    renameSync(replacement, target);

    await expect(store.probeBoundDirectoryForConsumption(CHAT)).resolves.toMatchObject({
      status: 'unusable',
      usability: { ok: false, normalizedPath: target, reason: 'changed' },
    });
  });

  it('does not persist a set when the real probe rejects it', async () => {
    const dataDir = tempDir();
    const target = tempDir();
    const store = new GroupWorkspaceStore(dataDir, {
      pathProbe: () => ({ ok: false, normalizedPath: target, reason: 'inaccessible' }),
    });
    const result = await store.mutate(setMutation(target));
    expect(result).toMatchObject({ outcome: 'invalid_dir' });
    if (!('receipt' in result)) throw new Error('expected terminal receipt');
    expect(result.receipt.resultingRevision).toBeUndefined();
    expect(await store.read(CHAT)).toEqual({ status: 'available', record: undefined });
  });
});
