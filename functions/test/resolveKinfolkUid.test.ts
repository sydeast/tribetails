import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

import { resolveKinfolkUid } from '../src/lib/resolveKinfolkUid';

describe('resolveKinfolkUid', () => {
  it('HAPPY: returns uid when kinfolk doc has one', async () => {
    const ctx = buildDbMock({ docs: { 'kinfolk/kf1': { uid: 'user-abc' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    expect(await resolveKinfolkUid('kf1')).toBe('user-abc');
  });

  it('SAD: returns null when kinfolk doc missing', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    expect(await resolveKinfolkUid('missing')).toBeNull();
  });

  it('SAD: returns null when uid field is empty string', async () => {
    const ctx = buildDbMock({ docs: { 'kinfolk/kf1': { uid: '' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    expect(await resolveKinfolkUid('kf1')).toBeNull();
  });

  it('EDGE: returns null when uid field absent from doc', async () => {
    const ctx = buildDbMock({ docs: { 'kinfolk/kf1': { otherField: 'x' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    expect(await resolveKinfolkUid('kf1')).toBeNull();
  });
});
