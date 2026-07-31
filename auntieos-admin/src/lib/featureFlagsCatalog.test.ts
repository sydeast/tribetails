import { describe, it, expect } from 'vitest';
import {
  KEYS,
  DEFAULTS,
  ALWAYS_ON,
  fromOverrides,
  KEY_COMMUNICATE_BROADCAST,
  KEY_INVOICES_CREATE,
  KEY_COMMUNICATE_COMMS_RECAP,
} from './featureFlagsCatalog';

describe('featureFlagsCatalog', () => {
  it('every key is namespaced and unique', () => {
    expect(KEYS.every((k) => k.startsWith('auntieos.'))).toBe(true);
    expect(new Set(KEYS).size).toBe(KEYS.length);
  });

  it('every ALWAYS_ON key defaults true', () => {
    for (const key of ALWAYS_ON) {
      expect(DEFAULTS[key]).toBe(true);
    }
  });

  it('fromOverrides applies a known, non-always-on key and ignores an unknown key', () => {
    const result = fromOverrides({
      [KEY_INVOICES_CREATE]: true,
      'auntieos.totally.bogus': true,
    });
    expect(result[KEY_INVOICES_CREATE]).toBe(true);
    expect(result[KEY_COMMUNICATE_COMMS_RECAP]).toBe(false); // untouched default
    expect(result['auntieos.totally.bogus']).toBeUndefined();
  });

  it('fromOverrides keeps every default for an empty override map', () => {
    expect(fromOverrides({})).toEqual(DEFAULTS);
  });

  it('toMap/fromOverrides round-trips losslessly through repeated application', () => {
    const once = fromOverrides({ [KEY_INVOICES_CREATE]: true, [KEY_COMMUNICATE_COMMS_RECAP]: true });
    const twice = fromOverrides(once);
    expect(twice).toEqual(once);
  });

  // 2026-06-08 prod regression (recorded in both Kotlin registries): a stale
  // `auntieos.communicate.broadcast: false` doc dark-gated the live Broadcast
  // feature. ALWAYS_ON keys must be immune to remote overrides so a shipped,
  // always-on feature can never be silently killed. Ported here because this
  // client had no such immunity before this file existed.
  it('an ALWAYS_ON flag is immune to a stale false override', () => {
    const result = fromOverrides({ [KEY_COMMUNICATE_BROADCAST]: false });
    expect(result[KEY_COMMUNICATE_BROADCAST]).toBe(true);
    expect(result).toEqual(DEFAULTS);
  });

  it('every ALWAYS_ON key survives a false override', () => {
    const allOff = Object.fromEntries([...ALWAYS_ON].map((key) => [key, false]));
    const result = fromOverrides(allOff);
    for (const key of ALWAYS_ON) {
      expect(result[key]).toBe(true);
    }
  });

});
