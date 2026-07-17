import { describe, it, expect, vi, beforeEach } from 'vitest';

const { addDoc, collection, serverTimestamp } = vi.hoisted(() => ({
  addDoc: vi.fn(),
  collection: vi.fn(),
  serverTimestamp: vi.fn(),
}));
vi.mock('firebase/firestore', () => ({ addDoc, collection, serverTimestamp }));
vi.mock('../lib/firebase', () => ({ db: {} }));

import { createKinfolk, createKin, type NewKinfolkInput, type NewKinInput } from './directoryWrite';

function kinfolkInput(over: Partial<NewKinfolkInput> = {}): NewKinfolkInput {
  return {
    firstName: 'Jamie',
    lastName: 'Halbrook',
    phoneNumber: '(512) 555-1234',
    email: 'jamie@example.com',
    status: 'active',
    serviceAddress: '123 Bark Ave',
    ...over,
  };
}

function kinInput(over: Partial<NewKinInput> = {}): NewKinInput {
  return {
    kinfolkId: 'kf1',
    name: 'Biscuit',
    species: 'Dog',
    breed: 'Corgi',
    age: '3',
    sex: 'Female',
    ...over,
  };
}

beforeEach(() => {
  addDoc.mockReset();
  collection.mockReset();
  serverTimestamp.mockReset();
  collection.mockImplementation((_db: unknown, path: string) => `collection-ref:${path}`);
  serverTimestamp.mockReturnValue('server-timestamp-sentinel');
});

describe('createKinfolk', () => {
  it('adds to the top-level kinfolk collection with the trimmed fields plus real Kinfolk model defaults', async () => {
    addDoc.mockResolvedValue({ id: 'new-kf-1' });
    const id = await createKinfolk(kinfolkInput({ firstName: '  Jamie  ', lastName: '  Halbrook  ' }));
    expect(id).toBe('new-kf-1');
    expect(collection).toHaveBeenCalledWith({}, 'kinfolk');
    expect(addDoc).toHaveBeenCalledWith('collection-ref:kinfolk', {
      firstName: 'Jamie',
      lastName: 'Halbrook',
      phoneNumber: '(512) 555-1234',
      email: 'jamie@example.com',
      status: 'active',
      serviceAddress: '123 Bark Ave',
      profilePictureUrl: '',
      joinDate: '',
    });
  });

  it('rejects a blank first name without calling addDoc', async () => {
    await expect(createKinfolk(kinfolkInput({ firstName: '   ' }))).rejects.toThrow(/first name/i);
    expect(addDoc).not.toHaveBeenCalled();
  });

  it('rejects a blank last name without calling addDoc', async () => {
    await expect(createKinfolk(kinfolkInput({ lastName: '' }))).rejects.toThrow(/last name/i);
    expect(addDoc).not.toHaveBeenCalled();
  });

  it('propagates a genuine write failure for the caller to surface fail-loud', async () => {
    addDoc.mockRejectedValue(new Error('permission-denied'));
    await expect(createKinfolk(kinfolkInput())).rejects.toThrow('permission-denied');
  });
});

describe('createKin', () => {
  it('adds to the top-level kin collection with the trimmed fields, a stamped updatedAt, and status always active', async () => {
    addDoc.mockResolvedValue({ id: 'new-kin-1' });
    const id = await createKin(kinInput({ name: '  Biscuit  ', species: ' Dog ', sex: ' Female ' }));
    expect(id).toBe('new-kin-1');
    expect(collection).toHaveBeenCalledWith({}, 'kin');
    expect(addDoc).toHaveBeenCalledWith('collection-ref:kin', {
      kinfolkId: 'kf1',
      name: 'Biscuit',
      species: 'Dog',
      breed: 'Corgi',
      age: '3',
      sex: 'Female',
      status: 'active',
      profilePictureUrl: '',
      updatedAt: 'server-timestamp-sentinel',
    });
  });

  it('rejects a blank kinfolkId (no household chosen) without calling addDoc', async () => {
    await expect(createKin(kinInput({ kinfolkId: '' }))).rejects.toThrow(/household/i);
    expect(addDoc).not.toHaveBeenCalled();
  });

  it('rejects a blank name without calling addDoc', async () => {
    await expect(createKin(kinInput({ name: '  ' }))).rejects.toThrow(/name/i);
    expect(addDoc).not.toHaveBeenCalled();
  });

  it('rejects a blank species without calling addDoc', async () => {
    await expect(createKin(kinInput({ species: '' }))).rejects.toThrow(/species/i);
    expect(addDoc).not.toHaveBeenCalled();
  });

  it('rejects a blank gender/sex without calling addDoc', async () => {
    await expect(createKin(kinInput({ sex: '' }))).rejects.toThrow(/gender/i);
    expect(addDoc).not.toHaveBeenCalled();
  });

  it('propagates a genuine write failure for the caller to surface fail-loud', async () => {
    addDoc.mockRejectedValue(new Error('permission-denied'));
    await expect(createKin(kinInput())).rejects.toThrow('permission-denied');
  });
});
