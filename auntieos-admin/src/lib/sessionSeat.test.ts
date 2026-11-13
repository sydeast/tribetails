import { describe, it, expect, vi, beforeEach } from 'vitest';

const { authRef, getIdTokenResult } = vi.hoisted(() => ({
  authRef: { currentUser: null as { uid: string } | null },
  getIdTokenResult: vi.fn(),
}));
vi.mock('./firebase', () => ({ auth: authRef }));
vi.mock('firebase/auth', () => ({ getIdTokenResult }));

import { currentSessionSeat, seatKey } from './sessionSeat';

beforeEach(() => {
  authRef.currentUser = null;
  getIdTokenResult.mockReset();
});

describe('#2164 currentSessionSeat', () => {
  it('reads an Auntie claim as an Auntie', async () => {
    authRef.currentUser = { uid: 'a1' };
    getIdTokenResult.mockResolvedValue({ claims: { staffRole: 'auntie' } });
    await expect(currentSessionSeat()).resolves.toEqual({ uid: 'a1', caretaker: true });
  });

  it('reads an account holding both claims as an Auntie, as the gate and the server do', async () => {
    authRef.currentUser = { uid: 'both' };
    getIdTokenResult.mockResolvedValue({ claims: { admin: true, staffRole: 'auntie' } });
    await expect(currentSessionSeat()).resolves.toEqual({ uid: 'both', caretaker: true });
  });

  it('reads the owner, and an unknown role, as not an Auntie', async () => {
    authRef.currentUser = { uid: 'o1' };
    getIdTokenResult.mockResolvedValue({ claims: { admin: true } });
    await expect(currentSessionSeat()).resolves.toEqual({ uid: 'o1', caretaker: false });
    getIdTokenResult.mockResolvedValue({ claims: { staffRole: 'bookkeeper' } });
    await expect(currentSessionSeat()).resolves.toEqual({ uid: 'o1', caretaker: false });
  });

  it('with nobody signed in, reads no token at all', async () => {
    await expect(currentSessionSeat()).resolves.toEqual({ uid: '', caretaker: false });
    expect(getIdTokenResult).not.toHaveBeenCalled();
  });

  it('gives each session its own cache key', () => {
    expect(seatKey('k', { uid: 'u', caretaker: true })).not.toBe(seatKey('k', { uid: 'u', caretaker: false }));
    expect(seatKey('k', { uid: 'a', caretaker: false })).not.toBe(seatKey('k', { uid: 'b', caretaker: false }));
  });
});
