import { describe, it, expect, vi, beforeEach } from 'vitest';

const { doc, updateDoc, setDoc, serverTimestamp } = vi.hoisted(() => ({
  doc: vi.fn(),
  updateDoc: vi.fn(),
  setDoc: vi.fn(),
  serverTimestamp: vi.fn(),
}));
vi.mock('firebase/firestore', () => ({ doc, updateDoc, setDoc, serverTimestamp }));
vi.mock('../lib/firebase', () => ({ db: {} }));

const { getAuthState } = vi.hoisted(() => ({ getAuthState: vi.fn() }));
vi.mock('../lib/auth', () => ({ getAuthState }));

import {
  updateKinfolkProfile,
  archiveKinfolk,
  unarchiveKinfolk,
  KINFOLK_EDIT_FIELDS,
  type KinfolkEditPatch,
} from './kinfolkProfileWrite';

function patch(over: Partial<KinfolkEditPatch> = {}): KinfolkEditPatch {
  return {
    firstName: 'Jamie',
    lastName: 'Halbrook',
    phoneNumber: '(512) 555-1234',
    email: 'jamie@example.com',
    status: 'active',
    joinDate: '2026-01-04',
    secondaryPhone: '',
    secondaryEmail: '',
    serviceAddress: '123 Bark Ave',
    gateCode: '4242',
    parkingInstructions: 'Driveway is fine.',
    entryNotes: 'Side gate sticks.',
    wifiName: 'Halbrook Home',
    wifiPassword: 'sunflower-porch',
    emergencyContactName: 'Rae Halbrook',
    emergencyContactPhone: '512-555-9090',
    emergencyContactRelation: 'Sister',
    vetClinicName: 'Barton Creek Vet',
    vetClinicAddress: '9 Clinic Row',
    vetClinicPhone: '512-555-7788',
    ...over,
  };
}

beforeEach(() => {
  doc.mockReset();
  updateDoc.mockReset();
  setDoc.mockReset();
  serverTimestamp.mockReset();
  getAuthState.mockReset();
  doc.mockImplementation((_db: unknown, path: string, id: string) => `doc-ref:${path}/${id}`);
  serverTimestamp.mockReturnValue('server-timestamp-sentinel');
  getAuthState.mockReturnValue({ status: 'signedOut' });
});

/** The payload handed to the single updateDoc call. */
function writtenFields(): Record<string, unknown> {
  expect(updateDoc).toHaveBeenCalledTimes(1);
  return updateDoc.mock.calls[0]![1] as Record<string, unknown>;
}

