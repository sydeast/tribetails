import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// #1419: base.css hides .tabbar above the phone breakpoint. A second stylesheet
// declaring .tabbar (schedule.css did, imported later) overrode that and left
// the phone bar showing as bare links on desktop. jsdom loads no stylesheet, so
// computed style cannot be read; this pins ownership of the selector instead.
describe('.tabbar belongs to base.css alone (#1419)', () => {
  const dir = resolve(__dirname);
  const sheets = readdirSync(dir).filter((f) => f.endsWith('.css'));
  const ownsTabbar = (css: string) =>
    css.replace(/\/\*[\s\S]*?\*\//g, '').match(/(^|[^\w-])\.tabbar(?![\w-])[^{]*\{/gm) ?? [];
  it('base.css hides the bar by default', () => {
    expect(readFileSync(resolve(dir, 'base.css'), 'utf8')).toMatch(/^\.tabbar\s*\{\s*display:\s*none;/m);
  });
  it('no other stylesheet declares a .tabbar rule', () => {
    const offenders = sheets.filter((f) => f !== 'base.css' && ownsTabbar(readFileSync(resolve(dir, f), 'utf8')).length > 0);
    expect(offenders).toEqual([]);
  });
});
