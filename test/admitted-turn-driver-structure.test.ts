import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 源码结构护栏(K3)：这些生产 driver 若绕开 typed permit adapter，消息会在错误目录执行或重复执行。
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}' && --depth === 0) return source.slice(brace, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

describe('central admitted business driver structure', () => {
  const daemon = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
  // 源码结构护栏(K3)：逐个 driver 必须只经 permit adapter，避免任一条生产路径旁路。
  it.each([
    'submitQueuedMessage',
    'dispatchReservedInitialSession',
  ])('%s cannot bypass typed business permits', name => {
    const body = functionBody(daemon, name);
    expect(body).toContain('dispatchAdmittedBusinessTurn');
    expect(body).not.toMatch(/\bsendWorkerInput\s*\(/);
    expect(body).not.toMatch(/\bforkWorker\s*\(/);
    expect(body).not.toMatch(/\bforkAdoptWorker\s*\(/);
  });

  // 源码结构护栏(K3)：principal 的依赖注入默认值必须仍指向 typed permit dispatcher，且 owner 不得直发 IPC。
  it('principal FIFO owns no direct IPC and defaults to the typed dispatcher', () => {
    expect(daemon).toContain('const principalLaneDispatchDependencies: PrincipalLaneDispatchDependencies = {\n  dispatch: dispatchAdmittedBusinessTurn,\n};');
    const body = functionBody(daemon, 'driveNextPrincipalLaneTurnOwned');
    expect(body).toContain('dependencies.dispatch');
    expect(body).not.toMatch(/\bsendWorkerInput\s*\(/);
    expect(body).not.toMatch(/\bforkWorker\s*\(/);
    expect(body).not.toMatch(/\bforkAdoptWorker\s*\(/);
  });

  // 源码结构护栏(K3)：XPI adopt 唯一允许的 fork 必须封装在 typed permit 的 forkBlank 回调内。
  it('XPI adopt bootstrap may fork only inside the typed permit boundary', () => {
    const body = functionBody(daemon, 'driveNextXpiSharedCwdTurn');
    expect(body).toContain('dispatchAdmittedBusinessTurn');
    expect(body).toContain('forkBlank: async');
    expect(body).toContain('dependencies.forkAdoptWorker');
    expect(body).not.toMatch(/\bsendWorkerInput\s*\(/);
    expect(body).not.toMatch(/\bforkWorker\s*\(/);
  });

  // 源码结构护栏(K3)：异步 Ask 生产回复只能恢复原 turn，不能重新派生业务 turn。
  it('async Ask answer resumes the exact original turn through a control permit', () => {
    expect(daemon).toContain('resumeAdmittedControlReply');
    expect(daemon).toContain('issueControlReply');
    expect(daemon).toContain('beginControlReplyDispatch');
    expect(daemon).toContain('controlDispatchId: permit.controlDispatchId');
    expect(daemon).toContain('abortControlReplyDispatch');
    expect(daemon).not.toContain('codex-async-answer-${randomUUID()}');
  });
});
