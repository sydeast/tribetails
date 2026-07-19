import { describe, it, expect, vi, beforeEach } from 'vitest';

const { addDoc, setDoc, doc, collection } = vi.hoisted(() => ({
  addDoc: vi.fn(),
  setDoc: vi.fn(),
  doc: vi.fn(() => 'docRef'),
  collection: vi.fn(() => 'collRef'),
}));
vi.mock('firebase/firestore', () => ({ addDoc, setDoc, doc, collection }));
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
  doc.mockReset().mockReturnValue('docRef');
  collection.mockReset().mockReturnValue('collRef');
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
    expect(ref).toBe('docRef');
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
