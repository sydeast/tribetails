import { describe, it, expect } from 'vitest';
import {
  checklistHasContent,
  decodeFieldResponses,
  perPetChecklistRows,
  perVisitChecklistRows,
  setChecklistResponse,
  splitChecklistScopes,
  tickedCareTasks,
  type ChecklistContext,
} from './kinTaleChecklist';
import {
  ConditionOp,
  ConditionSource,
  DEFAULT_KINTALE_TEMPLATE,
  makeChecklistItem,
  makeFieldCondition,
  type FieldResponse,
  type KinTaleTemplate,
} from './kinTale/model';
import type { KinDetail } from '../api/kinView';
import type { KinfolkProfile } from '../api/kinfolkProfile';

/**
 * The checklist's WIRE SHAPE and its condition filtering, pinned directly.
 *
 * The wire shape is the reason these are unit tests and not only screen tests:
 * a tick the kinfolk portal cannot read is indistinguishable, on screen, from
 * one it can.
 */

function kin(over: Partial<KinDetail> = {}): KinDetail {
  return {
    _id: 'k1',
    name: 'Biscuit',
    species: 'Dog',
    breed: '',
    colorMarkings: '',
    medicationHealthNotes: '',
    vaccinations: '',
    vetInfo: '',
    feedingBrand: '',
    trainingCommands: '',
    routine: '',
    checklist: '',
    officeNotes: '',
    reactive: false,
    spayedNeutered: false,
    ...(over as Partial<KinDetail>),
  } as KinDetail;
}

function ctx(over: Partial<ChecklistContext> = {}): ChecklistContext {
  return {
    session: { serviceType: 'Dog Walk' },
    kinList: [kin()],
    kinfolk: null,
    ...over,
  };
}

function template(over: Partial<KinTaleTemplate> = {}): KinTaleTemplate {
  return { ...DEFAULT_KINTALE_TEMPLATE, ...over };
}

describe('splitChecklistScopes', () => {
  it('sorts by order and treats anything that is not PER_PET as PER_VISIT', () => {
    const { perPet, perVisit } = splitChecklistScopes([
      makeChecklistItem({ key: 'b', scope: 'PER_VISIT', order: 1 }),
      makeChecklistItem({ key: 'a', scope: 'PER_PET', order: 0 }),
      makeChecklistItem({ key: 'c', scope: 'SOMETHING_NEW', order: 2 }),
    ]);
    expect(perPet.map((i) => i.key)).toEqual(['a']);
    expect(perVisit.map((i) => i.key)).toEqual(['b', 'c']);
  });

  it('splits case-insensitively, so a lowercase scope is not silently dropped', () => {
    const { perPet } = splitChecklistScopes([makeChecklistItem({ key: 'a', scope: 'per_pet' })]);
    expect(perPet.map((i) => i.key)).toEqual(['a']);
  });
});

