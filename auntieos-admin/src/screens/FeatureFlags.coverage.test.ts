import { describe, it, expect } from 'vitest';
import { FLAGS } from './FeatureFlags';
import { KEYS, ALWAYS_ON } from '../lib/featureFlagsCatalog';

/**
 * Guards that the admin Feature Flags screen lists EXACTLY the registry's
 * genuinely-gated keys: no flag can be silently missing from the toggles, and
 * no stale/typo'd key can linger after a rename. Ports the Kotlin
 * FeatureFlagsScreenCoverageTest idea (android + composeApp) to the one client
 * that had no registry to check the screen against.
 */
describe('FeatureFlags screen coverage', () => {
  it('lists exactly the gated registry keys (KEYS minus ALWAYS_ON)', () => {
    const rowKeys = new Set(FLAGS.map((f) => f.key));
    const expected = new Set(KEYS.filter((key) => !ALWAYS_ON.has(key)));
    expect(rowKeys).toEqual(expected);
  });

  it('has no duplicate flag rows', () => {
    const keys = FLAGS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // #1891: a flag's label and description are for the owner. A function name
  // (recap_recent_comms), the word "callable", a plan phase or a vendor's
  // plumbing term on this screen is developer wording.
  it('describes every flag without function names or developer wording', () => {
    const developer = /\b[a-z]+_[a-z0-9_]+\b|callable|\bPhase \d|WARNING-\d|\bFCM\b|webhook|\bvuln/i;
    for (const flag of FLAGS) {
      expect(`${flag.label} ${flag.detail}`).not.toMatch(developer);
    }
  });
});
