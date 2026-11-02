import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', () => require('memfs').fs);
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../src/config.js', () => ({
  config: { web: { externalHost: 'localhost' }, session: { dataDir: '/adaptive-response-test' }, daemon: { backendType: 'pty', cliId: 'claude-code' } },
}));
const state = vi.hoisted(() => ({ delivery: 'send' }));
vi.mock('../src/bot-registry.js', () => ({
  getBot: () => ({ config: { larkAppId: 'app1', cliId: 'claude-code', envelopeInjection: 'auto' } }),
  getAllBots: () => [], resolveReplyDelivery: () => state.delivery, getOwnerOpenId: () => undefined,
}));
vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: vi.fn(), killStalePids: vi.fn(), sweepDeadPidMarkers: vi.fn(), getActiveSessionsRegistry: () => undefined, getCurrentCliVersion: () => '1.0.0',
}));
vi.mock('../src/services/session-store.js', () => ({
  getSession: () => undefined, registerSessionBridgeSendMarkerCleanupFence: vi.fn(), cleanupSessionBridgeSendMarkers: vi.fn(), cleanupSessionBridgeSendMarkersNow: vi.fn(), createSession: vi.fn(), updateSession: vi.fn(),
}));
vi.mock('../src/adapters/hook-installer.js', () => ({ hasInstalledPromptHookCached: () => true }));

import { mkdirSync, writeFileSync } from 'node:fs';
import { vol } from 'memfs';
import { buildFollowUpCliInput } from '../src/core/session-manager.js';
import { makeSubmitFingerprint } from '../src/adapters/cli/claude-code.js';
import { findJsonlContainingFingerprint } from '../src/services/claude-transcript.js';
import { claimPromptContext, fingerprintPromptText, prefixOf } from '../src/services/prompt-context-store.js';

const options = {
  larkAppId: 'app1', chatId: 'oc_test', sessionBackendType: 'pty' as const,
  turnId: 'turn-1', locale: 'zh' as const, cliId: 'claude-code' as const,
  sender: { type: 'user' as const, openId: 'ou_test', name: 'Tester' },
};

function followup(text: string) {
  return buildFollowUpCliInput(text, 'session-1', options).content;
}

beforeEach(() => {
  vol.reset();
  state.delivery = 'send';
});

describe('adaptive response contract fingerprint isolation', () => {
  it('keeps different hook user requests distinct', () => {
    expect(makeSubmitFingerprint(followup('delete temporary file A')))
      .not.toBe(makeSubmitFingerprint(followup('inspect report B')));
  });

  it('does not let a sibling transcript confirm a different request', () => {
    const first = followup('delete temporary file A');
    const second = followup('inspect report B');
    mkdirSync('/sibling', { recursive: true });
    writeFileSync('/sibling/a.jsonl', JSON.stringify({
      type: 'user', timestamp: new Date().toISOString(),
      message: { role: 'user', content: first },
    }) + '\n');

    expect(findJsonlContainingFingerprint('/sibling', makeSubmitFingerprint(second)!, {
      minEventTimestampMs: Date.now() - 60_000,
    })).toBeNull();
  });

  it('does not claim a same-turn envelope after user content changes', () => {
    const first = followup('delete temporary file A');
    const second = first.replace('delete temporary file A', 'inspect report B');
    expect(claimPromptContext('session-1', 'turn-1', fingerprintPromptText(second), prefixOf(second)))
      .toBeUndefined();
  });

  it('keeps user text first for solo transcript input', () => {
    state.delivery = 'transcript';
    const content = buildFollowUpCliInput('inspect report B', 'session-1', {
      ...options,
      solo: true,
      turnId: undefined,
    }).content;
    expect(content.startsWith('inspect report B')).toBe(true);
    expect(content).toContain('<botmux_response_style>');
  });
});
