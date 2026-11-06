import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { hasEmptyCodexComposer, parseCodexEffortMenu } from '../src/utils/codex-effort-menu.js';
import { stripAnsiScreenText } from '../src/utils/idle-detector.js';

// Exercise the production input boundaries without starting worker.ts's IPC server.
const parsed = ts.createSourceFile('worker.ts', readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function evaluate<T>(name: string, state: Record<string, any>): T {
  const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration) throw new Error(`Missing worker function: ${name}`);
  const forkGate = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'nativeSessionForkPending');
  if (!forkGate) throw new Error('Missing native fork input gate');
  const code = ts.transpileModule(`${forkGate.getText(parsed)}\n${declaration.getText(parsed)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function('state', `with (state) { ${code}; return ${name}; }`)(state) as T;
}

describe('Codex effort menu input ownership', () => {
  it.each(['handleTuiKeys', 'handleTuiTextInput', 'handleTermAction'])(
    '%s never forwards input to a CLI replaced during menu cancellation', async name => {
      let release!: () => void;
      const cancelled = new Promise<void>(resolve => { release = resolve; });
      const state = {
        lastInitConfig: null,
        backend: {}, cliAdapter: {}, cliLifetimeNonce: 1,
        codexCliEffortOperation: {}, cancelCodexCliEffort: vi.fn(() => cancelled),
        effectiveBackendType: 'pty', isRemoteBackendType: () => false,
      };
      const handler = evaluate<(...args: any[]) => Promise<unknown>>(name, state);
      const result = handler(...(name === 'handleTermAction' ? ['enter'] : [['Enter'], 'user input']));
      expect(state.cancelCodexCliEffort).toHaveBeenCalledOnce();
      // No replacement write functions are supplied: reaching one fails the test.
      state.backend = {};
      release();
      expect(await result).toBe(name === 'handleTermAction' ? undefined : false);
    },
  );

  it('rechecks the terminal workspace fence after async effort cancellation', async () => {
    let release!: () => void;
    const cancelled = new Promise<void>(resolve => { release = resolve; });
    let current = true;
    const write = vi.fn(() => true);
    const state = {
      lastInitConfig: null, backend: { write }, cliAdapter: {}, cliLifetimeNonce: 1,
      codexCliEffortOperation: {}, cancelCodexCliEffort: vi.fn(() => cancelled),
      effectiveBackendType: 'pty', isRemoteBackendType: () => false,
      canWriteTerminalBytes: () => current,
      isCriticalInterruptKey: () => false,
      runAfterAmbiguousSubmissionWrites: async (_backend: unknown, submit: () => unknown) => submit(),
      sendTermActionOnce: (target: { write(data: string): boolean }) => target.write('\r'),
      scheduleOneShotAfterAction: vi.fn(), tmuxScrolledHalfPages: 0, tuiPromptBlocking: false, log: vi.fn(),
    };
    const action = evaluate<(key: string) => Promise<void>>('handleTermAction', state);
    const pending = action('enter');
    current = false; release(); await pending;
    expect(write).not.toHaveBeenCalled();
  });

  it('does not send a queued non-critical key into a new CLI lifetime on the same backend', async () => {
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; });
    const writes: string[] = [];
    const backend = { write: (data: string) => { writes.push(data); return true; } };
    const state: Record<string, any> = {
      lastInitConfig: null, backend, cliAdapter: {}, cliLifetimeNonce: 1,
      effectiveBackendType: 'pty', isRemoteBackendType: () => false, codexCliEffortOperation: undefined,
      canWriteTerminalBytes: () => true, isCriticalInterruptKey: () => false,
      runAfterAmbiguousSubmissionWrites: async (_backend: unknown, submit: () => unknown) => { await tail; return submit(); },
      sendTermActionOnce: (target: typeof backend) => target.write('\r'),
      scheduleOneShotAfterAction: vi.fn(), tmuxScrolledHalfPages: 0, tuiPromptBlocking: true,
      log: vi.fn(), send: vi.fn(), t: vi.fn(), flushPending: vi.fn(), currentBotmuxTurnId: undefined,
    };
    const action = evaluate<(key: string) => Promise<void>>('handleTermAction', state);
    const pending = action('enter');
    state.cliLifetimeNonce = 2; release(); await pending;
    expect(writes).toEqual([]);
    expect(state.tuiPromptBlocking).toBe(true);
  });

  it('does not retry a critical key into a new CLI lifetime on the same backend', async () => {
    const writes: string[] = [];
    const backend = { write: (data: string) => { writes.push(data); return writes.length > 1; } };
    const state: Record<string, any> = {
      lastInitConfig: null, backend, cliAdapter: {}, cliLifetimeNonce: 1,
      effectiveBackendType: 'pty', isRemoteBackendType: () => false, codexCliEffortOperation: undefined,
      canWriteTerminalBytes: () => true, isCriticalInterruptKey: () => true,
      runAfterAmbiguousSubmissionWrites: async (_backend: unknown, submit: () => unknown) => submit(),
      sendTermActionOnce: (target: typeof backend) => target.write('\x03'),
      sendCriticalControlKey: async (_key: string, submit: () => boolean) => {
        expect(submit()).toBe(false);
        state.cliLifetimeNonce = 2;
        return submit();
      },
      scheduleOneShotAfterAction: vi.fn(), tmuxScrolledHalfPages: 0, tuiPromptBlocking: true,
      log: vi.fn(), send: vi.fn(), t: vi.fn(), flushPending: vi.fn(), currentBotmuxTurnId: undefined,
    };
    const action = evaluate<(key: string) => Promise<void>>('handleTermAction', state);
    await action('ctrlc');
    expect(writes).toEqual(['\x03']);
    expect(state.tuiPromptBlocking).toBe(true);
  });

  it('fences an in-place CLI restart even when the backend object stays the same', async () => {
    const state: Record<string, any> = {
      lastInitConfig: null,
      backend: {}, cliAdapter: {}, cliLifetimeNonce: 1, codexCliEffortOperation: {},
      cancelCodexCliEffort: async () => { state.cliLifetimeNonce++; },
    };
    const keys = evaluate<(keys: string[], final: boolean) => Promise<boolean>>('handleTuiKeys', state);
    expect(await keys(['Enter'], true)).toBe(false);
  });

  it.each([false, true])('holds queued messages until the picker is visibly closed (observe=%s)', observe => {
    let screen = 'Advanced Reasoning\n› 1. Max\n  2. Ultra\nenter default · s session · esc back';
    const backend = { captureCurrentScreen: () => screen, captureViewport: () => screen };
    const state = {
      backend, cliLifetimeNonce: 1, codexCliEffortRecovery: { backend, lifetime: 1 },
      isObserveBackend: () => observe, renderer: { rawSnapshot: () => screen },
      hasEmptyCodexComposer, parseCodexEffortMenu, stripAnsiScreenText,
      captureBackendScreen: () => screen,
    };
    const held = evaluate<() => boolean>('codexCliEffortNeedsRecovery', state);
    expect(held()).toBe(true);
    screen = '';
    expect(held()).toBe(true);
    screen = '› Ask Codex to do anything';
    expect(held()).toBe(false);
    expect(state.codexCliEffortRecovery).toBeUndefined();
  });

  it('releases queued input after the colored tmux viewport closes the Ultra picker', () => {
    const esc = String.fromCharCode(27);
    const viewport = esc + '[1m»' + esc + '[22m ' + esc + '[2mAsk Codex to do anything' + esc + '[0m';
    const backend = {
      captureViewport: () => viewport,
      captureCurrentScreen: () => 'Advanced Reasoning\n› 1. Ultra\nenter apply · s session · esc back',
    };
    const state = {
      backend, cliLifetimeNonce: 1, codexCliEffortRecovery: { backend, lifetime: 1 },
      isObserveBackend: () => true, captureBackendScreen: () => backend.captureViewport(),
      hasEmptyCodexComposer, parseCodexEffortMenu, stripAnsiScreenText,
    };
    expect(evaluate<() => boolean>('codexCliEffortNeedsRecovery', state)()).toBe(false);
    expect(state.codexCliEffortRecovery).toBeUndefined();
  });

  it('does not carry an old picker recovery hold into a replacement CLI', () => {
    const state = {
      backend: {}, cliLifetimeNonce: 2, codexCliEffortRecovery: { backend: {}, lifetime: 1 },
    };
    expect(evaluate<() => boolean>('codexCliEffortNeedsRecovery', state)()).toBe(false);
    expect(state.codexCliEffortRecovery).toBeUndefined();
  });
});