describe('perPetChecklistRows (conditions decide what is offered)', () => {
  it('offers an unconditional item on every kin', () => {
    const rows = perPetChecklistRows(
      template({ checklistItems: [makeChecklistItem({ key: 'fed', text: 'Fed', scope: 'PER_PET' })] }),
      kin(),
      ctx(),
      {},
    );
    expect(rows.map((r) => r.item.key)).toEqual(['fed']);
    expect(rows[0]?.key).toBe('k1|fed');
    expect(rows[0]?.checked).toBe(false);
  });

  /**
   * The defect the conditions exist to prevent: the built-in default's
   * `litter_scooped` is a cat item, and the dog must not be asked about it.
   */
  it('withholds a cat-only item from a dog, and offers it to the cat', () => {
    const t = template();
    const dog = kin({ _id: 'dog1', name: 'Biscuit', species: 'Dog' });
    const cat = kin({ _id: 'cat1', name: 'Marmalade', species: 'Cat' });
    const c = ctx({ kinList: [dog, cat] });

    expect(perPetChecklistRows(t, dog, c, {}).map((r) => r.item.key)).not.toContain('litter_scooped');
    expect(perPetChecklistRows(t, cat, c, {}).map((r) => r.item.key)).toContain('litter_scooped');
  });

  it('withholds a medication item from a kin with no medication notes', () => {
    const t = template();
    const plain = kin({ _id: 'k1', medicationHealthNotes: '' });
    const medicated = kin({ _id: 'k2', medicationHealthNotes: 'Half a tablet at noon' });
    const c = ctx({ kinList: [plain, medicated] });

    expect(perPetChecklistRows(t, plain, c, {}).map((r) => r.item.key)).not.toContain('meds_given');
    expect(perPetChecklistRows(t, medicated, c, {}).map((r) => r.item.key)).toContain('meds_given');
  });

  it('honours a service-type condition against the session, not the kin', () => {
    const t = template();
    const k = kin();
    expect(
      perPetChecklistRows(t, k, ctx({ session: { serviceType: 'Dog Walk' } }), {}).map((r) => r.item.key),
    ).toContain('walk_water_refill');
    expect(
      perPetChecklistRows(t, k, ctx({ session: { serviceType: 'Drop-in' } }), {}).map((r) => r.item.key),
    ).not.toContain('walk_water_refill');
  });

  it('reads a household condition off the kinfolk when one is supplied', () => {
    const t = template({
      checklistItems: [
        makeChecklistItem({
          key: 'gate',
          text: 'Gate relocked',
          scope: 'PER_PET',
          conditions: [
            makeFieldCondition({
              source: ConditionSource.KINFOLK_ATTRIBUTE,
              op: ConditionOp.EXISTS,
              attributeKey: 'gateCode',
            }),
          ],
        }),
      ],
    });
    const withGate = { gateCode: '4821' } as KinfolkProfile;
    const withoutGate = { gateCode: '' } as KinfolkProfile;

    expect(perPetChecklistRows(t, kin(), ctx({ kinfolk: withGate }), {})).toHaveLength(1);
    expect(perPetChecklistRows(t, kin(), ctx({ kinfolk: withoutGate }), {})).toHaveLength(0);
  });

  it('offers nothing when the template has the checklist switched off', () => {
    expect(perPetChecklistRows(template({ checklistEnabled: false }), kin(), ctx(), {})).toEqual([]);
  });
});

describe('perVisitChecklistRows', () => {
  it('keys per-visit rows by the bare fieldKey, with no kin id', () => {
    const rows = perVisitChecklistRows(template(), ctx(), {});
    const trash = rows.find((r) => r.item.key === 'trash_taken_out');
    expect(trash?.key).toBe('trash_taken_out');
    expect(trash?.kinId).toBe('');
  });

  it('still offers per-visit rows for a visit with no kin on file', () => {
    const rows = perVisitChecklistRows(template(), ctx({ kinList: [] }), {});
    expect(rows.map((r) => r.item.key)).toEqual(['trash_taken_out', 'lights_off']);
  });
});

describe('setChecklistResponse (the wire shape)', () => {
  it('writes the full FieldResponse a Kotlin decoder expects, keyed kinId|fieldKey', () => {
    const next = setChecklistResponse({}, 'fed', 'k1', true);
    expect(next).toEqual<Record<string, FieldResponse>>({
      'k1|fed': {
        fieldKey: 'fed',
        kinId: 'k1',
        sectionKey: '',
        boolValue: true,
        intValue: null,
        stringValue: '',
        mediaIds: [],
      },
    });
  });

  it('keys a per-visit answer by the bare fieldKey', () => {
    expect(Object.keys(setChecklistResponse({}, 'lights_off', '', true))).toEqual(['lights_off']);
  });

  /**
   * The M18-compatibility pin. The operator ruling is that a client must see an
   * item deliberately left undone as UNTICKED. Deleting the entry on untick
   * throws that fact away; `boolValue: false` keeps it.
   */
  it('keeps the entry on untick, recording false rather than deleting it', () => {
    const ticked = setChecklistResponse({}, 'fed', 'k1', true);
    const unticked = setChecklistResponse(ticked, 'fed', 'k1', false);
    expect(Object.keys(unticked)).toEqual(['k1|fed']);
    expect(unticked['k1|fed']?.boolValue).toBe(false);
  });

  it('preserves fields another platform wrote, replacing only boolValue', () => {
    const existing: Record<string, FieldResponse> = {
      'k1|fed': {
        fieldKey: 'fed',
        kinId: 'k1',
        sectionKey: 'care',
        boolValue: false,
        intValue: 2,
        stringValue: 'Half a cup',
        mediaIds: ['m1'],
      },
    };
    expect(setChecklistResponse(existing, 'fed', 'k1', true)['k1|fed']).toEqual({
      fieldKey: 'fed',
      kinId: 'k1',
      sectionKey: 'care',
      boolValue: true,
      intValue: 2,
      stringValue: 'Half a cup',
      mediaIds: ['m1'],
    });
  });

  it('does not mutate the map it was given', () => {
    const before: Record<string, FieldResponse> = {};
    setChecklistResponse(before, 'fed', 'k1', true);
    expect(before).toEqual({});
  });
});

