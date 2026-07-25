import { describe, it, expect, vi, beforeEach } from 'vitest';

const { addDoc, setDoc, doc, collection, writeBatch, batch } = vi.hoisted(() => {
  const batch = { set: vi.fn(), update: vi.fn(), commit: vi.fn() };
  return {
    addDoc: vi.fn(),
    setDoc: vi.fn(),
    // Two call shapes: doc(db, path, id) resolves an existing doc, and the ref
    // carries the id so an assertion can tell WHICH doc a batched write hit;
    // doc(collRef) mints a client-side id for a create inside a batch.
    doc: vi.fn((...args: unknown[]) => (args.length === 1 ? { id: 'mintedId' } : { __doc: args[2] })),
    collection: vi.fn(() => 'collRef'),
    writeBatch: vi.fn(() => batch),
    batch,
  };
});
vi.mock('firebase/firestore', () => ({ addDoc, setDoc, doc, collection, writeBatch }));
vi.mock('../lib/firebase', () => ({ db: {} }));

import { saveKinTaleTemplate } from './kinTaleTemplatesWrite';
import {
  ConditionOp,
  ConditionSource,
  makeChecklistItem,
  makeFieldCondition,
  makeMoodOption,
  type KinTaleTemplate,
} from '../lib/kinTale/model';

