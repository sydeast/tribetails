// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DISCARDED_ADD_KINFOLK_STORAGE_PREFIX,
  PENDING_ADD_KINFOLK_STORAGE_PREFIX,
  clearDiscardedAddKinfolk,
  clearDuplicateAddKinfolk,
  clearPendingAddKinfolk,
  pendingHouseholdName,
  readDiscardedAddKinfolk,
  readDuplicateAddKinfolk,
  readPendingAddKinfolk,
  saveDiscardedAddKinfolk,
  saveDuplicateAddKinfolk,
  savePendingAddKinfolk,
  type PendingAddKinfolk,
} from './pendingAddKinfolk';

function pending(over: Partial<PendingAddKinfolk> = {}): PendingAddKinfolk {
  return {
    kinfolkId: 'kf-new',
    household: {
      firstName: 'Jamie',
      lastName: 'Halbrook',
      phoneNumber: '(805) 555-0134',
      email: 'jamie@example.com',
      status: 'active',
      serviceAddress: '1 Bark Ave',
    },
    contacts: [{ name: 'Rae Halbrook', phone: '8055550199', relationship: '' }],
    ...over,
  };
}

beforeEach(() => {
  sessionStorage.clear();
  for (const uid of ['op-1', 'op-2']) {
    clearPendingAddKinfolk(uid);
    clearDiscardedAddKinfolk(uid);
    clearDuplicateAddKinfolk(uid);
  }
});
afterEach(() => vi.restoreAllMocks());

describe('pendingAddKinfolk (#890)', () => {
  it('keeps the pending household per operator, in session storage', () => {
    savePendingAddKinfolk('op-1', pending());
    expect(readPendingAddKinfolk('op-1')).toEqual(pending());
    expect(readPendingAddKinfolk('op-2')).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(`${PENDING_ADD_KINFOLK_STORAGE_PREFIX}op-1`) ?? 'null')).toEqual(pending());
  });

  it('reads one left by an earlier page load of this session', () => {
    sessionStorage.setItem(`${PENDING_ADD_KINFOLK_STORAGE_PREFIX}op-1`, JSON.stringify(pending({ kinfolkId: 'kf-before-reload' })));
    expect(readPendingAddKinfolk('op-1')?.kinfolkId).toBe('kf-before-reload');
  });

  it('clears it', () => {
    savePendingAddKinfolk('op-1', pending());
    clearPendingAddKinfolk('op-1');
    expect(readPendingAddKinfolk('op-1')).toBeNull();
    expect(sessionStorage.getItem(`${PENDING_ADD_KINFOLK_STORAGE_PREFIX}op-1`)).toBeNull();
  });

  it('ignores a stored value it cannot read', () => {
    sessionStorage.setItem(`${PENDING_ADD_KINFOLK_STORAGE_PREFIX}op-1`, '{not json');
    expect(readPendingAddKinfolk('op-1')).toBeNull();
    sessionStorage.setItem(`${PENDING_ADD_KINFOLK_STORAGE_PREFIX}op-1`, JSON.stringify({ kinfolkId: '' }));
    expect(readPendingAddKinfolk('op-1')).toBeNull();
  });

  it('still keeps it for this page when session storage refuses writes', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    savePendingAddKinfolk('op-1', pending());
    expect(readPendingAddKinfolk('op-1')).toEqual(pending());
  });

  it('keeps nothing without a signed-in operator', () => {
    savePendingAddKinfolk(null, pending());
    expect(readPendingAddKinfolk(null)).toBeNull();
    saveDiscardedAddKinfolk(null, 'kf-left');
    expect(readDiscardedAddKinfolk(null)).toBeNull();
    saveDuplicateAddKinfolk(null, pending());
    expect(readDuplicateAddKinfolk(null, 'kf-new')).toBeNull();
  });

  it('names the household by its name, or says "this household" when it has none', () => {
    expect(pendingHouseholdName(pending())).toBe('Jamie Halbrook');
    expect(pendingHouseholdName(pending({ household: { ...pending().household, firstName: ' ', lastName: '' } }))).toBe('this household');
  });
});

describe('the discarded household (#907 review item 1a)', () => {
  it('keeps the id per operator, in session storage, until cleared', () => {
    saveDiscardedAddKinfolk('op-1', 'kf-left');
    expect(readDiscardedAddKinfolk('op-1')).toBe('kf-left');
    expect(readDiscardedAddKinfolk('op-2')).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(`${DISCARDED_ADD_KINFOLK_STORAGE_PREFIX}op-1`) ?? 'null')).toBe('kf-left');
    clearDiscardedAddKinfolk('op-1');
    expect(readDiscardedAddKinfolk('op-1')).toBeNull();
  });
});

describe('a duplicate Add (#907 review item 1b)', () => {
  it('hands the typing only to the household it was for, and only to that operator', () => {
    saveDuplicateAddKinfolk('op-1', pending({ kinfolkId: 'kf-existing' }));
    expect(readDuplicateAddKinfolk('op-1', 'kf-existing')?.household.lastName).toBe('Halbrook');
    expect(readDuplicateAddKinfolk('op-1', 'kf-other')).toBeNull();
    expect(readDuplicateAddKinfolk('op-2', 'kf-existing')).toBeNull();
    clearDuplicateAddKinfolk('op-1');
    expect(readDuplicateAddKinfolk('op-1', 'kf-existing')).toBeNull();
  });
});
