import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ISSUE #1612: a long Google Calendar id (a `c_…@group.calendar.google.com`
 * string with no space to break at) pushed the Settings page sideways and the
 * app sidebar off screen. The grid column already refuses to grow
 * (`minmax(0, 1fr)`), but text inside it overflowed visibly: a settings hint or
 * a server message naming the id kept its full width.
 *
 * jsdom does no layout, so this reads the stylesheet the way tokenUsage.test.ts
 * does. Measured in Chromium on a 1200px page with the real stylesheets and an
 * 88-character id in a `.settingsEdit__hint`: the document was 1342px wide
 * before the rule and 1200px after.
 */
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Settings.css'), 'utf8');

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match?.[1] ?? '';
}

describe('Settings panel area', () => {
  it('breaks a long unbroken id inside any section instead of widening the page', () => {
    expect(ruleBody('.settings__panelArea')).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('still refuses to let the panel column grow past its track', () => {
    expect(ruleBody('.settings__panelArea')).toMatch(/min-width:\s*0/);
  });
});
