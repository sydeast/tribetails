import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * #1854: at 1372px the Kinfolk profile hero put "Directory /", "Kinfolk /" and
 * the name on a line each, and broke a two-word name in two, because seven
 * header buttons squeezed the identity block to a sliver. jsdom does no layout,
 * so the rules themselves are what is checked: the identity has a real basis
 * and a floor above the phone breakpoint, so the band wraps the buttons under
 * it, and the trail holds to one line.
 */
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, 'KinfolkProfile.css'), 'utf8');

function desktopBlock(): string {
  const start = css.indexOf('@media (min-width: 721px)');
  expect(start, 'the desktop rule is declared').toBeGreaterThanOrEqual(0);
  // The media block ends at the first line that is a bare closing brace.
  const end = css.indexOf('\n}', start);
  return css.slice(start, end);
}

function rule(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start, `${selector} is declared`).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf('}', start));
}

describe('Kinfolk profile hero (#1854)', () => {
  it('the hero row may wrap', () => {
    expect(rule(css, '.kprofile__hero')).toContain('flex-wrap: wrap');
  });

  it('the identity keeps a basis and a floor, so the buttons wrap under it instead', () => {
    const main = rule(desktopBlock(), '.kprofile__hero .den-heading-main');
    expect(main).toMatch(/flex: 1 1 \d+rem/);
    expect(main).toMatch(/min-width: \d+rem/);
  });

  it('the trail stays on one line', () => {
    const crumbs = rule(desktopBlock(), '.kprofile__hero .den-crumbs ol');
    expect(crumbs).toContain('flex-wrap: nowrap');
    expect(crumbs).toContain('white-space: nowrap');
  });

  it('none of it applies at phone width, where the kit already stacks the buttons', () => {
    const outside = css.replace(desktopBlock(), '');
    expect(outside).not.toContain('.kprofile__hero .den-heading-main');
  });
});
