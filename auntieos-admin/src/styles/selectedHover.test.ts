import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * #1597: hovering a selected control must not change how it looks.
 *
 * Every control below has a `.x:hover` rule (two classes' worth of
 * specificity: a class and a pseudo-class) and a selected rule `.x--active`
 * (one class). On hover the hover rule won, so the active Day/Week/Month
 * segment turned its label cream on a cream fill and the active sidebar row
 * lost its fill. Each selected rule now also lists a hover twin that outranks
 * the base hover, so the selected look holds while the pointer is on it.
 *
 * Read as text, like tokens.test.ts: jsdom does not apply these sheets, and
 * the thing at risk is what is declared.
 */

function css(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

/** [stylesheet, base class, selected selector]. */
const CONTROLS: readonly (readonly [string, string, string])[] = [
  ['./shell.css', 'shell__link', '.shell__link--active'],
  ['./shell.css', 'shell__account', '.shell__account--active'],
  ['../screens/Schedule.css', 'schedule__tab', '.schedule__tab--active'],
  ['../screens/Communicate.css', 'communicate__tab', '.communicate__tab--active'],
  ['../screens/Communicate.css', 'communicate__mode', '.communicate__mode--active'],
  ['../components/ListToolbar.css', 'list-toolbar__chip', '.list-toolbar__chip--active'],
  ['./screens.css', 'notif-chip', '.notif-chip--active'],
  ['../screens/Inbox.css', 'inbox__tab', '.inbox__tab--active'],
  ['../screens/Invoices.css', 'invoices__tab', '.invoices__tab--active'],
  ['../screens/Templates.css', 'templates__tab', '.templates__tab--active'],
  ['../screens/TribalIntel.css', 'tribal-intel__tab', '.tribal-intel__tab--active'],
  ['../screens/NotificationGate.css', 'notifgate__tab', '.notifgate__tab--active'],
  ['../screens/ActivityLog.css', 'activity__chip', ".activity__chip[aria-selected='true']"],
  ['../components/TribalIntelForm.css', 'tribal-form__chip', '.tribal-form__chip--active'],
  ['../screens/FormSchemaEditor.css', 'fse__chip', '.fse__chip--on'],
  ['../screens/FormSchemaEditor.css', 'fse__seg-btn', '.fse__seg-btn--on'],
];

/** The selector list of the rule that declares `selected` alone on a line. */
function selectorListOf(sheet: string, selected: string): string[] {
  const lines = sheet.split('\n');
  const at = lines.findIndex((l) => l.trim() === `${selected},` || l.trim() === `${selected} {`);
  if (at < 0) return [];
  const out: string[] = [];
  for (let i = at; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    out.push(line.replace(/[,{]\s*$/, '').trim());
    if (line.endsWith('{')) break;
  }
  return out;
}

describe('#1597 selected controls keep their look on hover', () => {
  for (const [file, base, selected] of CONTROLS) {
    it(`${selected} carries a hover twin that outranks .${base}:hover`, () => {
      const list = selectorListOf(css(file), selected);
      expect(list, `${selected} rule not found in ${file}`).toContain(selected);
      const twin = list.find((s) => s.includes(':hover'));
      expect(twin, `${selected} has no :hover twin`).toBeDefined();
      // More than `.base:hover`: the twin must name the base class AND the
      // selected marker, so it carries at least one more class or attribute.
      const weight = (twin!.match(/\.[\w-]+|\[[^\]]+\]|:hover/g) ?? []).length;
      expect(weight, twin).toBeGreaterThan(2);
    });
  }
});
