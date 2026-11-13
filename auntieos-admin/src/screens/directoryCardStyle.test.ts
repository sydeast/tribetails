import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * #1964: a Directory card cut a 17-character, three-word name to its first two
 * words and three dots when a PROSPECT or ARCHIVED chip sat in the corner. The
 * name was held to one line (`white-space: nowrap` plus an ellipsis) inside a
 * head row that stops short of the chip. jsdom does no layout, so the rule
 * itself is what is checked here: the name wraps onto a second line and is
 * never cut, and the head row still leaves the corner to the chip.
 */
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, 'Directory.css'), 'utf8');

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} is declared`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

describe('Directory card name (#1964)', () => {
  it('wraps instead of being cut short', () => {
    const name = block('.directory__card-name');
    expect(name).not.toContain('nowrap');
    expect(name).not.toContain('text-overflow: ellipsis');
    expect(name).toContain('overflow-wrap: anywhere');
  });

  it('still keeps clear of the status chip in the corner', () => {
    expect(block('.directory__badge + .directory__card-head')).toMatch(/padding-right: \d+px/);
  });
});
