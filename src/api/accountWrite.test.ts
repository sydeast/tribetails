import { describe, it, expect, vi, beforeEach } from 'vitest';

const { setDoc, doc } = vi.hoisted(() => ({ setDoc: vi.fn(), doc: vi.fn() }));
vi.mock('firebase/firestore', () => ({ setDoc, doc }));
vi.mock('../lib/firebase', () => ({ db: {} }));

import { saveUserProfile, type UserProfilePatch } from './accountWrite';

function patch(over: Partial<UserProfilePatch> = {}): UserProfilePatch {
  return {
    displayName: 'Auntie Nora',
    firstName: 'Nora',
    lastName: 'Brooks',
    phone: '555-0100',
    title: 'Head of Care',
    bio: 'Loves dogs.',
    ...over,
  };
}

beforeEach(() => {
  setDoc.mockReset();
  doc.mockReset();
  doc.mockReturnValue('doc-ref');
});

describe('saveUserProfile', () => {
  it('merge-writes the patch to users/{uid}, never a full overwrite', async () => {
    setDoc.mockResolvedValue(undefined);
    await saveUserProfile('op-1', patch());
    expect(doc).toHaveBeenCalledWith({}, 'users', 'op-1');
    expect(setDoc).toHaveBeenCalledWith(
      'doc-ref',
      expect.objectContaining({
        displayName: 'Auntie Nora',
        firstName: 'Nora',
        lastName: 'Brooks',
        phone: '555-0100',
        title: 'Head of Care',
        bio: 'Loves dogs.',
      }),
      { merge: true },
    );
  });

  it('stamps updatedAt with a parseable timestamp', async () => {
    setDoc.mockResolvedValue(undefined);
    await saveUserProfile('op-1', patch());
    const written = setDoc.mock.calls[0]?.[1] as { updatedAt: string };
    expect(typeof written.updatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(written.updatedAt))).toBe(false);
  });

  it('trims a blank uid to a fail-loud error rather than writing to a blank doc path', async () => {
    await expect(saveUserProfile('   ', patch())).rejects.toThrow(/uid/i);
    expect(setDoc).not.toHaveBeenCalled();
  });

  it('propagates a genuine write failure for the caller to surface fail-loud', async () => {
    setDoc.mockRejectedValue(new Error('permission-denied'));
    await expect(saveUserProfile('op-1', patch())).rejects.toThrow('permission-denied');
  });
});
