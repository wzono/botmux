import { describe, expect, it } from 'vitest';

import { canResumeExplicitAskInSession } from '../src/core/explicit-ask-continuation.js';

const receipt = {
  version: 1 as const,
  input: {
    larkAppId: 'cli_app', chatId: 'oc_chat', rootMessageId: 'om_into', sessionId: 'sess',
    questions: [{ prompt: 'continue?', multiSelect: false, options: [{ key: 'y', label: 'Y' }, { key: 'n', label: 'N' }] }],
    timeoutMs: 60_000, requestId: 'request', originKind: 'host_explicit',
  },
};

describe('canResumeExplicitAskInSession', () => {
  it('resumes a validated --into Ask in its authenticated chat session', () => {
    expect(canResumeExplicitAskInSession(receipt, {
      larkAppId: 'cli_app', chatId: 'oc_chat', sessionId: 'sess', workerPresent: true, lastScreenStatus: 'idle',
    })).toBe(true);
  });

  it('rejects cross-chat, cross-app, and cross-session recovery', () => {
    const base = { larkAppId: 'cli_app', chatId: 'oc_chat', sessionId: 'sess', workerPresent: true, lastScreenStatus: 'idle' };
    expect(canResumeExplicitAskInSession(receipt, { ...base, chatId: 'oc_other' })).toBe(false);
    expect(canResumeExplicitAskInSession(receipt, { ...base, larkAppId: 'cli_other' })).toBe(false);
    expect(canResumeExplicitAskInSession(receipt, { ...base, sessionId: 'other' })).toBe(false);
  });

  it('preserves the settled-result idle gate', () => {
    const settled = { ...receipt, result: { kind: 'timedOut' as const, selected: null, by: null, comment: null, timedOut: true } };
    expect(canResumeExplicitAskInSession(settled, {
      larkAppId: 'cli_app', chatId: 'oc_chat', sessionId: 'sess', workerPresent: true, lastScreenStatus: 'running',
    })).toBe(false);
  });
});
