import type { CapacityRolloutAdapter, CapacityRolloutPhase } from '../services/capacity-rollout-store.js';

const PHASES = new Set<CapacityRolloutPhase>(['shadow', 'traex', 'proxy', 'full', 'off']);
const ADAPTERS = new Set<CapacityRolloutAdapter>(['traex', 'codex', 'claude-code']);
const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export type CapacityCommand =
  | { type: 'status'; json: boolean }
  | { type: 'phase'; phase: CapacityRolloutPhase; json: boolean }
  | { type: 'disable'; appId: string; adapter: CapacityRolloutAdapter; reason: string; json: boolean }
  | { type: 'enable'; appId: string; adapter: CapacityRolloutAdapter; json: boolean };

const USAGE = 'usage: botmux capacity status [--json] | phase <shadow|traex|proxy|full|off> [--json] | disable <appId> <traex|codex|claude-code> --reason <text> [--json] | enable <appId> <adapter> [--json]';

export function parseCapacityCommand(argv: readonly string[]): CapacityCommand {
  const args = [...argv];
  const json = args.includes('--json');
  const clean = args.filter(arg => arg !== '--json');
  const sub = clean.shift() ?? 'status';
  if (sub === 'status' && clean.length === 0) return { type: 'status', json };
  if (sub === 'phase' && clean.length === 1 && PHASES.has(clean[0] as CapacityRolloutPhase)) {
    return { type: 'phase', phase: clean[0] as CapacityRolloutPhase, json };
  }
  if (sub === 'enable' && clean.length === 2 && APP_ID.test(clean[0]!)
    && ADAPTERS.has(clean[1] as CapacityRolloutAdapter)) {
    return { type: 'enable', appId: clean[0]!, adapter: clean[1] as CapacityRolloutAdapter, json };
  }
  if (sub === 'disable') {
    const reasonAt = clean.indexOf('--reason');
    const appId = clean[0];
    const adapter = clean[1] as CapacityRolloutAdapter | undefined;
    const reason = reasonAt === 2 ? clean.slice(3).join(' ').trim() : '';
    if (appId && APP_ID.test(appId) && adapter && ADAPTERS.has(adapter) && reason) {
      return { type: 'disable', appId, adapter, reason, json };
    }
  }
  throw new Error(`invalid or unknown capacity command; ${USAGE}`);
}

interface CapacityStore {
  snapshot(): { version: 1; phase: CapacityRolloutPhase; disabled: Record<string, { reason: string; at: string }> };
  setPhase(phase: CapacityRolloutPhase): void;
  disable(appId: string, adapter: CapacityRolloutAdapter, reason: string): void;
  enable(appId: string, adapter: CapacityRolloutAdapter): void;
}

export function runCapacityCommand(command: CapacityCommand, store: CapacityStore) {
  if (command.type === 'phase') store.setPhase(command.phase);
  if (command.type === 'disable') store.disable(command.appId, command.adapter, command.reason);
  if (command.type === 'enable') store.enable(command.appId, command.adapter);
  return { ok: true as const, ...store.snapshot() };
}