/** A fully-populated template with two conditions (one household attr, one household tag). */
function template(over: Partial<KinTaleTemplate> = {}): KinTaleTemplate {
  return {
    _id: '',
    name: 'Dog walk recap',
    description: 'For walks.',
    defaultEmailMessage: 'Had a great time!',
    serviceTypeKeys: ['Dog Walk', 'Drop-in'],
    isActive: true,
    isDefault: false,
    photoShowcaseEnabled: true,
    checklistEnabled: true,
    petMoodEnabled: true,
    visitNotesEnabled: true,
    nextAppointmentEnabled: true,
    reviewBoosterEnabled: false,
    checklistItems: [
      makeChecklistItem({
        key: 'meds',
        text: 'Medications given',
        scope: 'PER_PET',
        required: true,
        order: 0,
        conditions: [
          makeFieldCondition({
            source: ConditionSource.KINFOLK_ATTRIBUTE,
            op: ConditionOp.EXISTS,
            attributeKey: 'gateCode',
          }),
          makeFieldCondition({
            source: ConditionSource.KINFOLK_TAG,
            op: ConditionOp.CONTAINS,
            value: 'VIP',
          }),
        ],
      }),
    ],
    moodOptions: [makeMoodOption({ key: 'happy', label: 'Happy', emoji: '😊', order: 0 })],
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}

beforeEach(() => {
  addDoc.mockReset();
  setDoc.mockReset();
  doc.mockReset().mockImplementation((...args: unknown[]) =>
    args.length === 1 ? { id: 'mintedId' } : { __doc: args[2] },
  );
  collection.mockReset().mockReturnValue('collRef');
  writeBatch.mockClear();
  batch.set.mockReset();
  batch.update.mockReset();
  batch.commit.mockReset().mockResolvedValue(undefined);
});

describe('saveKinTaleTemplate: create (blank _id)', () => {
  it('creates via addDoc, stamps createdAt === updatedAt, returns the new id', async () => {
    addDoc.mockResolvedValue({ id: 'newTpl1' });
    const result = await saveKinTaleTemplate(template());

    expect(result).toBe('newTpl1');
    expect(addDoc).toHaveBeenCalledTimes(1);
    expect(setDoc).not.toHaveBeenCalled();
    const [collRef, payload] = addDoc.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(collRef).toBe('collRef');
    expect(typeof payload.createdAt).toBe('string');
    expect(payload.createdAt).toBe(payload.updatedAt);
  });

  it('writes every model field EXCEPT _id (the doc id is authoritative)', async () => {
    addDoc.mockResolvedValue({ id: 't' });
    await saveKinTaleTemplate(template());
    const [, payload] = addDoc.mock.calls[0] as [unknown, Record<string, unknown>];

    expect(payload).not.toHaveProperty('_id');
    expect(payload).toMatchObject({
      name: 'Dog walk recap',
      description: 'For walks.',
      defaultEmailMessage: 'Had a great time!',
      serviceTypeKeys: ['Dog Walk', 'Drop-in'],
      isActive: true,
      isDefault: false,
      photoShowcaseEnabled: true,
      checklistEnabled: true,
      petMoodEnabled: true,
      visitNotesEnabled: true,
      nextAppointmentEnabled: true,
      reviewBoosterEnabled: false,
    });
  });

  it('round-trips the checklist + its conditions (household attribute AND household tag)', async () => {
    addDoc.mockResolvedValue({ id: 't' });
    await saveKinTaleTemplate(template());
    const [, payload] = addDoc.mock.calls[0] as [unknown, { checklistItems: Array<Record<string, unknown>> }];

    expect(payload.checklistItems).toHaveLength(1);
    const item = payload.checklistItems[0]!;
    expect(item).toMatchObject({
      key: 'meds',
      text: 'Medications given',
      scope: 'PER_PET',
      required: true,
      showWhenUnchecked: false,
      order: 0,
    });
    expect(item.conditions).toEqual([
      { source: 'KINFOLK_ATTRIBUTE', op: 'EXISTS', value: '', attributeKey: 'gateCode' },
      { source: 'KINFOLK_TAG', op: 'CONTAINS', value: 'VIP', attributeKey: '' },
    ]);
  });

  it('round-trips mood options', async () => {
    addDoc.mockResolvedValue({ id: 't' });
    await saveKinTaleTemplate(template());
    const [, payload] = addDoc.mock.calls[0] as [unknown, { moodOptions: unknown }];
    expect(payload.moodOptions).toEqual([{ key: 'happy', label: 'Happy', emoji: '😊', order: 0 }]);
  });
});

describe('saveKinTaleTemplate: update (real _id)', () => {
  it('updates via a MERGE setDoc, restamps only updatedAt, never createdAt', async () => {
    setDoc.mockResolvedValue(undefined);
    const result = await saveKinTaleTemplate(template({ _id: 'tpl9', name: 'Renamed' }));

    expect(result).toBe('tpl9');
    expect(setDoc).toHaveBeenCalledTimes(1);
    expect(addDoc).not.toHaveBeenCalled();
    const [ref, payload, opts] = setDoc.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(ref).toEqual({ __doc: 'tpl9' });
    expect(opts).toEqual({ merge: true });
    expect(payload).toMatchObject({ name: 'Renamed' });
    expect(payload).not.toHaveProperty('_id');
    expect(payload).not.toHaveProperty('createdAt');
    expect(typeof payload.updatedAt).toBe('string');
  });

  it('treats a whitespace-only _id as create, never an update to the empty id', async () => {
    addDoc.mockResolvedValue({ id: 'made' });
    const result = await saveKinTaleTemplate(template({ _id: '   ' }));
    expect(result).toBe('made');
    expect(addDoc).toHaveBeenCalledTimes(1);
    expect(setDoc).not.toHaveBeenCalled();
  });
});

describe('saveKinTaleTemplate: fail-loud', () => {
  it('propagates a create rejection unchanged, never a fake success', async () => {
    addDoc.mockRejectedValue(new Error('permission-denied'));
    await expect(saveKinTaleTemplate(template())).rejects.toThrow('permission-denied');
  });

  it('propagates an update rejection unchanged', async () => {
    setDoc.mockRejectedValue(new Error('unavailable'));
    await expect(saveKinTaleTemplate(template({ _id: 'tpl9' }))).rejects.toThrow('unavailable');
  });
});

/**
 * `isDefault` is the GLOBAL fallback the composer uses when no template's
 * `serviceTypeKeys` matches the visit's service
 * (`AuntieRepository.getActiveTemplateForService`: `match ?: templates
 * .firstOrNull { it.isDefault }`). With two flagged docs, which one wins is
 * whatever order the snapshot happened to arrive in, so exclusivity has to be
 * global, not per service scope: scoping it would leave exactly the ambiguity
 * the flag exists to resolve.
 *
 * Setting the flag therefore clears it everywhere else in ONE batch, so no
 * observer ever sees two defaults or none.
 */
describe('saveKinTaleTemplate: isDefault is exclusive, in one batched write', () => {
  const siblings = [
    { _id: 'tpl1', isDefault: true },
    { _id: 'tpl2', isDefault: false },
    { _id: 'tpl9', isDefault: true },
  ];

  it('clears the flag on the prior default and writes this one, in a single commit', async () => {
    const result = await saveKinTaleTemplate(template({ _id: 'tpl9', isDefault: true }), siblings);

    expect(result).toBe('tpl9');
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(batch.commit).toHaveBeenCalledTimes(1);
    // One unset, for tpl1 only.
    expect(batch.update).toHaveBeenCalledTimes(1);
    expect(batch.update).toHaveBeenCalledWith({ __doc: 'tpl1' }, { isDefault: false });
    // And the saved template itself went through the SAME batch, not a second write.
    expect(batch.set).toHaveBeenCalledTimes(1);
    expect(setDoc).not.toHaveBeenCalled();
    expect(addDoc).not.toHaveBeenCalled();
  });

  /** Which docs the batch cleared the flag on. */
  function unsetIds(): unknown[] {
    return batch.update.mock.calls.map((c) => (c[0] as { __doc: unknown }).__doc);
  }

  it('never unsets the flag on the template being saved', async () => {
    await saveKinTaleTemplate(template({ _id: 'tpl9', isDefault: true }), siblings);
    expect(unsetIds()).not.toContain('tpl9');
  });

  it('leaves non-default siblings untouched', async () => {
    await saveKinTaleTemplate(template({ _id: 'tpl9', isDefault: true }), siblings);
    expect(unsetIds()).toEqual(['tpl1']);
  });

  it('creates a brand-new default in the same batch, against a client-minted id', async () => {
    const result = await saveKinTaleTemplate(template({ _id: '', isDefault: true }), siblings);

    expect(result).toBe('mintedId');
    expect(addDoc).not.toHaveBeenCalled();
    expect(batch.commit).toHaveBeenCalledTimes(1);
    const [ref, payload] = batch.set.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(ref).toEqual({ id: 'mintedId' });
    // A create still stamps both timestamps, exactly as the addDoc path does.
    expect(payload.createdAt).toBe(payload.updatedAt);
    expect(payload.isDefault).toBe(true);
  });

  it('still uses one batch when no other template is default, so the write stays atomic either way', async () => {
    await saveKinTaleTemplate(template({ _id: 'tpl9', isDefault: true }), [
      { _id: 'tpl2', isDefault: false },
    ]);
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(batch.update).not.toHaveBeenCalled();
    expect(batch.commit).toHaveBeenCalledTimes(1);
  });

  it('leaves the plain single-doc path alone when the template is NOT default', async () => {
    setDoc.mockResolvedValue(undefined);
    await saveKinTaleTemplate(template({ _id: 'tpl9', isDefault: false }), siblings);
    expect(writeBatch).not.toHaveBeenCalled();
    expect(setDoc).toHaveBeenCalledTimes(1);
  });

  it('propagates a batch-commit rejection unchanged, never a fake success', async () => {
    batch.commit.mockRejectedValue(new Error('aborted'));
    await expect(
      saveKinTaleTemplate(template({ _id: 'tpl9', isDefault: true }), siblings),
    ).rejects.toThrow('aborted');
  });
});
