import { describe, expect, it } from 'vitest';
import { NOTIFICATION_CATALOG } from '../src/notifications/catalog';
/**
 * #1317: the notification settings screen prints `label` and `description` for
 * every key whose audiences include the kinfolk stream. Those strings are read
 * by households, so they must not name vendors or describe plumbing.
 */
describe('household-visible notification copy', () => {
  const VENDOR_OR_PLUMBING = /smtp2go|twilio|stripe|sendgrid|firebase|cloudinary|mapbox|server-side|callable|webhook/i;
  const kinfolkDefs = Object.values(NOTIFICATION_CATALOG).filter((d) => d.audiences.kinfolk);
  it('covers a real set of keys', () => {
    expect(kinfolkDefs.length).toBeGreaterThan(20);
  });
  it.each(kinfolkDefs.map((d) => [d.key, d.label, d.description]))(
    '%s names no vendor and no plumbing',
    (_key, label, description) => {
      expect(`${label} ${description}`).not.toMatch(VENDOR_OR_PLUMBING);
    },
  );

  // #1359: `description` is the operator's text and also feeds the admin matrix.
  // The household reads `householdDescription`, written to them.
  describe('householdDescription', () => {
    const OPERATOR_VOICE = /\bkinfolk\b|\bkinfolk\/|\bthe household\b|debounce|digest|trailing|\bdefault\b|\d+\s*-?\s*(min|minutes|hours?)\b|\bdetected\b/i;
    it.each(kinfolkDefs.map((d) => [d.key, d.label, d.householdDescription]))(
      '%s has household copy in the household\'s voice',
      (_key, label, household) => {
        expect(typeof household).toBe('string');
        const text = String(household).trim();
        expect(text.length).toBeGreaterThan(10);
        expect(text.toLowerCase()).not.toBe(String(label).toLowerCase());
        expect(text).not.toMatch(VENDOR_OR_PLUMBING);
        expect(text).not.toMatch(OPERATOR_VOICE);
      },
    );
    // #1372: the title is household copy too. Same voice rules, and a title that
    // is just the operator's `label` must be a deliberate choice, not an omission.
    it.each(kinfolkDefs.map((d) => [d.key, d.householdTitle]))(
      '%s has a household title in the household\'s voice',
      (_key, title) => {
        expect(typeof title).toBe('string');
        const text = String(title).trim();
        expect(text.length).toBeGreaterThan(5);
        expect(text).not.toMatch(VENDOR_OR_PLUMBING);
        expect(text).not.toMatch(OPERATOR_VOICE);
        // `{business}` is the settings-name placeholder (#1381), not the word.
        expect(text.replace(/\{[Bb]usiness('s)?\}/g, '')).not.toMatch(/\bthe office\b|\bbusiness\b/i);
      },
    );
    it('leaves the operator label alone for the admin matrix', () => {
      expect(NOTIFICATION_CATALOG['quote.accepted'].label).toBe('Kinfolk accepted a quote');
      expect(NOTIFICATION_CATALOG['quote.accepted'].householdTitle).toBe('You accepted a quote');
    });
    it('leaves the operator text alone for the admin matrix', () => {
      expect(NOTIFICATION_CATALOG['kincare.changed'].description).toBe(
        'Kinfolk/Auntie updated, deleted, or requested changes to KinCare.',
      );
    });
  });
});
