/**
 * `botmux dispatch` inside a Linux credential-only pane, driven to "the task
 * was actually sent" for every command shape the built-in botmux-orchestrate
 * and handoff skills use (see helpers/credential-only-dispatch-harness.ts for
 * what is real and what is faked).
 *
 * The pane has two partial paths and must route by shape:
 *  · `--bot-app` forms → host relay (the host sets up chat grants with the
 *    `.dashboard-secret` this pane cannot read);
 *  · `--bot` / `--repo` / `--standby` forms → direct (the relay refuses them;
 *    their direct path needs no masked secret).
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { probeHostCredentialIsolationMechanism } from '../src/adapters/backend/sandbox.js';
import { resolveNodeBinary, runCredentialOnlyDispatch } from './helpers/credential-only-dispatch-harness.js';

const repoRoot = join(__dirname, '..');
const bwrapLookup = spawnSync('sh', ['-c', 'command -v bwrap'], { encoding: 'utf8' });
const bwrap = bwrapLookup.status === 0 ? String(bwrapLookup.stdout ?? '').trim() : '';
const node = process.platform === 'linux' ? resolveNodeBinary() : null;
const canRun = process.platform === 'linux' && bwrap.startsWith('/') && !!node
  && existsSync(join(repoRoot, 'dist', 'cli.js'))
  && (() => {
    const probe = probeHostCredentialIsolationMechanism();
    return probe.supported && probe.mechanism === 'bwrap';
  })();

type Expect = { path: 'relay' | 'direct'; sent: 'delivered' | 'standby' };
const shapes: Array<[string, string[], Expect]> = [
  ['orchestrate new topic: --bot ×2 --repo --brief-file',
    ['--title', '子项目', '--bot', 'ou_coder:coder:coder', '--bot', 'ou_reviewer:reviewer:reviewer',
      '--repo', '<ROOT>', '--brief-file', '<ROOT>/brief.md'],
    { path: 'direct', sent: 'delivered' }],
  ['orchestrate append / standby activation: --into --bot',
    ['--into', 'om_child_root', '--bot', 'ou_coder:coder', '--brief', 'follow-up'],
    { path: 'direct', sent: 'delivered' }],
  ['orchestrate standby: --bot --repo --standby',
    ['--title', '子项目', '--bot', 'ou_coder:coder', '--repo', '<ROOT>', '--standby'],
    { path: 'direct', sent: 'standby' }],
  ['orchestrate delegated schedule: --bot-app --delegate schedule:create',
    ['--title', '子项目', '--bot-app', 'cli_target', '--delegate', 'schedule:create', '--brief', 'task'],
    { path: 'relay', sent: 'delivered' }],
  ['handoff append: --into --bot-app',
    ['--into', 'om_child_root', '--bot-app', 'cli_target', '--brief', 'next step'],
    { path: 'relay', sent: 'delivered' }],
  ['managed cross-bot dispatch: --chat-id --bot-app --title',
    ['--chat-id', 'oc_src', '--bot-app', 'cli_target', '--title', '子任务', '--brief', 'task'],
    { path: 'relay', sent: 'delivered' }],
];

describe('credential-only pane: botmux dispatch reaches the target for every skill shape', () => {
  it.skipIf(!canRun).each(shapes)('%s', async (_label, dispatchArgs, expected) => {
    const r = await runCredentialOnlyDispatch({ repoRoot, bwrap, node: node!, dispatchArgs });
    const context = `${r.stderr}\n${r.stdout}\n${JSON.stringify(r.daemonCalls.map(c => c.url))}`;
    expect(r.stderr, context).not.toContain('ROUTING_NOT_SUPPORTED');
    expect(r.stderr, context).not.toContain('.dashboard-secret');
    expect(r.path, context).toBe(expected.path);
    if (expected.sent === 'delivered') {
      // The daemon received the kickoff delivery: the task was actually sent.
      expect(r.delivered, context).toBe(true);
    } else {
      // --standby sends no brief: the seed topic is created and every bot is
      // primed into its repo via a real message.
      expect(r.registered, context).toBe(true);
      expect(r.larkReplies, context).toBeGreaterThan(0);
      expect(r.delivered, context).toBe(false);
    }
    if (expected.path === 'direct') {
      // Every daemon call authenticated with the pane's managed-origin capability.
      expect(r.daemonCalls.length, context).toBeGreaterThan(0);
      expect(r.daemonCalls.every(call => call.viaCapability && !call.viaHostAuth), context).toBe(true);
      expect(r.code, context).toBe(0);
    } else {
      // The host performed the talk-only grants the pane cannot.
      expect(r.daemonCalls.filter(call => call.url === '/api/grants/chat' && call.viaHostAuth).length, context)
        .toBeGreaterThan(0);
      // The harness grants no acceptance window and no target session exists,
      // so the receipt reports the sent task as not (yet) accepted.
      expect(r.stdout, context).toContain('"taskSent":true');
    }
  }, 120_000);

  it.skipIf(!canRun)('refuses --bot-app mixed with a direct-only option before any side effect', async () => {
    const r = await runCredentialOnlyDispatch({
      repoRoot, bwrap, node: node!,
      dispatchArgs: ['--title', '子项目', '--bot-app', 'cli_target', '--bot', 'ou_coder:coder', '--brief', 'task'],
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('ROUTING_NOT_SUPPORTED');
    expect(r.stderr).toContain('--bot');
    expect(r.daemonCalls).toHaveLength(0);
  }, 120_000);

  it.skipIf(!canRun)('a relay-only (full-sandbox shaped) pane keeps refusing --bot and still relays --bot-app', async () => {
    const refused = await runCredentialOnlyDispatch({
      repoRoot, bwrap, node: node!, dropScopeMarker: true,
      dispatchArgs: ['--into', 'om_child_root', '--bot', 'ou_coder:coder', '--brief', 'follow-up'],
    });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('ROUTING_NOT_SUPPORTED');
    expect(refused.daemonCalls).toHaveLength(0);
    const relayed = await runCredentialOnlyDispatch({
      repoRoot, bwrap, node: node!, dropScopeMarker: true,
      dispatchArgs: ['--into', 'om_child_root', '--bot-app', 'cli_target', '--brief', 'next step'],
    });
    expect(relayed.path).toBe('relay');
    expect(relayed.delivered).toBe(true);
  }, 240_000);
});
