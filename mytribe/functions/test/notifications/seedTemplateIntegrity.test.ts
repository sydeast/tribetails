import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Regression coverage for issue #387: every seed template except
 * auth.password.reset used to end its body with a literal dead CTA — an empty
 * bracket pair like "Open it here: []" — because `{{link}}` was only ever
 * populated for auth.password.reset. That shipped a broken call to action on
 * every channel that renders the body for every other notification.
 *
 * The fix removed the dead line/clause from the seeds rather than inventing a
 * URL builder (a bigger change, tracked separately). This guards against the
 * dead line creeping back in, on any file, for any key.
 */
describe('notification seed templates: no dead link placeholders', () => {
  const seedsDir = join(__dirname, '..', '..', '..', 'seeds', 'notificationTemplates');
  const keys = readdirSync(seedsDir).sort();

  it('found the seeds directory and it is non-empty (sanity check the test itself is not vacuous)', () => {
    expect(keys.length).toBeGreaterThan(0);
  });

  for (const key of keys) {
    const dir = join(seedsDir, key);
    const files = readdirSync(dir);

    for (const file of files) {
      it(`${key}/${file}: does not contain an empty "[]" bracket pair`, () => {
        const raw = readFileSync(join(dir, file), 'utf8');
        expect(raw).not.toMatch(/\[\]/);
      });
    }
  }

  it('auth.password.reset is untouched: {{link}} is still populated in both email files', () => {
    const dir = join(seedsDir, 'auth.password.reset');
    const html = readFileSync(join(dir, 'email.html'), 'utf8');
    const txt = readFileSync(join(dir, 'email.txt'), 'utf8');
    expect(html).toMatch(/\{\{link\}\}/);
    expect(txt).toMatch(/\{\{link\}\}/);
  });

  it('{{link}} appears nowhere outside auth.password.reset (no other key claims a link it never gets)', () => {
    const offenders: string[] = [];
    for (const key of keys) {
      if (key === 'auth.password.reset') continue;
      const dir = join(seedsDir, key);
      for (const file of readdirSync(dir)) {
        const raw = readFileSync(join(dir, file), 'utf8');
        if (/\{\{link\}\}/.test(raw)) offenders.push(`${key}/${file}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no seed body contains a bare "Open it here" (or similar) CTA with no populated link', () => {
    const offenders: string[] = [];
    for (const key of keys) {
      const dir = join(seedsDir, key);
      for (const file of readdirSync(dir)) {
        const raw = readFileSync(join(dir, file), 'utf8');
        // Historically this was "Open it here: []", "See it here: []", etc. —
        // a CTA phrase immediately followed by an unpopulated placeholder.
        if (/\b(here|below)\s*[:.]?\s*\[\]/i.test(raw)) offenders.push(`${key}/${file}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
