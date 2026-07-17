import { describe, it, expect } from 'vitest';
import { accessFromClaims } from './access';

describe('accessFromClaims, the admin gate', () => {
  it('admits a real admin', () => {
    expect(accessFromClaims({ admin: true })).toEqual({ status: 'admin' });
  });

  it('admits a Stage 0I test admin, scoped to its testTribeId', () => {
    expect(accessFromClaims({ testTribeId: 'test-kinfolk-001' })).toEqual({
      status: 'testAdmin',
      testTribeId: 'test-kinfolk-001',
    });
  });

  it('prefers admin when a user somehow carries both', () => {
    expect(accessFromClaims({ admin: true, testTribeId: 'test-kinfolk-001' })).toEqual({
      status: 'admin',
    });
  });

  it('DENIES a plain kinfolk (portal creds) with no admin/test claim', () => {
    expect(accessFromClaims({ role: 'kinfolk', kinfolkId: 'k1' })).toEqual({ status: 'denied' });
    expect(accessFromClaims({})).toEqual({ status: 'denied' });
  });

  it('treats a non-true admin claim and a blank testTribeId as denied (no coercion)', () => {
    expect(accessFromClaims({ admin: 'true' })).toEqual({ status: 'denied' });
    expect(accessFromClaims({ admin: false, testTribeId: '   ' })).toEqual({ status: 'denied' });
  });
});
