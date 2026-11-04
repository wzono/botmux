import { describe, expect, it } from 'vitest';
import { createCapacityRolloutStore } from '../src/services/capacity-rollout-store.js';
import { findConfigField } from '../src/services/bot-config-store.js';

describe('capacity rollout config status', () => {
  it('exposes a secret-free snapshot for CLI and IM status', () => {
    const store = createCapacityRolloutStore(process.env.SESSION_DATA_DIR!);
    const snapshot = store.snapshot();
    expect(snapshot).toEqual({ version: 1, phase: 'shadow', disabled: {} });
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|token|prompt|output/i);
  });

  it('registers immediate bounded per-bot reminder thresholds', () => {
    expect(findConfigField('capacityInteractiveReminderMinutes')).toMatchObject({
      effect: 'immediate', kind: 'number', min: 1, max: 60, clearable: true,
    });
    expect(findConfigField('capacityBackgroundReminderMinutes')).toMatchObject({
      effect: 'immediate', kind: 'number', min: 1, max: 240, clearable: true,
    });
  });
});
