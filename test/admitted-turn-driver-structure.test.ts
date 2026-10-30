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
  it.each(['submitQueuedMessage', 'driveNextPrincipalLaneTurn', 'driveNextXpiSharedCwdTurn'])
  ('%s cannot bypass typed business permits', name => {
    const body = functionBody(daemon, name);
    expect(body).toContain('dispatchAdmittedBusinessTurn');
    expect(body).not.toMatch(/\bsendWorkerInput\s*\(/);
    expect(body).not.toMatch(/\bforkWorker\s*\(/);
    expect(body).not.toMatch(/\bforkAdoptWorker\s*\(/);
  });
});
