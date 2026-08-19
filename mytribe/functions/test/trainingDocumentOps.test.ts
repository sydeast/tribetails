import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { createTrainingDocumentHandler } from '../src/admin/createTrainingDocument';
import { updateTrainingDocumentHandler } from '../src/admin/updateTrainingDocument';
import { deleteTrainingDocumentHandler } from '../src/admin/deleteTrainingDocument';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

beforeEach(() => {
  mocks.dbFn.mockReset();
  (writeAuditEntry as any).mockClear();
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any, instanceIdToken: undefined, acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

/**
 * The roster both write handlers now READ before they accept a target
 * (issue #460). Every fixture below carries it, because a save whose
 * `targetKinfolkId` names no `kinfolk` document is refused — which is the whole
 * point of the change, and is asserted on its own further down.
 *
 * `kin/k-other` exists to prove the pet/household pairing is checked, not just
 * the pet's existence.
 */
const ROSTER: Record<string, Record<string, unknown> | null> = {
  'kinfolk/kf1': { firstName: 'Jane', lastName: 'Halbrook' },
  'kinfolk/kf2': { firstName: 'Marcus', lastName: 'Vance' },
  'kin/k9': { kinfolkId: 'kf1', name: 'Rufus' },
  'kin/k-other': { kinfolkId: 'kf2', name: 'Biscuit' },
};

function roster(
  extra: Record<string, Record<string, unknown> | null> = {},
): Record<string, Record<string, unknown> | null> {
  return { ...ROSTER, ...extra };
}

const okAttachment = {
  storageUrl: 'https://res.cloudinary.com/x/image/upload/v1/tribal/a.jpg',
  cloudinaryPublicId: 'tribal/a',
  fileType: 'image',
  mimeType: 'image/jpeg',
  fileName: 'a.jpg',
};

describe('createTrainingDocument', () => {
  it('HAPPY: writes a pending doc with KINFOLK target + returns docId', async () => {
    const ctx = buildDbMock({ docs: roster() });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createTrainingDocumentHandler(req({
      title: 'Gate code', content: 'Side gate code is 4321.',
      targetType: 'KINFOLK', targetKinfolkId: 'kf1',
    }));
    expect(res.ok).toBe(true);
    const add = ctx.adds.find((a) => a.collection === 'training_documents');
    expect(add).toBeDefined();
    expect(add?.data.reconcileStatus).toBe('pending');
    expect(add?.data.targetType).toBe('KINFOLK');
    expect(add?.data.targetKinfolkId).toBe('kf1');
    expect(add?.data.targetKinId).toBe('');
    // kinfolkRef preserved for back-compat read screen.
    expect(add?.data.kinfolkRef).toBe('kf1');
    expect(res.docId).toBe(add?.id);
  });

  it('HAPPY: HOUSEHOLD target stores the household anchor and no kin id', async () => {
    const ctx = buildDbMock({ docs: roster() });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createTrainingDocumentHandler(req({
      title: 'Holiday plans', content: 'The whole house is away over Thanksgiving.',
      targetType: 'HOUSEHOLD', targetKinfolkId: 'kf1',
    }));
    expect(res.ok).toBe(true);
    const add = ctx.adds.find((a) => a.collection === 'training_documents');
    // The third target is stored as itself, never folded back into KINFOLK: a
    // reader has to be able to tell "about everyone under this roof" from
    // "about this one person" without guessing (issue #393).
    expect(add?.data.targetType).toBe('HOUSEHOLD');
    expect(add?.data.targetKinfolkId).toBe('kf1');
    expect(add?.data.targetKinId).toBe('');
    expect(add?.data.kinfolkRef).toBe('kf1');
  });

  it('HAPPY: HOUSEHOLD target drops a stale kin id rather than storing it', async () => {
    const ctx = buildDbMock({ docs: roster() });
    mocks.dbFn.mockReturnValue(ctx.db);
    await createTrainingDocumentHandler(req({
      content: 'Everyone in the house is moving in March.',
      targetType: 'HOUSEHOLD', targetKinfolkId: 'kf1', targetKinId: 'k9',
    }));
    const add = ctx.adds.find((a) => a.collection === 'training_documents');
    // A pet id left on a household note is how the nightly pipeline would
    // narrow a whole-house note down to one animal.
    expect(add?.data.targetKinId).toBe('');
  });

  it('SAD: an unknown target type is rejected (invalid-argument)', async () => {
    const ctx = buildDbMock({ docs: roster() });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(createTrainingDocumentHandler(req({
      content: 'note', targetType: 'FAMILY', targetKinfolkId: 'kf1',
    }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HAPPY: KIN target stores targetKinId + attachments', async () => {
    const ctx = buildDbMock({ docs: roster() });
    mocks.dbFn.mockReturnValue(ctx.db);
    await createTrainingDocumentHandler(req({
      content: 'Rex is allergic to chicken.',
      targetType: 'KIN', targetKinfolkId: 'kf1', targetKinId: 'k9',
      attachments: [okAttachment],
    }));
    const add = ctx.adds.find((a) => a.collection === 'training_documents');
    expect(add?.data.targetKinId).toBe('k9');
    expect((add?.data.attachments as unknown[]).length).toBe(1);
  });

  it('HAPPY: writes a CREATE_TRAINING_DOCUMENT audit entry', async () => {
    const ctx = buildDbMock({ docs: roster() });
    mocks.dbFn.mockReturnValue(ctx.db);
    await createTrainingDocumentHandler(req({
      content: 'note', targetType: 'KINFOLK', targetKinfolkId: 'kf1',
    }));
    const call = (writeAuditEntry as any).mock.calls.map((c: any[]) => c[0])
      .find((c: any) => c.event === 'CREATE_TRAINING_DOCUMENT');
    expect(call).toBeDefined();
    expect(call.payload.targetKinfolkId).toBe('kf1');
  });

  it('SAD: unauthenticated rejected', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: roster() }).db);
    await expect(createTrainingDocumentHandler(req({
      content: 'note', targetType: 'KINFOLK', targetKinfolkId: 'kf1',
    }, null))).rejects.toThrow();
  });

  it('SAD: no title/content/attachment rejected (invalid-argument)', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: roster() }).db);
    await expect(createTrainingDocumentHandler(req({
      title: '   ', content: '', targetType: 'KINFOLK', targetKinfolkId: 'kf1',
    }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('SAD: KIN target without targetKinId rejected', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: roster() }).db);
    await expect(createTrainingDocumentHandler(req({
      content: 'note', targetType: 'KIN', targetKinfolkId: 'kf1',
    }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('NEGATIVE: bad attachment URL rejected', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: roster() }).db);
    await expect(createTrainingDocumentHandler(req({
      content: 'note', targetType: 'KINFOLK', targetKinfolkId: 'kf1',
      attachments: [{ ...okAttachment, storageUrl: 'not-a-url' }],
    }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  // ── issue #460: the target must be an id that RESOLVES ──────────────────

  it('SAD: a target that is a person NAME rather than an id is refused', async () => {
    // The exact shape of the bug: the editor seeded its picker from the legacy
    // free-text `kinfolkRef`, nothing matched, and `min(1)` accepted the name
    // straight back. A length check cannot tell a name from an id, so the
    // handler reads the record instead.
    const ctx = buildDbMock({ docs: roster() });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(createTrainingDocumentHandler(req({
      content: 'Gate code is 4321.', targetType: 'HOUSEHOLD', targetKinfolkId: 'Jane Halbrook',
    }))).rejects.toMatchObject({ code: 'invalid-argument' });
    // Refused BEFORE the write, not cleaned up after it.
    expect(ctx.adds.find((a) => a.collection === 'training_documents')).toBeUndefined();
  });

  it('SAD: the refusal names the value and the picker to use', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: roster() }).db);
    await expect(createTrainingDocumentHandler(req({
      content: 'note', targetType: 'KINFOLK', targetKinfolkId: 'Jane Halbrook',
    }))).rejects.toThrow(/"Jane Halbrook"[\s\S]*Pick the right kinfolk/);
  });

  it('SAD: an id-shaped reference that no longer exists is refused too', async () => {
    // Not only names. A household deleted after the note was filed leaves a
    // dangling id, which resolves no better than free text does.
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: roster() }).db);
    await expect(createTrainingDocumentHandler(req({
      content: 'note', targetType: 'HOUSEHOLD', targetKinfolkId: 'kf-deleted',
    }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('SAD: a reference carrying a slash is refused, not thrown as internal', async () => {
    // `collection().doc('a/b')` throws a raw SDK error rather than reporting a
    // miss, which would reach the operator as an opaque `internal`.
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: roster() }).db);
    await expect(createTrainingDocumentHandler(req({
      content: 'note', targetType: 'HOUSEHOLD', targetKinfolkId: 'kinfolk/kf1',
    }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('SAD: a KIN target naming a pet that does not exist is refused', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: roster() }).db);
    await expect(createTrainingDocumentHandler(req({
      content: 'note', targetType: 'KIN', targetKinfolkId: 'kf1', targetKinId: 'Rufus',
    }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('SAD: a pet belonging to another household is refused', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: roster() }).db);
    await expect(createTrainingDocumentHandler(req({
      content: 'note', targetType: 'KIN', targetKinfolkId: 'kf1', targetKinId: 'k-other',
    }))).rejects.toThrow(/belongs to household "kf2"/);
  });

  it('HAPPY: an orphan pet with no owner on file still saves', async () => {
    // A `kin` row with a blank `kinfolkId` is a defect in a different
    // collection. Refusing intel about it would punish the operator for it.
    const ctx = buildDbMock({ docs: roster({ 'kin/k-orphan': { kinfolkId: '', name: 'Smudge' } }) });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createTrainingDocumentHandler(req({
      content: 'note', targetType: 'KIN', targetKinfolkId: 'kf1', targetKinId: 'k-orphan',
    }));
    expect(res.ok).toBe(true);
  });

  it('NEGATIVE: too many attachments rejected', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: roster() }).db);
    const many = Array.from({ length: 26 }, () => okAttachment);
    await expect(createTrainingDocumentHandler(req({
      content: 'note', targetType: 'KINFOLK', targetKinfolkId: 'kf1', attachments: many,
    }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('updateTrainingDocument', () => {
  it('HAPPY: re-queues an existing doc (reconcileStatus pending)', async () => {
    const ctx = buildDbMock({ docs: roster({ 'training_documents/d1': { reconcileStatus: 'applied' } }) });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await updateTrainingDocumentHandler(req({
      docId: 'd1', content: 'Updated note', targetType: 'KINFOLK', targetKinfolkId: 'kf1',
    }));
    expect(res.ok).toBe(true);
    const write = ctx.writes.find((w) => w.path === 'training_documents/d1');
    expect(write?.data.reconcileStatus).toBe('pending');
    expect(write?.merge).toBe(true);
  });

  it('HAPPY: re-targets an entry from KINFOLK to HOUSEHOLD on edit', async () => {
    const ctx = buildDbMock({ docs: roster({ 'training_documents/d1': { targetType: 'KINFOLK' } }) });
    mocks.dbFn.mockReturnValue(ctx.db);
    await updateTrainingDocumentHandler(req({
      docId: 'd1', content: 'Actually this is about the whole house.',
      targetType: 'HOUSEHOLD', targetKinfolkId: 'kf1',
    }));
    const write = ctx.writes.find((w) => w.path === 'training_documents/d1');
    expect(write?.data.targetType).toBe('HOUSEHOLD');
    expect(write?.data.targetKinId).toBe('');
  });

  it('HAPPY: re-targets an entry from HOUSEHOLD to KIN on edit', async () => {
    const ctx = buildDbMock({ docs: roster({ 'training_documents/d1': { targetType: 'HOUSEHOLD' } }) });
    mocks.dbFn.mockReturnValue(ctx.db);
    await updateTrainingDocumentHandler(req({
      docId: 'd1', content: 'This one is about Rex after all.',
      targetType: 'KIN', targetKinfolkId: 'kf1', targetKinId: 'k9',
    }));
    const write = ctx.writes.find((w) => w.path === 'training_documents/d1');
    expect(write?.data.targetType).toBe('KIN');
    expect(write?.data.targetKinId).toBe('k9');
  });

  it('HAPPY: a legacy entry carrying no target type gains an explicit one on save', async () => {
    // The migrated NDJSON rows carry `kinfolkRef` and nothing else. Saving one
    // is the upgrade path: no backfill script, and nothing touches prod.
    const ctx = buildDbMock({ docs: roster({ 'training_documents/legacy1': { kinfolkRef: 'kf1' } }) });
    mocks.dbFn.mockReturnValue(ctx.db);
    await updateTrainingDocumentHandler(req({
      docId: 'legacy1', title: 'Imported', content: 'Still true.',
      targetType: 'HOUSEHOLD', targetKinfolkId: 'kf1',
    }));
    const write = ctx.writes.find((w) => w.path === 'training_documents/legacy1');
    expect(write?.data.targetType).toBe('HOUSEHOLD');
    expect(write?.data.kinfolkRef).toBe('kf1');
  });

  it('SAD: missing doc rejected (not-found)', async () => {
    const ctx = buildDbMock({ docs: roster() });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(updateTrainingDocumentHandler(req({
      docId: 'nope', content: 'x', targetType: 'KINFOLK', targetKinfolkId: 'kf1',
    }))).rejects.toMatchObject({ code: 'not-found' });
  });

  it('SAD: saving a legacy row back with its stored NAME is refused (issue #460)', async () => {
    // End to end, the reported bug: the row stores "Jane Halbrook" in
    // `kinfolkRef`, the editor seeds the picker with it, nothing matches, and
    // the operator hits Save. Before this change the name was written straight
    // back and the note stayed unresolvable.
    const ctx = buildDbMock({ docs: roster({ 'training_documents/legacy1': { kinfolkRef: 'Jane Halbrook' } }) });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(updateTrainingDocumentHandler(req({
      docId: 'legacy1', title: 'Imported', content: 'Still true.',
      targetType: 'HOUSEHOLD', targetKinfolkId: 'Jane Halbrook',
    }))).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(ctx.writes.find((w) => w.path === 'training_documents/legacy1')).toBeUndefined();
  });

  it('HAPPY: the same legacy row saves once the picker holds a real id', async () => {
    const ctx = buildDbMock({ docs: roster({ 'training_documents/legacy1': { kinfolkRef: 'Jane Halbrook' } }) });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await updateTrainingDocumentHandler(req({
      docId: 'legacy1', title: 'Imported', content: 'Still true.',
      targetType: 'HOUSEHOLD', targetKinfolkId: 'kf1',
    }));
    expect(res.ok).toBe(true);
    const write = ctx.writes.find((w) => w.path === 'training_documents/legacy1');
    // Both fields land on the id, so the nightly Python pipeline resolves the
    // row through either one (reconcile_comms.py reads targetKinfolkId OR kinfolkRef).
    expect(write?.data.targetKinfolkId).toBe('kf1');
    expect(write?.data.kinfolkRef).toBe('kf1');
  });

  it('SAD: a missing row is reported before its target is judged', async () => {
    const ctx = buildDbMock({ docs: roster() });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(updateTrainingDocumentHandler(req({
      docId: 'nope', content: 'x', targetType: 'HOUSEHOLD', targetKinfolkId: 'Jane Halbrook',
    }))).rejects.toMatchObject({ code: 'not-found' });
  });

  it('HAPPY: writes an UPDATE_TRAINING_DOCUMENT audit entry', async () => {
    const ctx = buildDbMock({ docs: roster({ 'training_documents/d1': { reconcileStatus: 'applied' } }) });
    mocks.dbFn.mockReturnValue(ctx.db);
    await updateTrainingDocumentHandler(req({
      docId: 'd1', content: 'x', targetType: 'KINFOLK', targetKinfolkId: 'kf1',
    }));
    const call = (writeAuditEntry as any).mock.calls.map((c: any[]) => c[0])
      .find((c: any) => c.event === 'UPDATE_TRAINING_DOCUMENT');
    expect(call).toBeDefined();
  });
});

describe('deleteTrainingDocument', () => {
  it('HAPPY: deletes an existing doc + writes audit entry with unmerge caveat', async () => {
    const ctx = buildDbMock({ docs: roster({ 'training_documents/d1': { reconcileStatus: 'applied' } }) });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await deleteTrainingDocumentHandler(req({ docId: 'd1' }));
    expect(res.ok).toBe(true);
    expect(ctx.deletes).toContain('training_documents/d1');
    const call = (writeAuditEntry as any).mock.calls.map((c: any[]) => c[0])
      .find((c: any) => c.event === 'DELETE_TRAINING_DOCUMENT');
    expect(call).toBeDefined();
    expect(call.payload.note).toMatch(/not retroactively unmerged/i);
  });

  it('SAD: missing doc rejected (not-found)', async () => {
    const ctx = buildDbMock({ docs: roster() });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(deleteTrainingDocumentHandler(req({ docId: 'nope' })))
      .rejects.toMatchObject({ code: 'not-found' });
  });

  it('SAD: blank docId rejected (invalid-argument)', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: roster() }).db);
    await expect(deleteTrainingDocumentHandler(req({ docId: '' })))
      .rejects.toMatchObject({ code: 'invalid-argument' });
  });
});
