import { describe, it, expect } from 'vitest';
import {
  matchesCriteria,
  resolveRecipientsFromKinfolk,
  describeCriteria,
  CriteriaSchema,
  type KinfolkLike,
} from '../src/admin/audienceCriteria';

const k = (over: Partial<KinfolkLike>): KinfolkLike => ({
  id: 'k1',
  status: 'active',
  tags: [],
  email: 'a@b.com',
  phoneNumber: '+14155552671',
  uid: 'u1',
  ...over,
});

describe('matchesCriteria - all', () => {
  it('matches every non-archived kinfolk', () => {
    expect(matchesCriteria(k({ status: 'active' }), { kind: 'all' })).toBe(true);
    expect(matchesCriteria(k({ status: 'prospect' }), { kind: 'all' })).toBe(true);
  });
  it('never matches an archived kinfolk, regardless of kind', () => {
    expect(matchesCriteria(k({ status: 'archived' }), { kind: 'all' })).toBe(false);
    expect(matchesCriteria(k({ status: 'Archived', tags: ['vip'] }), { kind: 'tags', tags: ['vip'] })).toBe(false);
  });
});

describe('matchesCriteria - status', () => {
  it('matches case-insensitively against the wanted list', () => {
    const c = { kind: 'status' as const, statuses: ['Active', 'prospect'] };
    expect(matchesCriteria(k({ status: 'active' }), c)).toBe(true);
    expect(matchesCriteria(k({ status: 'PROSPECT' }), c)).toBe(true);
    expect(matchesCriteria(k({ status: 'inactive' }), c)).toBe(false);
  });
});

describe('matchesCriteria - tags', () => {
  it("'any' matches when at least one tag overlaps", () => {
    const c = { kind: 'tags' as const, tags: ['vip', 'monthly'], tagMatch: 'any' as const };
    expect(matchesCriteria(k({ tags: ['vip'] }), c)).toBe(true);
    expect(matchesCriteria(k({ tags: ['other'] }), c)).toBe(false);
  });
  it("'all' requires every wanted tag present", () => {
    const c = { kind: 'tags' as const, tags: ['vip', 'monthly'], tagMatch: 'all' as const };
    expect(matchesCriteria(k({ tags: ['vip', 'monthly', 'x'] }), c)).toBe(true);
    expect(matchesCriteria(k({ tags: ['vip'] }), c)).toBe(false);
  });
  it("defaults to 'any' when tagMatch omitted", () => {
    const c = { kind: 'tags' as const, tags: ['vip'] };
    expect(matchesCriteria(k({ tags: ['vip'] }), c)).toBe(true);
  });
});

describe('resolveRecipientsFromKinfolk', () => {
  it('filters a list down to matching recipients', () => {
    const all = [
      k({ id: 'a', status: 'active' }),
      k({ id: 'b', status: 'archived' }),
      k({ id: 'c', status: 'inactive' }),
    ];
    const out = resolveRecipientsFromKinfolk(all, { kind: 'status', statuses: ['active'] });
    expect(out.map((r) => r.id)).toEqual(['a']);
  });
});

describe('CriteriaSchema validation', () => {
  it('rejects a status segment with no statuses', () => {
    expect(CriteriaSchema.safeParse({ kind: 'status', statuses: [] }).success).toBe(false);
  });
  it('rejects a tag segment with no tags', () => {
    expect(CriteriaSchema.safeParse({ kind: 'tags', tags: [] }).success).toBe(false);
  });
  it('accepts a well-formed all segment', () => {
    expect(CriteriaSchema.safeParse({ kind: 'all' }).success).toBe(true);
  });
});

describe('describeCriteria', () => {
  it('renders a human one-liner per kind', () => {
    expect(describeCriteria({ kind: 'all' })).toContain('All active');
    expect(describeCriteria({ kind: 'status', statuses: ['active'] })).toContain('active');
    expect(describeCriteria({ kind: 'tags', tags: ['vip'], tagMatch: 'all' })).toContain('vip');
  });
});
