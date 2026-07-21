import { describe, it, expect, vi, beforeEach } from 'vitest';

const { addDoc, setDoc, doc, collection, writeBatch, arrayUnion, increment } = vi.hoisted(() => ({
  addDoc: vi.fn(),
  setDoc: vi.fn(),
  doc: vi.fn(() => 'docRef'),
  collection: vi.fn(() => 'collRef'),
  writeBatch: vi.fn(),
  arrayUnion: vi.fn((v: unknown) => ({ __op: 'arrayUnion', v })),
  increment: vi.fn((n: number) => ({ __op: 'increment', n })),
}));
vi.mock('firebase/firestore', () => ({ addDoc, setDoc, doc, collection, writeBatch, arrayUnion, increment }));
vi.mock('../lib/firebase', () => ({ db: {} }));

const { getAuthState } = vi.hoisted(() => ({ getAuthState: vi.fn() }));
vi.mock('../lib/auth', () => ({ getAuthState }));

import { saveKinTaleDraft, sendKinTale, hasKinTaleContent, type KinTaleDraft } from './kinTalesWrite';

function draft(over: Partial<KinTaleDraft> = {}): KinTaleDraft {
  return {
    sessionId: 'sess1',
    kinfolkId: 'kf1',
    kinfolkName: 'The Alvarez Household',
    kinIds: ['pet1'],
    serviceType: 'Dog Walk',
    visitDate: '2026-07-16T18:00:00.000Z',
    arrivedAt: '2026-07-16T18:05:00.000Z',
    title: '',
    titleGeneratedByAi: false,
    bodyCopy: '',
    mediaFileIds: [],
    ...over,
  };
}

beforeEach(() => {
  addDoc.mockReset();
  setDoc.mockReset();
  doc.mockReset().mockReturnValue('docRef');
  collection.mockReset().mockReturnValue('collRef');
  writeBatch.mockReset();
  arrayUnion.mockClear();
  increment.mockClear();
  getAuthState.mockReset().mockReturnValue({
    status: 'signedIn',
    user: { uid: 'u1', displayName: 'Pat Auntie' },
  });
});

describe('hasKinTaleContent', () => {
  it('is false for a wholly blank draft', () => {
    expect(hasKinTaleContent(draft())).toBe(false);
  });

  it('is true once title, bodyCopy, or media has content', () => {
    expect(hasKinTaleContent(draft({ title: 'A great walk' }))).toBe(true);
    expect(hasKinTaleContent(draft({ bodyCopy: 'We had fun at the park.' }))).toBe(true);
    expect(hasKinTaleContent(draft({ mediaFileIds: ['m1'] }))).toBe(true);
  });

  it('whitespace-only title/body does not count as content', () => {
    expect(hasKinTaleContent(draft({ title: '   ', bodyCopy: '\n\t' }))).toBe(false);
  });
});

describe('saveKinTaleDraft', () => {
  it('skips the round-trip for a still-blank new draft, no ghost row in Firestore', async () => {
    const result = await saveKinTaleDraft(draft());
    expect(result).toBeNull();
    expect(addDoc).not.toHaveBeenCalled();
    expect(setDoc).not.toHaveBeenCalled();
  });

  it('creates via addDoc, stamping author + createdAt/updatedAt, once the draft has content', async () => {
    addDoc.mockResolvedValue({ id: 'newReport1' });
    const result = await saveKinTaleDraft(draft({ bodyCopy: 'Great visit today.' }));

    expect(result).toBe('newReport1');
    expect(addDoc).toHaveBeenCalledTimes(1);
    const [collRef, payload] = addDoc.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(collRef).toBe('collRef');
    expect(payload).toMatchObject({
      status: 'DRAFT',
      sentAt: '',
      sentVia: '',
      bodyCopy: 'Great visit today.',
      authorId: 'u1',
      authorDisplayName: 'Pat Auntie',
    });
    expect(typeof payload.createdAt).toBe('string');
    expect(payload.createdAt).toBe(payload.updatedAt);
  });

  it('falls back to "Auntie" when the signed-in admin has no display name (the wasm fallback)', async () => {
    getAuthState.mockReturnValue({ status: 'signedIn', user: { uid: 'u1', displayName: '' } });
    addDoc.mockResolvedValue({ id: 'r2' });
    await saveKinTaleDraft(draft({ title: 'Hi there' }));
    const [, payload] = addDoc.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(payload.authorDisplayName).toBe('Auntie');
  });

  it('stamps a blank authorId when no admin is signed in, never a fabricated uid', async () => {
    getAuthState.mockReturnValue({ status: 'signedOut' });
    addDoc.mockResolvedValue({ id: 'r3' });
    await saveKinTaleDraft(draft({ title: 'Hi there' }));
    const [, payload] = addDoc.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(payload.authorId).toBe('');
  });

  it('updates an existing draft via a MERGE setDoc, never a full overwrite that could wipe untracked fields', async () => {
    setDoc.mockResolvedValue(undefined);
    const result = await saveKinTaleDraft(draft({ _id: 'existing1', title: 'Updated headline' }));

    expect(result).toBe('existing1');
    expect(setDoc).toHaveBeenCalledTimes(1);
    const [ref, payload, opts] = setDoc.mock.calls[0] as [unknown, Record<string, unknown>, Record<string, unknown>];
    expect(ref).toBe('docRef');
    expect(payload).toMatchObject({ title: 'Updated headline', sessionId: 'sess1' });
    expect(opts).toEqual({ merge: true });
    expect(addDoc).not.toHaveBeenCalled();
  });

  it('an update never re-stamps author/createdAt (only updatedAt)', async () => {
    setDoc.mockResolvedValue(undefined);
    await saveKinTaleDraft(draft({ _id: 'existing1', bodyCopy: 'edit' }));
    const [, payload] = setDoc.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(payload).not.toHaveProperty('authorId');
    expect(payload).not.toHaveProperty('createdAt');
    expect(typeof payload.updatedAt).toBe('string');
  });
});

describe('sendKinTale', () => {
  it('rejects a blank reportId, fail-loud', async () => {
    await expect(sendKinTale({ reportId: '', sessionId: 's1' })).rejects.toThrow(/reportId/);
  });

  it('rejects a blank sessionId, fail-loud', async () => {
    await expect(sendKinTale({ reportId: 'r1', sessionId: '' })).rejects.toThrow(/sessionId/);
  });

  it('commits one batch: flips the report SENT and updates the parent session atomically', async () => {
    const update = vi.fn();
    const commit = vi.fn().mockResolvedValue(undefined);
    writeBatch.mockReturnValue({ update, commit });

    await sendKinTale({ reportId: 'r1', sessionId: 's1' });

    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(2);

    expect(update).toHaveBeenNthCalledWith(
      1,
      'docRef',
      expect.objectContaining({
        status: 'SENT',
        sentVia: 'pending',
        deliveryReceiptId: '',
      }),
    );
    expect(update).toHaveBeenNthCalledWith(
      2,
      'docRef',
      expect.objectContaining({
        reportIds: { __op: 'arrayUnion', v: 'r1' },
        sentReportCount: { __op: 'increment', n: 1 },
        autoCompleteEligible: true,
      }),
    );
    expect(commit).toHaveBeenCalledOnce();
  });

  it('never commits a half transition: a batch failure rejects, and the caller can tell', async () => {
    const update = vi.fn();
    const commit = vi.fn().mockRejectedValue(new Error('unavailable'));
    writeBatch.mockReturnValue({ update, commit });

    await expect(sendKinTale({ reportId: 'r1', sessionId: 's1' })).rejects.toThrow('unavailable');
  });
});
