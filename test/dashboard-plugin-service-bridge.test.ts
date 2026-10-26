import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handlePluginDashboardServiceHttpRequest,
  PluginDashboardServiceError,
  proxyPluginDashboardServiceRequest,
} from '../src/core/plugins/dashboard-service-bridge.js';
import type { InstalledPluginRecord, PluginServiceState } from '../src/core/plugins/types.js';
import { pluginDashboardApi } from '../src/dashboard/web/plugin-page.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
});

async function fixture(host = '127.0.0.1') {
  const requests: Array<{ path: string; method: string; headers: Record<string, string | string[] | undefined>; body: string }> = [];
  const streamClosed = new Map<string, Promise<void>>();
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url ?? '', method: req.method ?? '', headers: req.headers, body });
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/api/snapshot' });
      res.end();
      return;
    }
    if (req.url === '/plain') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('not json');
      return;
    }
    if (req.url === '/plain-stream' || req.url === '/error-stream') {
      streamClosed.set(req.url, new Promise(resolve => res.once('close', resolve)));
      res.writeHead(req.url === '/error-stream' ? 503 : 200, {
        'content-type': req.url === '/error-stream' ? 'application/json' : 'text/plain',
      });
      res.write(req.url === '/error-stream' ? '{"error":' : 'not json');
      return;
    }
    if (req.url === '/large') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ value: 'x'.repeat(2_000) }));
      return;
    }
    if (req.url === '/slow') {
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      }, 100);
      return;
    }
    if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"ok":');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, method: req.method, body: body ? JSON.parse(body) : null }));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    port: (server.address() as { port: number }).port,
    requests,
    async didStreamClose(path: string, timeoutMs = 250) {
      const closed = streamClosed.get(path);
      if (!closed) return false;
      return Promise.race([
        closed.then(() => true),
        new Promise<false>(resolve => setTimeout(() => resolve(false), timeoutMs)),
      ]);
    },
  };
}

const routes = [
  { method: 'GET' as const, path: '/api/snapshot' },
  { method: 'POST' as const, path: '/api/refresh' },
  { method: 'GET' as const, path: '/redirect' },
  { method: 'GET' as const, path: '/plain' },
  { method: 'GET' as const, path: '/plain-stream' },
  { method: 'GET' as const, path: '/error-stream' },
  { method: 'GET' as const, path: '/large' },
  { method: 'GET' as const, path: '/slow' },
  { method: 'GET' as const, path: '/stream' },
];

function record(): InstalledPluginRecord {
  return {
    id: 'sample', packageName: '@botmux/plugin-sample', version: '0.1.0',
    source: { type: 'local', spec: '/tmp/sample' },
    manifest: { schemaVersion: 1, id: 'sample', service: { mode: 'auto' } },
    contributions: {
      service: { entry: 'service/index.js', mode: 'auto' },
      serviceHttp: { schemaVersion: 1, routes },
    },
    installedAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
  };
}

function state(port: number, patch: Partial<PluginServiceState> = {}): PluginServiceState {
  return {
    pluginId: 'sample', updatedAt: '2026-10-26T00:00:00.000Z',
    status: 'online', host: '127.0.0.1', port, ...patch,
  };
}

