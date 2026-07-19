import { describe, it, expect } from 'vitest';
import { suggestTags, addAssigned, removeAssigned } from './assign';
import { TAG_PALETTE, type TagDef } from './model';

const c = TAG_PALETTE[0]!;
function def(name: string): TagDef {
  return { name, color: c, icon: '' };
}
const vocab = [def('VIP'), def('Reactive'), def('Vet visit'), def('Feeding')];

describe('suggestTags', () => {
  it('returns every not-yet-assigned tag for an empty query', () => {
    expect(suggestTags('', vocab, ['VIP']).map((t) => t.name)).toEqual(['Reactive', 'Vet visit', 'Feeding']);
  });

  it('matches case-insensitively, ranking prefix matches before substring matches', () => {
    // "v" prefixes VIP + Vet visit; it is also a substring of Reactive (reacti-v-e).
    expect(suggestTags('v', vocab, []).map((t) => t.name)).toEqual(['VIP', 'Vet visit', 'Reactive']);
  });

  it('excludes tags already assigned', () => {
    expect(suggestTags('v', vocab, ['vip']).map((t) => t.name)).toEqual(['Vet visit', 'Reactive']);
  });

  it('returns nothing when nothing matches', () => {
    expect(suggestTags('zzz', vocab, [])).toEqual([]);
  });
});

describe('addAssigned', () => {
  it('appends a normalized name', () => {
    expect(addAssigned(['VIP'], '  Vet   visit ')).toEqual(['VIP', 'Vet visit']);
  });

  it('dedups case-insensitively (no double VIP)', () => {
    expect(addAssigned(['VIP'], 'vip')).toEqual(['VIP']);
  });

  it('is a no-op for a blank name', () => {
    const already = ['VIP'];
    expect(addAssigned(already, '   ')).toBe(already);
  });
});

describe('removeAssigned', () => {
  it('removes case-insensitively, leaving the rest', () => {
    expect(removeAssigned(['VIP', 'Reactive'], 'vip')).toEqual(['Reactive']);
  });
});
