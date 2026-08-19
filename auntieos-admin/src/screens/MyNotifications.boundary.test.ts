import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * #391: "each section needs a better differential." jsdom renders no cascade
 * (MyNotificationsEdit.test.tsx can see that a `<section>` exists and what
 * text is in it, never what it looks like), so nothing in that file could
 * have caught a boundary rendering at the same weight as a row hairline, or
 * weaker. This reads the stylesheet directly and pins the two facts that
 * make the boundary the strongest signal on the page rather than the
 * weakest, the way the issue asked:
 *
 *  - the rule between sections is --border-emphasis/--color-border, the same
 *    "outranks a hairline" idiom the invoice total-row dividers use
 *    (InvoiceLineItems.css, InvoiceLedger.css): heavier and darker than the
 *    --border-hairline/--color-border-soft every channel row already draws
 *  - the heading no longer sits on --color-text-faint, the faintest text
 *    token on the screen per the issue
 */

const cssPath = join(dirname(fileURLToPath(import.meta.url)), 'MyNotifications.css');
const css = readFileSync(cssPath, 'utf-8');

/** Body of the first `selector { ... }` block, exact selector only (not a prefix match). */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.]/g, '\\.');
  const match = css.match(new RegExp(`${escaped}(?![\\w-])\\s*{([^}]*)}`));
  const body = match?.[1];
  if (body === undefined) throw new Error(`No CSS rule found for selector "${selector}" in MyNotifications.css`);
  return body;
}

describe('MyNotifications.css section boundary (#391)', () => {
  it('the boundary rule outranks the channel row hairline it sits above', () => {
    const section = ruleBody('.mynotif__section');
    expect(section).toMatch(/border-top:\s*var\(--border-emphasis\)\s+solid\s+var\(--color-border\)\s*;/);

    // The row hairline it has to outrank, for contrast: one step down, on both
    // weight (--border-hairline vs --border-emphasis) and colour
    // (--color-border-soft vs --color-border).
    const row = ruleBody('.mynotif__channel-row');
    expect(row).toMatch(/border-bottom:\s*var\(--border-hairline\)\s+solid\s+var\(--color-border-soft\)\s*;/);
  });

  it('the first section in a hat carries no rule, having nothing above it to divide from', () => {
    const firstChild = ruleBody('.mynotif__section:first-child');
    expect(firstChild).toMatch(/border-top:\s*none\s*;/);
  });

  it('the section heading no longer sits on the faintest text token on the screen', () => {
    const heading = ruleBody('.mynotif__section-heading');
    expect(heading).not.toMatch(/--color-text-faint/);
    expect(heading).toMatch(/color:\s*var\(--color-text-dim\)\s*;/);
  });
});
