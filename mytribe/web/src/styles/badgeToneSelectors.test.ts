import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// #1922: every stylesheet ships in one bundle. The claim-invite page shell was a
// bare `.guest` (min-height: 100vh, auto margins, a flex column), so it also
// styled the KinTale comment badge `<span class="badge guest">` and drew it one
// screen tall. jsdom loads no stylesheet and cannot measure that, so this pins
// the selectors instead: a badge tone word never stands alone in a selector.
const TONES = ['guest', 'kin', 'done'];

/** Every compound selector (the part between combinators) in a stylesheet. */
function compounds(css: string): string[] {
  const out: string[] = [];
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of noComments.matchAll(/([^{}]+)\{/g)) {
    const prelude = match[1]!.trim();
    if (prelude.startsWith('@') || /^(from|to|\d+%)/.test(prelude)) continue;
    for (const selector of prelude.split(',')) {
      for (const part of selector.trim().split(/\s*[\s>+~]\s*/)) if (part !== '') out.push(part);
    }
  }
  return out;
}
/** True when a compound is the tone class alone, like `.guest` or `.guest:hover`. */
function isBareTone(compound: string, tone: string): boolean {
  const classes: string[] = compound.match(/\.[\w-]+/g) ?? [];
  const elementOrId = /^[a-z*#]/i.test(compound);
  return classes.includes(`.${tone}`) && classes.length === 1 && !elementOrId;
}

describe('badge tone classes never stand alone in a selector (#1922)', () => {
  const dirs = [resolve(__dirname), resolve(__dirname, '../components')];
  const sheets = dirs.flatMap((d) =>
    readdirSync(d)
      .filter((f) => f.endsWith('.css'))
      .map((f) => ({ name: f, css: readFileSync(resolve(d, f), 'utf8') })),
  );

  it('reads the stylesheets', () => {
    expect(sheets.map((s) => s.name)).toEqual(expect.arrayContaining(['auth.css', 'kintales.css']));
  });

  it('no stylesheet has a bare .guest, .kin or .done rule', () => {
    const offenders = sheets.flatMap((s) =>
      compounds(s.css)
        .filter((c) => TONES.some((t) => isBareTone(c, t)))
        .map((c) => `${s.name}: ${c}`),
    );
    expect(offenders).toEqual([]);
  });

  it('catches the shape that broke the badge', () => {
    expect(compounds('.guest { min-height: 100vh; }\n.guest .footnote { margin: 0 }').filter((c) => isBareTone(c, 'guest'))).toEqual([
      '.guest',
      '.guest',
    ]);
    expect(compounds('.badge.guest { color: red }').filter((c) => isBareTone(c, 'guest'))).toEqual([]);
  });

  it('the claim-invite shell has its own class', () => {
    expect(readFileSync(resolve(__dirname, 'auth.css'), 'utf8')).toMatch(/^\.claimpage\s*\{[^}]*min-height:\s*100vh/m);
  });
});
