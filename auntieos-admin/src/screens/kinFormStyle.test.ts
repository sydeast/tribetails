import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * #1602: on the Kin edit form the notes box drew an extra white outline (its
 * fieldset had no class, so the browser's default groove border showed) and
 * Breed was the one uppercase label among sentence-case ones.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf8');

function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} is declared`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

describe('Kin form styling (#1602)', () => {
  it('every fieldset on the Kin edit form carries a class that removes the default border', () => {
    const tsx = read('KinEdit.tsx');
    expect(tsx).not.toMatch(/<fieldset(?![^>]*className=)/);
    expect(block(read('KinEdit.css'), '.kedit__fieldset')).toContain('border: none');
  });

  it('the Breed label is sentence case, like the labels beside it', () => {
    const label = block(read('../components/BreedField.css'), '.breedfield__label');
    expect(label).not.toContain('text-transform');
  });
});
