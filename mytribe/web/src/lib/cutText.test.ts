import { describe, it, expect } from 'vitest';
import { cutWhole } from './cutText';

const DOG = '\u{1F415}';
const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
const WOMAN_DOG = '\u{1F469}\u{1F3FD}\u200D\u{1F9AE}';
const FLAG = '\u{1F1FA}\u{1F1F8}';
const HEART = '\u2764\uFE0F';

describe('#2323 cutWhole: a cut never ends on part of a character', () => {
  it('leaves text that fits alone and cuts plain text at the limit', () => {
    expect(cutWhole('hello', 5)).toBe('hello');
    expect(cutWhole('abcdef', 4)).toBe('abcd');
  });
  it('steps back over an emoji the limit falls inside', () => {
    expect(cutWhole(`${'a'.repeat(59)}${DOG} tail`, 60)).toBe('a'.repeat(59));
  });
  it.each([
    ['a family joined with invisible joiners', FAMILY],
    ['a person with a skin tone and a dog', WOMAN_DOG],
    ['a flag', FLAG],
    ['a heart with its emoji mark', HEART],
  ])('never keeps part of %s, wherever the limit falls inside it', (_label, glyph) => {
    for (let lead = 60 - glyph.length + 1; lead < 60; lead++) {
      expect(cutWhole(`${'a'.repeat(lead)}${glyph} more`, 60)).toBe('a'.repeat(lead));
    }
    expect(cutWhole(`${'a'.repeat(60 - glyph.length)}${glyph} more`, 60)).toBe(`${'a'.repeat(60 - glyph.length)}${glyph}`);
  });
  it('a web address at the limit is cut as plain characters, never past the limit', () => {
    const text = `See ${'x'.repeat(50)} https://kinfolk.tribetails.com/kintales`;
    const cut = cutWhole(text, 60);
    expect(cut).toBe(text.slice(0, 60));
  });
  it('drops a character longer than the budget instead of halving it', () => {
    expect(cutWhole(FAMILY, 3)).toBe('');
    expect(cutWhole('abc', 0)).toBe('');
  });
});
