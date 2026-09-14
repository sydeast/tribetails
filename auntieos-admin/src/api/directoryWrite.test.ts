import { describe, it, expect, vi, beforeEach } from 'vitest';

const { addDoc, collection, serverTimestamp, doc, updateDoc } = vi.hoisted(() => ({
  addDoc: vi.fn(),
  collection: vi.fn(),
  serverTimestamp: vi.fn(),
  doc: vi.fn(),
  updateDoc: vi.fn(),
}));
vi.mock('firebase/firestore', () => ({ addDoc, collection, serverTimestamp, doc, updateDoc }));
vi.mock('../lib/firebase', () => ({ db: {} }));
const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import {
  createKinfolk,
  createKin,
  updateKinTags,
  updateKinfolkTags,
  type NewKinfolkInput,
  type NewKinInput,
} from './directoryWrite';

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
  call.mockReset();
  addDoc.mockReset();
  collection.mockReset();
  serverTimestamp.mockReset();
  doc.mockReset();
  updateDoc.mockReset();
  collection.mockImplementation((_db: unknown, path: string) => `collection-ref:${path}`);
  doc.mockImplementation((_db: unknown, path: string, id: string) => `doc-ref:${path}/${id}`);
  serverTimestamp.mockReturnValue('server-timestamp-sentinel');
});

describe('createKinfolk', () => {
  // #890: through the createKinfolk callable, never a direct add, so the server
  // can hand back a household this operator just created instead of a second one.
  it('creates through the createKinfolk callable with the trimmed fields plus real Kinfolk model defaults', async () => {
    call.mockResolvedValue({ kinfolkId: 'new-kf-1', duplicateOf: null });
    const res = await createKinfolk(kinfolkInput({ firstName: '  Jamie  ', lastName: '  Halbrook  ' }));
    expect(res).toEqual({ kinfolkId: 'new-kf-1', duplicateOf: null });
    expect(call).toHaveBeenCalledWith('createKinfolk', {
      kinfolk: {
        firstName: 'Jamie',
        lastName: 'Halbrook',
        phoneNumber: '(512) 555-1234',
        email: 'jamie@example.com',
        status: 'active',
        serviceAddress: '123 Bark Ave',
        profilePictureUrl: '',
        joinDate: '',
      },
    });
    expect(addDoc).not.toHaveBeenCalled();
  });

  it('passes on duplicateOf when the server hands back a household this operator just created', async () => {
    call.mockResolvedValue({ kinfolkId: 'kf-existing', duplicateOf: 'kf-existing' });
    expect(await createKinfolk(kinfolkInput())).toEqual({ kinfolkId: 'kf-existing', duplicateOf: 'kf-existing' });
  });

  it('refuses an answer with no household id', async () => {
    call.mockResolvedValue({ duplicateOf: null });
    await expect(createKinfolk(kinfolkInput())).rejects.toThrow(/no household id/);
  });

  it('rejects a blank first name without calling the callable', async () => {
    await expect(createKinfolk(kinfolkInput({ firstName: '   ' }))).rejects.toThrow(/first name/i);
    expect(call).not.toHaveBeenCalled();
  });

  it('rejects a blank last name without calling the callable', async () => {
    await expect(createKinfolk(kinfolkInput({ lastName: '' }))).rejects.toThrow(/last name/i);
    expect(call).not.toHaveBeenCalled();
  });

  it('propagates a genuine failure for the caller to surface fail-loud', async () => {
    call.mockRejectedValue(new Error('permission-denied'));
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

describe('updateKinTags', () => {
  it('merges the tag name list plus a stamped updatedAt onto the flat kin doc', async () => {
    updateDoc.mockResolvedValue(undefined);
    await updateKinTags('p1', ['Reactive', 'Feeding']);
    expect(doc).toHaveBeenCalledWith({}, 'kin', 'p1');
    expect(updateDoc).toHaveBeenCalledWith('doc-ref:kin/p1', {
      tags: ['Reactive', 'Feeding'],
      updatedAt: 'server-timestamp-sentinel',
    });
  });

  it('rejects a blank kin id without calling updateDoc', async () => {
    await expect(updateKinTags('  ', ['x'])).rejects.toThrow(/kin id/i);
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it('propagates a genuine write failure for the caller to surface fail-loud', async () => {
    updateDoc.mockRejectedValue(new Error('permission-denied'));
    await expect(updateKinTags('p1', [])).rejects.toThrow('permission-denied');
  });
});

describe('updateKinfolkTags', () => {
  it('merges the tag name list plus a stamped updatedAt onto the kinfolk doc', async () => {
    updateDoc.mockResolvedValue(undefined);
    await updateKinfolkTags('kf1', ['VIP']);
    expect(doc).toHaveBeenCalledWith({}, 'kinfolk', 'kf1');
    expect(updateDoc).toHaveBeenCalledWith('doc-ref:kinfolk/kf1', {
      tags: ['VIP'],
      updatedAt: 'server-timestamp-sentinel',
    });
  });

  it('rejects a blank kinfolk id without calling updateDoc', async () => {
    await expect(updateKinfolkTags('', ['x'])).rejects.toThrow(/kinfolk id/i);
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it('propagates a genuine write failure for the caller to surface fail-loud', async () => {
    updateDoc.mockRejectedValue(new Error('permission-denied'));
    await expect(updateKinfolkTags('kf1', [])).rejects.toThrow('permission-denied');
  });
});
