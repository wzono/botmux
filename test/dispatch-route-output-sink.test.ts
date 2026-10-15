/**
 * The two daemon routes through which `botmux dispatch` writes to Lark — the
 * new-topic seed registration and the kickoff delivery — must apply the same
 * Codex App output-sink rule as the relay (worker authorizeManagedSend) and
 * /api/send when an isolated pane calls them directly with its capability.
 *
 * A credential-only pane dispatches `--bot` / `--repo` / `--standby` forms
 * directly (the relay refuses them), so without this gate a turn whose output
 * is bound to http_wait / http_async / suppressed could still post to Lark.
 *
 * Executes the production handlers (extracted from src/daemon.ts) with the
 * platform/network seams replaced, like dispatch-user-route.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { authorizeSessionScopedIpc } from '../src/core/daemon-ipc-session-auth.js';
import { readJsonBody, JsonBodyTooLargeError } from '../src/core/dashboard-ipc-server.js';
import { isCodexAppCliId } from '../src/adapters/cli/types.js';
import { validateCodexAppManagedSendOrigin } from '../src/utils/codex-app-dispatch-ledger.js';
import { DISPATCH_USER_DELIVERY_MAX_BYTES } from '../src/core/dispatch-user-delegation.js';
import { fallbackTurnId, frozenReplyContextForTurn } from '../src/core/reply-target.js';

const source = ts.createSourceFile('daemon.ts', readFileSync('src/daemon.ts', 'utf8'), ts.ScriptTarget.Latest, true);
function routeHandler(routeConstant: string): string {
  const route = source.statements.find(node => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(source) === 'ipcRoute'
    && node.expression.arguments[1]?.getText(source) === routeConstant) as ts.ExpressionStatement | undefined;
  if (!route) throw new Error(`missing route ${routeConstant}`);
  const handler = (route.expression as ts.CallExpression).arguments[2]!;
  const guards = ['sourceTopicWriteOptions', 'sessionTopicWriteOptions'].map(name => {
    const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!declaration) throw new Error(`missing helper ${name}`);
    return declaration.getText(source);
  }).join('\n');
  return ts.transpileModule(`${guards}\nconst handler = ${handler.getText(source)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
}
const registerCode = routeHandler('DISPATCH_REPORT_REGISTER_ROUTE');
const deliverCode = routeHandler('DISPATCH_USER_DELIVERY_ROUTE');

const CAPABILITY = 'c'.repeat(64);
type Sink = 'lark' | 'http_wait' | 'http_async' | 'suppressed';

function session(opts: { cliId?: string; sink?: Sink }) {
  return {
    larkAppId: 'cli_source', chatId: 'oc_source', chatType: 'group', scope: 'thread',
    initConfig: { cliId: opts.cliId ?? 'codex-app' },
    session: {
      sessionId: 'source-session', chatId: 'oc_source', rootMessageId: 'om_root', cliId: opts.cliId ?? 'codex-app',
      ...(opts.sink ? {
        codexAppDispatchLedger: [{
          dispatchId: 'd-1', turnId: 'om_turn', dispatchAttempt: 1, state: 'prepared',
          content: 'prompt', deliverySink: opts.sink,
        }],
      } : {}),
    },
    managedTurnOrigin: { capability: CAPABILITY, turnId: 'om_turn', dispatchAttempt: 1 },
  } as any;
}

function run(code: string, ds: any, body: Record<string, unknown>, trustedHost: boolean) {
  const sendMessage = vi.fn(async () => 'om_seed');
  const replyMessage = vi.fn(async () => 'om_kickoff');
  const scope: any = {
    readJsonBody: async () => body, JsonBodyTooLargeError,
    DISPATCH_REPORT_REGISTER_MAX_BYTES: 64 * 1024, DISPATCH_USER_DELIVERY_MAX_BYTES,
    findActiveBySessionId: (id: string) => id === ds.session.sessionId ? ds : undefined,
    authorizeSessionScopedIpc, isTrustedHostIpcRequest: () => trustedHost, selfDaemonLarkAppId: 'cli_source',
    validateCodexAppManagedSendOrigin, isCodexAppCliId,
    jsonRes: (_res: unknown, status: number, value: any) => ({ status, value }),
    isMultiTopicOrchestrationEnabled: () => true,
    readGroupCollaborationMode: () => undefined,
    evaluateProjectDispatchPolicy: () => ({ ok: true }),
    lookupMessageChatId: async () => 'oc_target',
    sendMessage, replyMessage,
    loadOrCreateDispatchReportBindingSecret: () => 'secret',
    createDispatchReportBinding: () => ({}),
    recordDispatchRegistryEntry: async () => undefined,
    initialDispatchLifecycle: () => ({}),
    projectCoordinator: { run: async () => undefined },
    getBot: () => ({ config: {} }),
    readGlobalConfig: () => ({}),
    getDashboardAdminOpenIds: () => [],
    dispatchUserForTurn: async () => undefined,
    pickTurnReplyTarget: () => undefined,
    fallbackTurnId, frozenReplyContextForTurn,
    config: { session: { dataDir: '/nonexistent' } },
    join, logger: { info: vi.fn(), warn: vi.fn() },
  };
  const handler = new Function('scope', `with (scope) { ${code}; return handler; }`)(scope);
  return { result: handler({}, {}) as Promise<{ status: number; value: any }>, sendMessage, replyMessage };
}

const paneClaim = { sessionId: 'source-session', originCapability: CAPABILITY, originTurnId: 'om_turn', originDispatchAttempt: 1 };
const registerBody = { ...paneClaim, seedText: '子项目', targetChatId: 'oc_target', targetAppIds: [], title: 't' };
const deliverBody = { ...paneClaim, rootId: 'om_child', chatId: 'oc_target', content: '{"zh_cn":{"content":[]}}', targetAppIds: [] };

const routes: Array<[string, string, Record<string, unknown>, 'sendMessage' | 'replyMessage']> = [
  ['seed registration (new topic / --standby)', registerCode, registerBody, 'sendMessage'],
  ['kickoff delivery (--into and every brief)', deliverCode, deliverBody, 'replyMessage'],
];

describe.each(routes)('dispatch %s: Codex App output-sink gate', (_label, code, body, writer) => {
  it.each(['http_wait', 'http_async', 'suppressed'] as const)(
    'refuses an isolated pane whose turn is bound to %s, before any Lark write',
    async sink => {
      const call = run(code, session({ sink }), body, false);
      const { status, value } = await call.result;
      expect(status).toBe(409);
      expect(value.error).toBe('origin_not_sendable');
      expect(call[writer]).not.toHaveBeenCalled();
    },
  );

  it('lets an isolated pane through when its turn is bound to Lark', async () => {
    const call = run(code, session({ sink: 'lark' }), body, false);
    const { status } = await call.result;
    expect(status).toBeLessThan(300);
    expect(call[writer]).toHaveBeenCalled();
  });

  it('lets a non-Codex-App isolated pane through (no ledger to bind)', async () => {
    const call = run(code, session({ cliId: 'claude-code' }), body, false);
    const { status } = await call.result;
    expect(status).toBeLessThan(300);
    expect(call[writer]).toHaveBeenCalled();
  });

  it('leaves trusted-host callers (relayed re-exec / ordinary host) on their existing path', async () => {
    const call = run(code, session({ sink: 'http_wait' }), body, true);
    const { status } = await call.result;
    expect(status).toBeLessThan(300);
  });
});
