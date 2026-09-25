import { describe, it, expect } from 'vitest';
import Handlebars from 'handlebars';
import { SEED_CORPUS } from '../src/notifications/seedCorpus.generated';
import { sendPartsFor } from '../src/lib/emailFrame';
import { renderEmailParts } from '../src/lib/email';
import { sampleDataFor } from '../src/admin/previewEmailTemplate';
import { stripUnresolvedTokens } from '../src/notifications/templateParsers';

/**
 * #953 review fix, permanent regression guard: every seed, sent for real
 * (sendPartsFor + renderEmailParts, real Handlebars) with the same sample
 * data the editor's own preview uses (`sampleDataFor`). `seedVisualIntegrity
 * .test.ts` checks each seed's markup and token spellings in isolation; this
 * checks the thing an operator actually receives -- a template does not
 * throw, leaves no raw `{{token}}` behind, and every button survives into
 * the plain-text part with the address it actually renders to.
 *
 * The two `{{#each visits}}` seeds (assignment.assigned,
 * kincare.booking.confirm) get a real two-item `visits` array in place of
 * `sampleDataFor`'s placeholder string -- see emailFrame.test.ts for the
 * dedicated loop-rendering assertions this sweep does not repeat.
 */
const LOOP_SEED_KEYS = new Set(['assignment.assigned', 'kincare.booking.confirm']);
const SAMPLE_VISITS = [
  { weekday: 'Thu', date: 'Sep 4', time: '9:00 AM' },
  { weekday: 'Fri', date: 'Sep 5', time: '10:00 AM' },
];

/** Every `<a ... class="button">Label</a>` in a seed's raw content, as {label, href}. */
function buttonsIn(content: string): Array<{ label: string; href: string }> {
  const out: Array<{ label: string; href: string }> = [];
  for (const m of content.matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)) {
    const [, attrs, label] = m;
    if (!/class="button"/.test(attrs)) continue;
    const hrefMatch = attrs.match(/href="([^"]*)"/);
    if (!hrefMatch) continue;
    out.push({ label, href: hrefMatch[1] });
  }
  return out;
}

/** The value a raw href (possibly a `{{token}}`) renders to with the same data as the send. */
function renderHref(href: string, data: Record<string, unknown>): string {
  return stripUnresolvedTokens(Handlebars.compile(href, { noEscape: true })(data));
}

describe('every seed renders for real, end to end', () => {
  for (const seed of SEED_CORPUS) {
    it(`${seed.key}: sends without throwing, no leftover {{ }}, buttons survive into text`, () => {
      const doc = {
        subject: seed.emailSubject,
        format: 'visual' as const,
        headline: seed.emailHeadline,
        content: seed.emailContent,
      };
      const data = { ...sampleDataFor(seed.key), ...(LOOP_SEED_KEYS.has(seed.key) ? { visits: SAMPLE_VISITS } : {}) };

      const out = renderEmailParts({ ...sendPartsFor(doc), data });

      expect(out.subject).not.toContain('{{');
      expect(out.text).not.toContain('{{');
      expect(out.html ?? '').not.toContain('{{');
      expect(out.html).toContain('<div class="header">');
      expect(out.text.trim().length).toBeGreaterThan(0);

      for (const { label, href } of buttonsIn(seed.emailContent)) {
        expect(out.text).toContain(`${label}: ${renderHref(href, data)}`);
      }
    });
  }

  it('there are 52 seeds, all covered above', () => {
    expect(SEED_CORPUS.length).toBe(52);
  });
});
