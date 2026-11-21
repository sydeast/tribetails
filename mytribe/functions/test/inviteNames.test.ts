import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEventFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));

import {
  INVITE_GREETING_FALLBACK,
  INVITE_TRIBE_FALLBACK,
  inviteNamesFor,
  kinfolkPersonName,
} from '../src/lib/inviteNames';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEventFn.mockReset();
});

/**
 * #2487: the portal invite greeted the address it was sent to and, from
 * `mintInvite`, named the household by its record id. The names now come off
 * the household's records, and an address or an id is never one.
 */
describe('inviteNamesFor', () => {
  it("greets the person by name and names the household by its own name", async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        docs: {
          'kinfolk/fam1': { firstName: 'Maya', lastName: 'Rivera', email: 'catch@hanasamku.com' },
          'families/fam1': { displayName: 'The Rivera Home' },
        },
      }).db,
    );
    await expect(inviteNamesFor('fam1', { caller: 't' })).resolves.toEqual({
      primaryDisplayName: 'Maya Rivera',
      tribeName: 'The Rivera Home',
      kinfolkName: 'Maya Rivera',
    });
  });

  it("uses the household's name for the greeting when no person's name is on file", async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: { 'families/fam1': { displayName: 'The Rivera Home' } } }).db);
    const names = await inviteNamesFor('fam1', { caller: 't' });
    expect(names.primaryDisplayName).toBe('The Rivera Home');
    expect(names.tribeName).toBe('The Rivera Home');
  });

  it('uses the name the caller already holds before reading one', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: { 'families/fam1': { displayName: 'Stored name' } } }).db);
    const names = await inviteNamesFor('fam1', { householdName: 'The Rivera Home', caller: 't' });
    expect(names.tribeName).toBe('The Rivera Home');
  });

  it('never prints the record id or an address, even when that is all that is stored', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        docs: {
          'kinfolk/9fQ2abc': { displayName: 'catch@hanasamku.com' },
          'families/9fQ2abc': { displayName: 'catch@hanasamku.com' },
        },
      }).db,
    );
    const names = await inviteNamesFor('9fQ2abc', { caller: 't' });
    expect(names).toEqual({
      primaryDisplayName: INVITE_GREETING_FALLBACK,
      tribeName: INVITE_TRIBE_FALLBACK,
      kinfolkName: INVITE_GREETING_FALLBACK,
    });
    expect(JSON.stringify(names)).not.toMatch(/9fQ2abc|@/);
  });

  it('a failed read still names nothing wrong, and says so in the log', async () => {
    mocks.dbFn.mockReturnValue({
      collection: () => ({
        doc: () => ({ get: () => Promise.reject(new Error('unavailable')) }),
      }),
    });
    const names = await inviteNamesFor('fam1', { caller: 'mintInvite' });
    expect(names.primaryDisplayName).toBe(INVITE_GREETING_FALLBACK);
    expect(mocks.logEventFn).toHaveBeenCalledWith(
      expect.objectContaining({ function: 'mintInvite', event: 'invite.names.read_failed' }),
    );
  });
});

describe('kinfolkPersonName', () => {
  it('joins first and last, and falls back to a stored display name', () => {
    expect(kinfolkPersonName({ firstName: 'Maya', lastName: 'Rivera' })).toBe('Maya Rivera');
    expect(kinfolkPersonName({ displayName: 'Maya' })).toBe('Maya');
    expect(kinfolkPersonName({ firstName: 'catch@hanasamku.com' })).toBe('');
    expect(kinfolkPersonName(null)).toBe('');
  });
});