describe('Dashboard plugin service bridge', () => {
  it('forwards allowlisted GET and POST JSON requests without browser credentials', async () => {
    const local = await fixture();
    const getResult = await proxyPluginDashboardServiceRequest(
      { pluginId: 'sample', method: 'GET', path: '/api/snapshot' },
      { record: record(), state: state(local.port) },
    );
    const postResult = await proxyPluginDashboardServiceRequest(
      {
        pluginId: 'sample', method: 'POST', path: '/api/refresh', body: { refresh: true },
        headers: { cookie: 'browser=secret', authorization: 'Bearer secret', 'x-forwarded-for': 'remote' },
      } as any,
      { record: record(), state: state(local.port) },
    );

    expect(getResult).toEqual({ ok: true, method: 'GET', body: null });
    expect(postResult).toEqual({ ok: true, method: 'POST', body: { refresh: true } });
    expect(local.requests).toHaveLength(2);
    expect(local.requests[1].headers).toMatchObject({
      accept: 'application/json',
      'content-type': 'application/json',
    });
    expect(local.requests[1].headers).not.toHaveProperty('cookie');
    expect(local.requests[1].headers).not.toHaveProperty('authorization');
    expect(local.requests[1].headers).not.toHaveProperty('x-forwarded-for');
  });

  it('rejects unallowlisted and malformed paths before opening a socket', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; throw new Error('unexpected socket'); };
    for (const path of [
      '/api/other', '/api/snapshot?full=1', '/api/snapshot#x', '/api\\snapshot',
      '/api/%2e%2e/secret', '//127.0.0.1/api', 'http://127.0.0.1/api',
    ]) {
      await expect(proxyPluginDashboardServiceRequest(
        { pluginId: 'sample', method: 'GET', path },
        { record: record(), state: state(43210), fetchImpl: fetchImpl as typeof fetch },
      )).rejects.toThrow('route_not_allowed');
    }
    expect(calls).toBe(0);
  });

  it('fails closed for invalid service identity, host, port, and offline state', async () => {
    const local = await fixture();
    const input = { pluginId: 'sample', method: 'GET' as const, path: '/api/snapshot' };
    await expect(proxyPluginDashboardServiceRequest(input, {
      record: record(), state: state(local.port, { status: 'stopped' }),
    })).rejects.toThrow('service_offline');
    await expect(proxyPluginDashboardServiceRequest(input, {
      record: record(), state: state(local.port, { pluginId: 'other' }),
    })).rejects.toThrow('service_offline');
    await expect(proxyPluginDashboardServiceRequest(input, {
      record: record(), state: state(local.port, { host: '10.0.0.1' }),
    })).rejects.toThrow('service_host_invalid');
    await expect(proxyPluginDashboardServiceRequest(input, {
      record: record(), state: state(local.port, { port: 0 }),
    })).rejects.toThrow('service_port_invalid');
  });

  it('fails closed for redirects, non-JSON, oversized responses, and timeouts', async () => {
    const local = await fixture();
    const call = (path: string, extra: { timeoutMs?: number; maxBytes?: number } = {}) => (
      proxyPluginDashboardServiceRequest(
        { pluginId: 'sample', method: 'GET', path },
        { record: record(), state: state(local.port), ...extra },
      )
    );
    await expect(call('/redirect')).rejects.toThrow('upstream_redirect');
    await expect(call('/plain')).rejects.toThrow('upstream_non_json');
    await expect(call('/large', { maxBytes: 128 })).rejects.toThrow('upstream_too_large');
    await expect(call('/slow', { timeoutMs: 10 })).rejects.toThrow('upstream_timeout');
    const streamed = call('/stream', { timeoutMs: 50 }).then(
      () => 'resolved',
      error => error instanceof PluginDashboardServiceError ? error.code : String(error),
    );
    await expect(Promise.race([
      streamed,
      new Promise(resolve => setTimeout(() => resolve('still_pending'), 250)),
    ])).resolves.toBe('upstream_timeout');
  });

  it('cancels unread bodies for non-JSON and non-success streaming responses', async () => {
    const local = await fixture();
    const call = (path: string) => proxyPluginDashboardServiceRequest(
      { pluginId: 'sample', method: 'GET', path },
      { record: record(), state: state(local.port) },
    );
    await expect(call('/plain-stream')).rejects.toThrow('upstream_non_json');
    await expect(local.didStreamClose('/plain-stream')).resolves.toBe(true);
    await expect(call('/error-stream')).rejects.toThrow('upstream_http_status');
    await expect(local.didStreamClose('/error-stream')).resolves.toBe(true);
  });

  it('preserves localhost while normalizing explicit IPv4 and IPv6 literals', async () => {
    const targets: string[] = [];
    const fetchImpl = async (input: string | URL | Request) => {
      targets.push(String(input));
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    for (const host of ['localhost', '127.0.0.1', '::1', '[::1]']) {
      await proxyPluginDashboardServiceRequest(
        { pluginId: 'sample', method: 'GET', path: '/api/snapshot' },
        { record: record(), state: state(43210, { host }), fetchImpl: fetchImpl as typeof fetch },
      );
    }
    expect(targets).toEqual([
      'http://localhost:43210/api/snapshot',
      'http://127.0.0.1:43210/api/snapshot',
      'http://[::1]:43210/api/snapshot',
      'http://[::1]:43210/api/snapshot',
    ]);
  });

  it('connects to real IPv4 and IPv6-only loopback listeners when available', async context => {
    const ipv4 = await fixture('127.0.0.1');
    await expect(proxyPluginDashboardServiceRequest(
      { pluginId: 'sample', method: 'GET', path: '/api/snapshot' },
      { record: record(), state: state(ipv4.port, { host: '127.0.0.1' }) },
    )).resolves.toMatchObject({ ok: true });

    let ipv6;
    try {
      ipv6 = await fixture('::1');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EAFNOSUPPORT' || code === 'EADDRNOTAVAIL') {
        context.skip();
        return;
      }
      throw error;
    }
    await expect(proxyPluginDashboardServiceRequest(
      { pluginId: 'sample', method: 'GET', path: '/api/snapshot' },
      { record: record(), state: state(ipv6.port, { host: '[::1]' }) },
    )).resolves.toMatchObject({ ok: true });
  });
});

