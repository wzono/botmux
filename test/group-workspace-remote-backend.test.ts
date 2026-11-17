import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { RiffBackend } from '../src/adapters/backend/riff-backend.js';
import { MojoBackend } from '../src/adapters/backend/mojo-backend.js';

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'botmux-remote-proof-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const identityFor = (path: string) => { const stat = statSync(path, { bigint: true }); return { dev: String(stat.dev), ino: String(stat.ino) }; };

describe('remote backend effective workspace proof', () => {
  it('Riff rejects a group target that cannot derive one primary repository', () => {
    const cwd = temp();
    const backend = new RiffBackend({ baseUrl: 'https://riff.invalid', jwt: 'x' }, 's');
    backend.spawn('', [], { cwd, expectedWorkingDirIdentity: identityFor(cwd), cols: 80, rows: 24, env: {} });
    expect(backend.effectiveWorkspaceProof()).toBeUndefined();
    expect(backend.validateWorkingDirBeforeBusinessInput()).toBe(false);
  });

  it('Riff rejects an explicit repository override that differs from the group target', () => {
    const cwd = temp();
    const backend = new RiffBackend({ baseUrl: 'https://riff.invalid', jwt: 'x', repos: [{ repoName: 'other/repo' }] }, 's');
    backend.spawn('', [], { cwd, expectedWorkingDirIdentity: identityFor(cwd), cols: 80, rows: 24, env: {} });
    expect(backend.effectiveWorkspaceProof()).toBeUndefined();
  });

  it('Riff rejects a same-repository branch override that differs from derived target', () => {
    const cwd = temp();
    execFileSync('git', ['init', '-b', 'group-branch'], { cwd });
    execFileSync('git', ['remote', 'add', 'origin', 'git@example.com:acme/repo.git'], { cwd });
    const backend = new RiffBackend({ baseUrl: 'https://riff.invalid', jwt: 'x',
      repos: [{ repoName: 'acme/repo', repoBranch: 'override-branch' }] }, 's');
    const derive = backend as any;
    derive.config.repos = [{ repoName: 'acme/repo', repoBranch: 'override-branch' }];
    backend.spawn('', [], { cwd, expectedWorkingDirIdentity: identityFor(cwd), cols: 80, rows: 24, env: {} });
    expect(backend.effectiveWorkspaceProof()).toBeUndefined();
  });

  it('Riff rejects extra repositories even when the primary matches', () => {
    const cwd = temp(); execFileSync('git', ['init', '-b', 'group-branch'], { cwd });
    execFileSync('git', ['remote', 'add', 'origin', 'git@example.com:acme/repo.git'], { cwd });
    const backend = new RiffBackend({ baseUrl: 'https://riff.invalid', jwt: 'x', repos: [
      { repoName: 'acme/repo' }, { repoName: 'other/repo' },
    ] }, 's');
    backend.spawn('', [], { cwd, expectedWorkingDirIdentity: identityFor(cwd), cols: 80, rows: 24, env: {} });
    expect(backend.effectiveWorkspaceProof()).toBeUndefined();
    expect(backend.validateWorkingDirBeforeBusinessInput()).toBe(false);
  });

  it('Riff re-derives repository identity at each business submit', () => {
    const cwd = temp(); execFileSync('git', ['init', '-b', 'group-branch'], { cwd });
    execFileSync('git', ['remote', 'add', 'origin', 'git@example.com:acme/repo.git'], { cwd });
    writeFileSync(join(cwd, 'README'), 'x'); execFileSync('git', ['add', '.'], { cwd });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-m', 'x'], { cwd });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/group-branch', 'HEAD'], { cwd });
    const backend = new RiffBackend({ baseUrl: 'https://riff.invalid', jwt: 'x' }, 's');
    backend.spawn('', [], { cwd, expectedWorkingDirIdentity: identityFor(cwd), cols: 80, rows: 24, env: {} });
    expect(backend.effectiveWorkspaceProof()).toBeDefined();
    execFileSync('git', ['remote', 'set-url', 'origin', 'git@example.com:other/repo.git'], { cwd });
    expect(backend.effectiveWorkspaceProof()).toBeUndefined();
    expect(backend.validateWorkingDirBeforeBusinessInput()).toBe(false);
  });

  it('Riff rejects an unpushed branch because exact branch proof is absent', () => {
    const cwd = temp(); execFileSync('git', ['init', '-b', 'local-only'], { cwd });
    execFileSync('git', ['remote', 'add', 'origin', 'git@example.com:acme/repo.git'], { cwd });
    const backend = new RiffBackend({ baseUrl: 'https://riff.invalid', jwt: 'x' }, 's');
    backend.spawn('', [], { cwd, expectedWorkingDirIdentity: identityFor(cwd), cols: 80, rows: 24, env: {} });
    expect(backend.effectiveWorkspaceProof()).toBeUndefined();
  });

  it('Mojo rejects mojo.cwd override for a group-sourced target', () => {
    const cwd = temp(); const override = temp();
    const backend = new MojoBackend({ cwd: override, localDaemon: true } as any, 's');
    expect(() => backend.spawn('', [], { cwd, expectedWorkingDirIdentity: identityFor(cwd), cols: 80, rows: 24, env: {} })).toThrow(/group workspace/i);
  });

  it('Mojo host prompt guidance and cloud without attestation both reject group business input', () => {
    const cwd = temp(); mkdirSync(join(cwd, 'repo'));
    const host = new MojoBackend({ localDaemon: true, env: { HOME: temp() } } as any, 'host');
    host.spawn('', [], { cwd, expectedWorkingDirIdentity: identityFor(cwd), cols: 80, rows: 24, env: {} });
    expect(host.effectiveWorkspaceProof()).toBeUndefined();
    expect(host.validateWorkingDirBeforeBusinessInput()).toBe(false);
    const cloud = new MojoBackend({ cloud: true, localDaemon: false } as any, 'cloud');
    cloud.spawn('', [], { cwd, expectedWorkingDirIdentity: identityFor(cwd), cols: 80, rows: 24, env: {} });
    expect(cloud.effectiveWorkspaceProof()).toBeUndefined();
    expect(cloud.validateWorkingDirBeforeBusinessInput()).toBe(false);
  });

  it('keeps Riff progress final and error output observable while proof is enabled', () => {
    const backend = new RiffBackend({ baseUrl: 'https://riff.invalid', jwt: 'x' }, 's');
    const out: string[] = []; backend.onData(data => out.push(data));
    (backend as any).emitLine('progress'); (backend as any).emitText('final'); (backend as any).emitError('error');
    expect(out.join('')).toContain('progress'); expect(out.join('')).toContain('final'); expect(out.join('')).toContain('error');
  });

  it('keeps Mojo progress final and error output observable while proof is enabled', () => {
    const backend = new MojoBackend({ localDaemon: true } as any, 's'); const out: string[] = [];
    backend.onData(data => out.push(data)); (backend as any).emitLine('progress'); (backend as any).emitText('final');
    (backend as any).emitLine('error', 'error');
    expect(out.join('')).toContain('progress'); expect(out.join('')).toContain('final'); expect(out.join('')).toContain('error');
  });

});
