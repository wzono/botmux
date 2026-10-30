import { describe, expect, it } from 'vitest';
import { projectCapacityFeedback } from '../src/core/dashboard-rows.js';
import type { Session } from '../src/types.js';

const NOW = Date.parse('2026-10-28T09:00:00.000Z');

describe('dashboard capacity feedback projection', () => {
  it('projects the exact current turn with position and age', () => {
    const session = { turnFeedback: {
      old: { version: 1, turnId: 'old', phase: 'capacity_waiting', updatedAt: new Date(NOW - 5_000).toISOString(), capacity: { state: 'waiting', position: 7, source: 'pty', startedAtMs: NOW - 10_000, updatedAtMs: NOW - 5_000 } },
      current: { version: 1, turnId: 'current', phase: 'capacity_waiting', updatedAt: new Date(NOW - 1_000).toISOString(), capacity: { state: 'waiting', position: 3, source: 'pty', startedAtMs: NOW - 2_000, updatedAtMs: NOW - 1_000 } },
    } } as Session;

    expect(projectCapacityFeedback(session, 'current', NOW)).toEqual({
      state: 'waiting', position: 3, observedAtMs: NOW - 1_000, ageMs: 1_000,
    });
  });

  it('projects stale without an old position and omits terminal/cleared rows', () => {
    const stale = { turnFeedback: {
      turn: { version: 1, turnId: 'turn', phase: 'capacity_stale', updatedAt: new Date(NOW).toISOString(), capacity: { state: 'stale', position: 99, source: 'pty', startedAtMs: NOW - 70_000, updatedAtMs: NOW - 61_000, staleAtMs: NOW } },
    } } as Session;
    expect(projectCapacityFeedback(stale, 'turn', NOW)).toEqual({
      state: 'stale', observedAtMs: NOW - 61_000, ageMs: 61_000,
    });

    const terminal = structuredClone(stale);
    terminal.turnFeedback!.turn!.phase = 'completed';
    expect(projectCapacityFeedback(terminal, 'turn', NOW)).toBeUndefined();
  });
});
