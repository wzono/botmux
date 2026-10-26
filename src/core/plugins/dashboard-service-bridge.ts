import type { IncomingMessage, ServerResponse } from 'node:http';
import { logger } from '../../utils/logger.js';
import type { InstalledPluginRecord, PluginServiceState } from './types.js';

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;

export interface PluginDashboardServiceRequest {
  pluginId: string;
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

export type PluginDashboardServiceErrorCode =
  | 'invalid_request'
  | 'route_not_allowed'
  | 'service_offline'
  | 'service_host_invalid'
  | 'service_port_invalid'
  | 'upstream_redirect'
  | 'upstream_non_json'
  | 'upstream_too_large'
  | 'upstream_timeout'
  | 'upstream_unavailable'
  | 'upstream_http_status'
  | 'upstream_invalid_json';

export class PluginDashboardServiceError extends Error {
  constructor(readonly code: PluginDashboardServiceErrorCode) {
    super(code);
    this.name = 'PluginDashboardServiceError';
  }
}

function fail(code: PluginDashboardServiceErrorCode): never {
  throw new PluginDashboardServiceError(code);
}

function loopbackUrlHost(host: unknown): string | undefined {
  if (host === '127.0.0.1' || host === 'localhost') return '127.0.0.1';
  if (host === '::1' || host === '[::1]') return '[::1]';
  return undefined;
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('application/json')) fail('upstream_non_json');
  if (!response.body) fail('upstream_invalid_json');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        fail('upstream_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), total).toString('utf8'));
  } catch {
    fail('upstream_invalid_json');
  }
}

export async function proxyPluginDashboardServiceRequest(
  input: PluginDashboardServiceRequest,
  deps: {
    record: InstalledPluginRecord;
    state: PluginServiceState | undefined;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    maxBytes?: number;
  },
): Promise<unknown> {
  if (input.pluginId !== deps.record.id || (input.method !== 'GET' && input.method !== 'POST')) {
    fail('invalid_request');
  }
  if (input.method === 'GET' && input.body !== undefined) fail('invalid_request');
  const allowed = deps.record.contributions?.serviceHttp?.routes
    .some(route => route.method === input.method && route.path === input.path);
  if (!allowed) fail('route_not_allowed');
  if (deps.state?.pluginId !== deps.record.id || deps.state.status !== 'online') fail('service_offline');
  const targetHost = loopbackUrlHost(deps.state.host);
  if (!targetHost) fail('service_host_invalid');
  if (!Number.isInteger(deps.state.port) || deps.state.port! < 1 || deps.state.port! > 65_535) {
    fail('service_port_invalid');
  }

  let body: string | undefined;
  if (input.method === 'POST' && input.body !== undefined) {
    try {
      body = JSON.stringify(input.body);
    } catch {
      fail('invalid_request');
    }
  }
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (deps.fetchImpl ?? fetch)(`http://${targetHost}:${deps.state.port}${input.path}`, {
      method: input.method,
      redirect: 'error',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body } : {}),
    });
    if (response.status >= 300 && response.status < 400) fail('upstream_redirect');
    if (!response.ok) fail('upstream_http_status');
    return await readBoundedJson(response, maxBytes);
  } catch (error) {
    if (error instanceof PluginDashboardServiceError) throw error;
    if (controller.signal.aborted) fail('upstream_timeout');
    const detail = [error, (error as { cause?: unknown })?.cause]
      .map(item => item instanceof Error ? item.message : String(item ?? ''))
      .join(' ')
      .toLowerCase();
    if (detail.includes('redirect')) fail('upstream_redirect');
    fail('upstream_unavailable');
  } finally {
    clearTimeout(timeout);
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
  return true;
}

function requestShape(value: unknown): Omit<PluginDashboardServiceRequest, 'pluginId'> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== 'method' && key !== 'path' && key !== 'body')) return undefined;
  if ((record.method !== 'GET' && record.method !== 'POST') || typeof record.path !== 'string') return undefined;
  if (record.method === 'GET' && record.body !== undefined) return undefined;
  return {
    method: record.method,
    path: record.path,
    ...(record.body !== undefined ? { body: record.body } : {}),
  };
}

function errorStatus(error: PluginDashboardServiceError): number {
  if (error.code === 'invalid_request') return 400;
  if (error.code === 'route_not_allowed') return 403;
  if (error.code.startsWith('service_')) return 409;
  if (error.code === 'upstream_timeout') return 504;
  return 502;
}

export async function handlePluginDashboardServiceHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pluginId: string,
  deps: {
    resolveRecord(id: string): InstalledPluginRecord | undefined;
    readState(id: string): PluginServiceState | undefined;
    readBody(req: IncomingMessage): Promise<unknown>;
    proxy?: typeof proxyPluginDashboardServiceRequest;
    log?: (event: { pluginId: string; path: string; status: string; durationMs: number }) => void;
    now?: () => number;
  },
): Promise<true> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const log = deps.log ?? (event => logger.info('[plugin-dashboard-service]', event));
  let auditPath = '<invalid>';
  const respond = (httpStatus: number, body: unknown, status: string): true => {
    log({ pluginId, path: auditPath, status, durationMs: Math.max(0, now() - startedAt) });
    return writeJson(res, httpStatus, body);
  };
  if (req.method !== 'POST') return respond(405, { error: 'method_not_allowed' }, 'method_not_allowed');
  const record = deps.resolveRecord(pluginId);
  if (!record) return respond(404, { error: 'plugin_not_found' }, 'plugin_not_found');
  const state = deps.readState(pluginId);
  if (state?.pluginId !== pluginId || state.status !== 'online') {
    return respond(409, { error: 'service_offline' }, 'service_offline');
  }
  let raw: unknown;
  try {
    raw = await deps.readBody(req);
  } catch {
    return respond(400, { error: 'bad_json' }, 'bad_json');
  }
  const parsed = requestShape(raw);
  if (!parsed) return respond(400, { error: 'invalid_request' }, 'invalid_request');
  auditPath = record.contributions?.serviceHttp?.routes
    .some(route => route.method === parsed.method && route.path === parsed.path)
    ? parsed.path
    : '<rejected>';
  try {
    const result = await (deps.proxy ?? proxyPluginDashboardServiceRequest)(
      { pluginId, ...parsed },
      { record, state },
    );
    return respond(200, result, 'ok');
  } catch (error) {
    if (error instanceof PluginDashboardServiceError) {
      return respond(errorStatus(error), { error: error.code }, error.code);
    }
    return respond(502, { error: 'upstream_unavailable' }, 'upstream_unavailable');
  }
}