describe('updateKinfolkProfile', () => {
  it('writes to kinfolk/{id} and stamps a server updatedAt', async () => {
    await updateKinfolkProfile('kf1', patch());
    expect(updateDoc.mock.calls[0]![0]).toBe('doc-ref:kinfolk/kf1');
    expect(writtenFields()['updatedAt']).toBe('server-timestamp-sentinel');
  });

  it('sends exactly the managed fields, and nothing else', async () => {
    await updateKinfolkProfile('kf1', patch());
    const keys = Object.keys(writtenFields()).sort();
    expect(keys).toEqual([...KINFOLK_EDIT_FIELDS, 'updatedAt'].sort());
  });

  /**
   * THE test this module exists for. A prior bug in this codebase destroyed
   * fields by writing a whole object; both Kotlin clients still do (see the
   * module header). This proves the web write cannot.
   *
   * Rather than asserting on key names alone, this simulates Firestore's actual
   * `updateDoc` semantics over a seeded document, so the assertion is about what
   * SURVIVES on the stored record, not about what the caller happened to pass.
   */
  it('is a field-level merge: every field it does not manage survives the save', async () => {
    const stored: Record<string, unknown> = {
      // The fields the edit form owns, at their pre-edit values.
      firstName: 'Jamie',
      lastName: 'Halbrook',
      serviceAddress: '123 Bark Ave',
      // Backend-only and other-surface fields. NONE of these may change.
      uid: 'auth-uid-abc',
      myTribeLinkedAt: 'linked-timestamp',
      archivedAt: '2026-02-02T00:00:00.000Z',
      archivedReason: 'paused service',
      archivedBy: 'admin',
      displayName: 'Halbrook household',
      businessName: 'Tribe Tails',
      householdMemberCount: 3,
      isTestData: false,
      contactOverride: { channel: 'sms' },
      formValues: { allergy: 'none' },
      internalNotes: 'Prefers the back gate.',
      referralSource: 'Word of mouth',
      outstandingBalance: '42.00',
      tags: ['VIP'],
      preferredContactMethod: 'Text',
      bestTimeToContact: 'Evenings',
      profilePictureUrl: 'https://example.test/photo.jpg',
    };
    const before = structuredClone(stored);

    // Firestore's real updateDoc: shallow merge of the named keys only.
    updateDoc.mockImplementation((_ref: unknown, fields: Record<string, unknown>) => {
      Object.assign(stored, fields);
      return Promise.resolve();
    });

    await updateKinfolkProfile('kf1', patch({ firstName: 'Jaime', serviceAddress: '77 New Road' }));

    // The edit landed.
    expect(stored['firstName']).toBe('Jaime');
    expect(stored['serviceAddress']).toBe('77 New Road');

    // Nothing this form does not manage moved. Named individually rather than
    // looped, so a failure says WHICH field was destroyed.
    expect(stored['uid']).toBe(before['uid']);
    expect(stored['myTribeLinkedAt']).toBe(before['myTribeLinkedAt']);
    expect(stored['archivedAt']).toBe(before['archivedAt']);
    expect(stored['archivedReason']).toBe(before['archivedReason']);
    expect(stored['archivedBy']).toBe(before['archivedBy']);
    expect(stored['displayName']).toBe(before['displayName']);
    expect(stored['businessName']).toBe(before['businessName']);
    expect(stored['householdMemberCount']).toBe(before['householdMemberCount']);
    expect(stored['isTestData']).toBe(before['isTestData']);
    expect(stored['contactOverride']).toEqual(before['contactOverride']);
    expect(stored['formValues']).toEqual(before['formValues']);
    expect(stored['internalNotes']).toBe(before['internalNotes']);
    expect(stored['referralSource']).toBe(before['referralSource']);
    expect(stored['outstandingBalance']).toBe(before['outstandingBalance']);
    expect(stored['tags']).toEqual(before['tags']);
    expect(stored['profilePictureUrl']).toBe(before['profilePictureUrl']);
  });

  it('never round-trips the two fields a Kinfolk can edit from the portal', async () => {
    await updateKinfolkProfile('kf1', patch());
    const fields = writtenFields();
    // firestore.rules onlyAllowedKinfolkFields lets a Kinfolk write these from
    // MyTribe. Writing back what this form read at load would clobber an edit
    // the household made in between.
    expect(fields).not.toHaveProperty('preferredContactMethod');
    expect(fields).not.toHaveProperty('bestTimeToContact');
  });

  it('never uses setDoc, the whole-object write that caused the loss', async () => {
    await updateKinfolkProfile('kf1', patch());
    expect(setDoc).not.toHaveBeenCalled();
  });

  it('ignores extra properties riding along on the caller object', async () => {
    const contaminated = { ...patch(), _id: 'kf1', uid: 'SHOULD-NOT-BE-SENT' } as KinfolkEditPatch;
    await updateKinfolkProfile('kf1', contaminated);
    const fields = writtenFields();
    expect(fields).not.toHaveProperty('_id');
    expect(fields).not.toHaveProperty('uid');
  });

  it('trims identity and contact fields but leaves free-text notes as typed', async () => {
    await updateKinfolkProfile(
      'kf1',
      patch({ firstName: '  Jamie  ', entryNotes: '  line one\n  line two  ' }),
    );
    const fields = writtenFields();
    expect(fields['firstName']).toBe('Jamie');
    expect(fields['entryNotes']).toBe('  line one\n  line two  ');
  });

  it('fails loud on a blank id rather than writing to a bad path', async () => {
    await expect(updateKinfolkProfile('  ', patch())).rejects.toThrow(/requires a kinfolk id/);
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it('propagates a rejected write', async () => {
    updateDoc.mockRejectedValue(new Error('permission-denied'));
    await expect(updateKinfolkProfile('kf1', patch())).rejects.toThrow('permission-denied');
  });
});

describe('archiveKinfolk', () => {
  it('writes the four archive fields plus updatedAt, and touches nothing else', async () => {
    getAuthState.mockReturnValue({ status: 'signedIn', user: { uid: 'admin-uid-1' } });
    await archiveKinfolk('kf1', '  moved away  ');
    const fields = writtenFields();
    expect(fields['status']).toBe('archived');
    expect(fields['archivedReason']).toBe('moved away');
    expect(fields['archivedBy']).toBe('admin-uid-1');
    expect(typeof fields['archivedAt']).toBe('string');
    expect(Object.keys(fields).sort()).toEqual(
      ['archivedAt', 'archivedBy', 'archivedReason', 'status', 'updatedAt'].sort(),
    );
  });

  it('falls back to the Kotlin default archivedBy when nobody is signed in', async () => {
    await archiveKinfolk('kf1', 'paused');
    expect(writtenFields()['archivedBy']).toBe('admin');
  });

  it('accepts a blank reason, since the source labels it optional', async () => {
    await archiveKinfolk('kf1', '');
    expect(writtenFields()['archivedReason']).toBe('');
  });

  it('fails loud on a blank id', async () => {
    await expect(archiveKinfolk('', 'why')).rejects.toThrow(/requires a kinfolk id/);
    expect(updateDoc).not.toHaveBeenCalled();
  });
});

describe('unarchiveKinfolk', () => {
  it('restores to active and clears the archive trio', async () => {
    await unarchiveKinfolk('kf1');
    const fields = writtenFields();
    expect(fields['status']).toBe('active');
    expect(fields['archivedAt']).toBe('');
    expect(fields['archivedReason']).toBe('');
    expect(fields['archivedBy']).toBe('');
  });

  it('fails loud on a blank id', async () => {
    await expect(unarchiveKinfolk('   ')).rejects.toThrow(/requires a kinfolk id/);
    expect(updateDoc).not.toHaveBeenCalled();
  });
});