async function bridgeHttpFixture(options: {
  installed?: boolean;
  serviceState?: PluginServiceState;
  proxy?: () => Promise<unknown>;
  log?: (event: unknown) => void;
  now?: () => number;
}) {
  if (typeof handlePluginDashboardServiceHttpRequest !== 'function') {
    throw new Error('plugin_dashboard_service_http_handler_missing');
  }
  const server = createServer((req, res) => {
    void handlePluginDashboardServiceHttpRequest(req, res, 'sample', {
      resolveRecord: () => options.installed === false ? undefined : record(),
      readState: () => options.serviceState ?? state(43210),
      proxy: options.proxy ?? (async () => ({ ok: true })),
      readBody: async request => {
        let raw = '';
        for await (const chunk of request) raw += chunk;
        return JSON.parse(raw);
      },
      log: options.log,
      now: options.now,
    } as any);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return async (body = '{"method":"GET","path":"/api/snapshot"}') => {
    const response = await fetch(`http://127.0.0.1:${port}/api/plugins/sample/service-request`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    return { status: response.status, body: await response.json() };
  };
}

describe('Dashboard plugin service bridge HTTP contract', () => {
  it('returns JSON from a valid request and rejects bad shape or JSON', async () => {
    const call = await bridgeHttpFixture({ proxy: async () => ({ models: 19 }) });
    expect(await call()).toEqual({ status: 200, body: { models: 19 } });
    expect(await call('{')).toEqual({ status: 400, body: { error: 'bad_json' } });
    expect(await call('{"method":"GET","path":"/api/snapshot","headers":{"authorization":"secret"}}'))
      .toEqual({ status: 400, body: { error: 'invalid_request' } });
  });

  it('maps plugin, service, route, upstream, and timeout failures', async () => {
    expect(await (await bridgeHttpFixture({ installed: false }))()).toEqual({ status: 404, body: { error: 'plugin_not_found' } });
    expect(await (await bridgeHttpFixture({ serviceState: state(43210, { status: 'stopped' }) }))())
      .toEqual({ status: 409, body: { error: 'service_offline' } });
    for (const [code, status] of [
      ['route_not_allowed', 403],
      ['upstream_timeout', 504],
      ['upstream_non_json', 502],
    ] as const) {
      const call = await bridgeHttpFixture({ proxy: async () => { throw new PluginDashboardServiceError(code); } });
      expect(await call()).toEqual({ status, body: { error: code } });
    }
  });

  it('audits plugin, allowlisted path, result, and duration without request bodies', async () => {
    const events: unknown[] = [];
    let clock = 100;
    const call = await bridgeHttpFixture({
      proxy: async () => ({ ok: true }),
      log: event => events.push(event),
      now: () => (clock += 7),
    });

    await expect(call('{"method":"POST","path":"/api/refresh","body":{"secret":"not logged"}}'))
      .resolves.toEqual({ status: 200, body: { ok: true } });
    expect(events).toEqual([{
      pluginId: 'sample', path: '/api/refresh', status: 'ok', durationMs: 7,
    }]);
    expect(JSON.stringify(events)).not.toContain('not logged');
  });
});

describe('plugin Dashboard browser API', () => {
  it('posts only method, path, and body through requestService', async () => {
    const fetchMock = vi.fn(async () => new Response('{"models":19}', {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const request = { method: 'POST' as const, path: '/api/refresh', body: { force: true } };
      await expect(pluginDashboardApi('sample').requestService(request)).resolves.toEqual({ models: 19 });
      expect(fetchMock).toHaveBeenCalledWith('/api/plugins/sample/service-request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
