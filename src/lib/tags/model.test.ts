import { describe, it, expect } from 'vitest';
import {
  TAG_PALETTE,
  DEFAULT_TAG_COLOR,
  normalizeTagName,
  paletteColor,
  resolveTag,
  addTag,
  removeTag,
  editTag,
  type TagDef,
} from './model';

const teal = TAG_PALETTE[0]!;
const orange = TAG_PALETTE[1]!;

function def(name: string, over: Partial<TagDef> = {}): TagDef {
  return { name, color: teal, icon: '⭐', ...over };
}

describe('TAG_PALETTE', () => {
  it('is drawn from existing --color-* role tokens and defaults to the first entry', () => {
    expect(TAG_PALETTE.length).toBeGreaterThanOrEqual(7);
    for (const c of TAG_PALETTE) {
      expect(c.css).toMatch(/^var\(--color-[a-z]+\)$/);
      expect(c.token).not.toBe('');
    }
    expect(DEFAULT_TAG_COLOR).toEqual(TAG_PALETTE[0]);
  });

  it('resolves a palette entry by token, falling back to the default for an unknown token', () => {
    expect(paletteColor(orange.token)).toEqual(orange);
    expect(paletteColor('not-a-token')).toEqual(DEFAULT_TAG_COLOR);
  });
});

describe('normalizeTagName', () => {
  it('trims and collapses internal whitespace', () => {
    expect(normalizeTagName('  VIP  ')).toBe('VIP');
    expect(normalizeTagName('needs   meds')).toBe('needs meds');
  });
});

describe('resolveTag', () => {
  const vocab = [def('VIP', { icon: '⭐', color: orange }), def('Reactive', { icon: '', color: teal })];

  it('resolves a known tag to its canonical name, color, and icon (case-insensitive)', () => {
    const r = resolveTag('vip', vocab);
    expect(r.name).toBe('VIP');
    expect(r.color).toEqual(orange);
    expect(r.icon).toBe('⭐');
  });

  it('resolves a known tag whose icon is empty (color kept, icon empty string)', () => {
    const r = resolveTag('reactive', vocab);
    expect(r.color).toEqual(teal);
    expect(r.icon).toBe('');
  });

  it('resolves an unknown/free-form name to a neutral default (color + icon null), never throwing', () => {
    const r = resolveTag('brand new', vocab);
    expect(r).toEqual({ name: 'brand new', color: null, icon: null });
  });
});

describe('addTag', () => {
  it('appends a normalized entry without mutating the input', () => {
    const vocab = [def('VIP')];
    const next = addTag(vocab, def('  Needs   meds  ', { color: orange, icon: '💊' }));
    expect(next).toHaveLength(2);
    expect(next[1]).toEqual({ name: 'Needs meds', color: orange, icon: '💊' });
    expect(vocab).toHaveLength(1); // input untouched
  });

  it('rejects a blank name', () => {
    expect(() => addTag([], def('   '))).toThrow(/name is required/i);
  });

  it('rejects a name over the length cap', () => {
    expect(() => addTag([], def('x'.repeat(41)))).toThrow(/40 characters/i);
  });

  it('rejects a duplicate name case-insensitively', () => {
    expect(() => addTag([def('VIP')], def('vip'))).toThrow(/already exists/i);
  });
});

describe('removeTag', () => {
  it('drops the entry by name case-insensitively, leaving the rest', () => {
    const vocab = [def('VIP'), def('Reactive')];
    const next = removeTag(vocab, 'vip');
    expect(next.map((t) => t.name)).toEqual(['Reactive']);
    expect(vocab).toHaveLength(2); // input untouched
  });
});

describe('editTag', () => {
  it('changes color and/or icon by name, never the name itself', () => {
    const vocab = [def('VIP', { color: teal, icon: '⭐' })];
    const next = editTag(vocab, 'vip', { color: orange });
    expect(next[0]).toEqual({ name: 'VIP', color: orange, icon: '⭐' });
  });

  it('changes only the fields present in the patch', () => {
    const vocab = [def('VIP', { color: teal, icon: '⭐' })];
    const next = editTag(vocab, 'VIP', { icon: '🏅' });
    expect(next[0]).toEqual({ name: 'VIP', color: teal, icon: '🏅' });
  });

  it('leaves non-matching entries alone', () => {
    const vocab = [def('VIP'), def('Reactive', { color: teal })];
    const next = editTag(vocab, 'VIP', { color: orange });
    expect(next[1]).toEqual(vocab[1]);
  });
});