describe('checklistHasContent', () => {
  it('counts a ticked item', () => {
    expect(checklistHasContent(setChecklistResponse({}, 'fed', 'k1', true))).toBe(true);
  });

  it('refuses an all-unticked map, so unticking alone never mints a ghost row', () => {
    const unticked = setChecklistResponse(setChecklistResponse({}, 'fed', 'k1', true), 'fed', 'k1', false);
    expect(checklistHasContent(unticked)).toBe(false);
  });

  it('counts a note another platform wrote, even with nothing ticked', () => {
    expect(
      checklistHasContent({
        note: { fieldKey: 'note', kinId: '', sectionKey: '', boolValue: null, intValue: null, stringValue: 'Bins out front', mediaIds: [] },
      }),
    ).toBe(true);
  });

  it('is false for an empty map', () => {
    expect(checklistHasContent({})).toBe(false);
  });
});

describe('decodeFieldResponses', () => {
  it('fills every missing field with its Kotlin data-class default', () => {
    expect(decodeFieldResponses({ 'k1|fed': { fieldKey: 'fed' } })).toEqual({
      'k1|fed': {
        fieldKey: 'fed',
        kinId: '',
        sectionKey: '',
        boolValue: null,
        intValue: null,
        stringValue: '',
        mediaIds: [],
      },
    });
  });

  it('drops an entry with no fieldKey rather than inventing a blank one', () => {
    expect(decodeFieldResponses({ junk: { kinId: 'k1', boolValue: true } })).toEqual({});
  });

  it('drops non-object entries instead of coercing them', () => {
    expect(decodeFieldResponses({ a: 'nope', b: null, c: [1, 2] })).toEqual({});
  });

  it('returns an empty map for a missing, null or array field', () => {
    expect(decodeFieldResponses(undefined)).toEqual({});
    expect(decodeFieldResponses(null)).toEqual({});
    expect(decodeFieldResponses([])).toEqual({});
  });

  it('round-trips what setChecklistResponse wrote', () => {
    const written = setChecklistResponse({}, 'fed', 'k1', true);
    expect(decodeFieldResponses(written)).toEqual(written);
  });
});

describe('tickedCareTasks (what Ask Auntie is told was done, #2052)', () => {
  const tpl = template({
    checklistEnabled: true,
    checklistItems: [
      makeChecklistItem({ key: 'fed', text: 'Fed', scope: 'PER_PET', order: 0 }),
      makeChecklistItem({ key: 'gate', text: 'Gate locked', scope: 'PER_VISIT', order: 1 }),
      makeChecklistItem({ key: 'meds', text: 'Medications given', scope: 'PER_PET', order: 2 }),
    ],
  });
  const two = ctx({ kinList: [kin({ _id: 'k1', name: 'Biscuit' }), kin({ _id: 'k2', name: 'Mochi' })] });
  const tick = (r: Record<string, FieldResponse>, key: string, kinId: string) => setChecklistResponse(r, key, kinId, true);
  it('lists each ticked task with the Kin it was for, visit-wide tasks first', () => {
    let r: Record<string, FieldResponse> = {};
    r = tick(r, 'fed', 'k2');
    r = tick(r, 'gate', '');
    r = tick(r, 'meds', 'k1');
    expect(tickedCareTasks(tpl, two, r)).toEqual([
      { text: 'Gate locked', kin_name: '' },
      { text: 'Medications given', kin_name: 'Biscuit' },
      { text: 'Fed', kin_name: 'Mochi' },
    ]);
  });
  it('a task ticked and then unticked is not reported as done', () => {
    let r = tick({}, 'fed', 'k1');
    r = setChecklistResponse(r, 'fed', 'k1', false);
    expect(tickedCareTasks(tpl, two, r)).toEqual([]);
  });
  it('nothing ticked, no template, or the checklist switched off is an empty list', () => {
    expect(tickedCareTasks(tpl, two, {})).toEqual([]);
    expect(tickedCareTasks(null, two, tick({}, 'gate', ''))).toEqual([]);
    expect(tickedCareTasks({ ...tpl, checklistEnabled: false }, two, tick({}, 'gate', ''))).toEqual([]);
  });
  it('a tick for a Kin that is not on this visit is not reported', () => {
    expect(tickedCareTasks(tpl, two, tick({}, 'fed', 'k-not-here'))).toEqual([]);
  });
});
