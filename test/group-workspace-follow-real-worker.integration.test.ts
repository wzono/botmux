import type { ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import type { DaemonSession } from '../src/core/types.js';
import {
  resolveGroupWorkspaceFollowTarget,
  runGroupWorkspaceSessionFollow,
} from '../src/core/session-cwd.js';
import { retireWorkerForReplacement } from '../src/core/worker-pool.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';

const children = new Set<ChildProcess>();
const roots = new Set<string>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

async function waitUntil(check: () => boolean, detail: () => string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out: ${detail()}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function fakeCliSource(prompt: string, deliveryFile: string): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
process.stdout.write(${JSON.stringify(prompt)});
let input = '';
process.stdin.on('data', chunk => {
  input += chunk.toString();
  if (!/[\\r\\n]$/.test(input)) return;
  if (input.includes('\\x1b[200~') && !input.includes('\\x1b[201~')) return;
  const text = input.replace(/\\x1b\\[20[01]~/g, '').trim();
  input = '';
  if (text) fs.appendFileSync(${JSON.stringify(deliveryFile)}, process.cwd() + '\\t' + text + '\\n');
  process.stdout.write('\\r\\n' + ${JSON.stringify(prompt)});
});
`;
}

function startWorker(input: {
  root: string; workingDir: string; cliId: 'claude-code' | 'codex'; cliPath: string;
  sessionId: string; generation: number;
}): { child: ChildProcess; messages: WorkerToDaemon[]; logs: string[] } {
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: input.root,
      SESSION_DATA_DIR: join(input.root, 'data'),
      BOTMUX_SESSION_ID: input.sessionId,
      LARK_APP_ID: 'app_follow_real',
      LARK_APP_SECRET: 'test-only',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  child.on('message', raw => messages.push(raw as WorkerToDaemon));
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  child.send({
    type: 'init', sessionId: input.sessionId, chatId: 'oc_follow', rootMessageId: 'oc_follow',
    workingDir: input.workingDir, cliId: input.cliId, cliPathOverride: input.cliPath,
    backendType: 'pty', prompt: '', resume: false, workerGeneration: input.generation,
    larkAppId: 'app_follow_real', larkAppSecret: 'test-only', locale: 'zh',
  } satisfies DaemonToWorker);
  return { child, messages, logs };
}

describe('group workspace follow with real PTY workers', () => {
  it.each(['prepared', 'old_exited', 'persisted', 'spawned'] as const)(
    'recovers a frozen r2 %s journal after unbind without stale-cwd delivery', async phase => {
      const root = mkdtempSync(join(tmpdir(), `botmux-follow-unbind-${phase}-`));
      roots.add(root);
      const oldDir = join(root, 'r1');
      const frozenDir = join(root, 'r2');
      const fallbackDir = join(root, 'fallback');
      const dataDir = join(root, 'data');
      for (const dir of [oldDir, frozenDir, fallbackDir, dataDir]) mkdirSync(dir, { recursive: true });
      const deliveries = join(root, 'deliveries');
      const cliPath = join(root, 'fake-claude');
      writeFileSync(deliveries, '');
      writeFileSync(cliPath, fakeCliSource('❯ ', deliveries));
      chmodSync(cliPath, 0o755);
      const sessionId = `follow-unbind-${phase}`;
      const old = startWorker({ root, workingDir: oldDir, cliId: 'claude-code', cliPath, sessionId, generation: 4 });
      await waitUntil(() => old.messages.some(message => message.type === 'prompt_ready'), () => old.logs.join(''));

      const journal = {
        targetWorkingDir: frozenDir, targetRevision: 2, previousRevision: 1,
        previousGeneration: 4, nextGeneration: 5, phase,
      } as const;
      const session: any = {
        sessionId, chatId: 'oc_follow', rootMessageId: 'oc_follow', status: 'active',
        createdAt: new Date().toISOString(), larkAppId: 'app_follow_real', scope: 'chat',
        cliId: 'claude-code', backendType: 'pty', workingDir: oldDir, workingDirSource: 'group',
        groupWorkspaceRevision: 1, workerGeneration: 4, groupWorkspaceFollow: { ...journal },
      };
      const ds = {
        session, worker: old.child, workerPort: null, workerToken: null, larkAppId: 'app_follow_real',
        chatId: 'oc_follow', chatType: 'group', scope: 'chat', spawnedAt: Date.now(),
        lastMessageAt: Date.now(), hasHistory: false, workingDir: oldDir, initConfig: { backendType: 'pty' },
        workerGeneration: 4, workerReady: true, cliReady: true, lastScreenStatus: 'idle',
      } as unknown as DaemonSession;
      let liveWorkers = 1;
      let current = old;
      if (phase === 'old_exited' || phase === 'persisted' || phase === 'spawned') {
        await retireWorkerForReplacement(ds, { timeoutMs: 5_000 });
        liveWorkers = 0;
      }
      if (phase === 'persisted' || phase === 'spawned') {
        session.workingDir = frozenDir;
        session.groupWorkspaceRevision = 2;
        ds.workingDir = frozenDir;
      }
      if (phase === 'spawned') {
        session.workerGeneration = 5;
        ds.workerGeneration = 5;
        current = startWorker({ root, workingDir: frozenDir, cliId: 'claude-code', cliPath, sessionId, generation: 5 });
        ds.worker = current.child;
        ds.workerReady = false;
        ds.cliReady = false;
        await waitUntil(() => current.messages.some(message => message.type === 'prompt_ready'), () => current.logs.join(''));
        ds.workerReady = true;
        ds.cliReady = true;
      }

      const resolution = resolveGroupWorkspaceFollowTarget({
        journal: session.groupWorkspaceFollow,
        group: { status: 'available', record: { revision: 3, directory: { kind: 'unbound' } } },
      });
      expect(resolution).toEqual({ kind: 'follow', target: { workingDir: frozenDir, revision: 2 } });
      if (resolution.kind !== 'follow') throw new Error('journal target was not recovered');
      const result = await runGroupWorkspaceSessionFollow(ds, resolution.target, {
        isIdle: () => true,
        supportsReplacement: () => true,
        isWorkerLive: candidate => !!candidate.worker && !candidate.worker.killed,
        persist: mutation => {
          if (mutation.source && mutation.workingDir) {
            session.workingDir = mutation.workingDir;
            session.workingDirSource = mutation.source;
            session.groupWorkspaceRevision = mutation.groupWorkspaceRevision;
            ds.workingDir = mutation.workingDir;
          }
          if (mutation.workerGeneration !== undefined) session.workerGeneration = mutation.workerGeneration;
          session.groupWorkspaceFollow = mutation.journal;
        },
        retire: async candidate => {
          const retired = await retireWorkerForReplacement(candidate, { timeoutMs: 5_000 });
          if (retired) liveWorkers = 0;
          return retired;
        },
        spawn: (candidate, reserved) => {
          if (liveWorkers > 0) throw new Error('overlapping workers');
          session.workerGeneration = (session.workerGeneration ?? 0) + 1;
          candidate.workerGeneration = session.workerGeneration;
          reserved(session.workerGeneration);
          current = startWorker({ root, workingDir: candidate.workingDir, cliId: 'claude-code', cliPath,
            sessionId, generation: session.workerGeneration });
          candidate.worker = current.child;
          candidate.workerReady = false;
          candidate.cliReady = false;
          liveWorkers = 1;
          return true;
        },
        awaitReady: async candidate => {
          await waitUntil(() => current.messages.some(message => message.type === 'prompt_ready'), () => current.logs.join(''));
          candidate.workerReady = true;
          candidate.cliReady = true;
          return { ready: true, workingDir: candidate.workingDir };
        },
        notice: () => undefined,
      });

      expect(result).toEqual({ kind: 'migrated' });
      expect(session.groupWorkspaceFollow).toBeUndefined();
      expect(liveWorkers).toBeLessThanOrEqual(1);
      expect(readFileSync(deliveries, 'utf8')).toBe('');
      current.child.send({ type: 'message', content: 'AFTER_RECOVERY', turnId: `om_${phase}` } satisfies DaemonToWorker);
      await waitUntil(() => readFileSync(deliveries, 'utf8').includes('AFTER_RECOVERY'), () => current.logs.join(''));
      const delivered = readFileSync(deliveries, 'utf8');
      expect(delivered).not.toContain(`${realpathSync(oldDir)}\tAFTER_RECOVERY`);
      expect(delivered).toContain(`${realpathSync(frozenDir)}\tAFTER_RECOVERY`);
      expect(resolveGroupWorkspaceFollowTarget({
        group: { status: 'available', record: { revision: 3, directory: { kind: 'unbound' } } },
        currentRevision: session.groupWorkspaceRevision,
      })).toEqual({ kind: 'continue' });
      // The unbound policy is consulted only by future sessions; this recovered
      // persisted session remains safely frozen at r2 rather than silently
      // switching to the fallback directory mid-session.
      expect(session.workingDir).toBe(frozenDir);
      expect(session.workingDir).not.toBe(fallbackDir);
    }, 60_000,
  );

  it.each([
    ['claude-code', '❯ '] as const,
    ['codex', '› '] as const,
  ])('retires %s, starts in the new cwd, and delivers the business turn once', async (cliId, prompt) => {
    const root = mkdtempSync(join(tmpdir(), `botmux-follow-${cliId}-`));
    roots.add(root);
    const oldDir = join(root, 'old');
    const newDir = join(root, 'new');
    const dataDir = join(root, 'data');
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    const deliveries = join(root, 'deliveries');
    const cliPath = join(root, cliId === 'codex' ? 'fake-codex' : 'fake-claude');
    writeFileSync(deliveries, '');
    writeFileSync(cliPath, fakeCliSource(prompt, deliveries));
    chmodSync(cliPath, 0o755);
    const sessionId = `follow-${cliId}`;
    const old = startWorker({ root, workingDir: oldDir, cliId, cliPath, sessionId, generation: 1 });
    await waitUntil(() => old.messages.some(message => message.type === 'prompt_ready'), () => old.logs.join(''));

    const ds = {
      session: {
        sessionId, chatId: 'oc_follow', rootMessageId: 'oc_follow', status: 'active',
        createdAt: new Date().toISOString(), larkAppId: 'app_follow_real', scope: 'chat',
        cliId, backendType: 'pty', workingDir: oldDir, workingDirSource: 'group',
        groupWorkspaceRevision: 1, workerGeneration: 1,
      },
      worker: old.child, workerPort: null, workerToken: null, larkAppId: 'app_follow_real',
      chatId: 'oc_follow', chatType: 'group', scope: 'chat', spawnedAt: Date.now(),
      lastMessageAt: Date.now(), hasHistory: false, workingDir: oldDir, initConfig: { backendType: 'pty' },
      workerGeneration: 1, workerReady: true, cliReady: true, lastScreenStatus: 'idle',
    } as unknown as DaemonSession;
    let current = old;
    const order: string[] = [];
    const result = await runGroupWorkspaceSessionFollow(ds, { workingDir: newDir, revision: 2 }, {
      isIdle: () => true,
      supportsReplacement: () => true,
      isWorkerLive: candidate => !!candidate.worker && !candidate.worker.killed,
      persist: mutation => {
        if (mutation.source && mutation.workingDir) {
          ds.session.workingDir = mutation.workingDir;
          ds.session.workingDirSource = mutation.source;
          ds.session.groupWorkspaceRevision = mutation.groupWorkspaceRevision;
          ds.workingDir = mutation.workingDir;
        }
        ds.session.groupWorkspaceFollow = mutation.journal;
      },
      retire: async candidate => {
        order.push('retire');
        return retireWorkerForReplacement(candidate, { timeoutMs: 5_000 });
      },
      spawn: (candidate, reserved) => {
        order.push('spawn');
        candidate.session.workerGeneration = 2;
        candidate.workerGeneration = 2;
        reserved(2);
        current = startWorker({ root, workingDir: newDir, cliId, cliPath, sessionId, generation: 2 });
        candidate.worker = current.child;
        candidate.workerReady = false;
        candidate.cliReady = false;
        return true;
      },
      awaitReady: async candidate => {
        await waitUntil(() => current.messages.some(message => message.type === 'prompt_ready'), () => current.logs.join(''));
        candidate.workerReady = true;
        candidate.cliReady = true;
        return { ready: true, workingDir: candidate.workingDir };
      },
      notice: () => undefined,
    });

    expect(result).toEqual({ kind: 'migrated' });
    expect(order).toEqual(['retire', 'spawn']);
    expect(old.child.exitCode ?? old.child.signalCode).not.toBeNull();
    current.child.send({ type: 'message', content: 'DELIVER_ONCE', turnId: 'om_follow_once' } satisfies DaemonToWorker);
    await waitUntil(() => readFileSync(deliveries, 'utf8').includes('DELIVER_ONCE'), () => current.logs.join(''));
    const delivered = readFileSync(deliveries, 'utf8');
    expect(delivered.match(/DELIVER_ONCE/g)).toHaveLength(1);
    expect(delivered.startsWith(`${realpathSync(newDir)}\tDELIVER_ONCE`)).toBe(true);
  }, 60_000);
});
