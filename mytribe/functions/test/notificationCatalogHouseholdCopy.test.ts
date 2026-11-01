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
});
