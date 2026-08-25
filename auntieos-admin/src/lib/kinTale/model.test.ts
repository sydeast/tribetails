import { describe, it, expect } from 'vitest';
import {
  DEFAULT_KINTALE_TEMPLATE,
  DEFAULT_KINTALE_TEMPLATE_ID,
  makeChecklistItem,
  makeFieldCondition,
  makeMoodOption,
  responseKey,
} from './model';

/**
 * Pins the ported model constants so the default template cannot silently drift
 * from Android's `DefaultKinTaleTemplate` (`KinTaleTemplateEngine.kt`).
 *
 * ANDROID, not the Compose desktop, is the reference, and the keys are the whole
 * point: the kinfolk portal resolves a blank-`templateId` report's checklist
 * labels against Android's list alone, so a key that exists only in the
 * desktop's list is dropped before the household ever sees it. The long form of
 * that argument is in `model.ts`'s own header.
 */

describe('DEFAULT_KINTALE_TEMPLATE', () => {
  it('carries the built-in id and is the active default', () => {
    expect(DEFAULT_KINTALE_TEMPLATE_ID).toBe('__builtin_default__');
    expect(DEFAULT_KINTALE_TEMPLATE._id).toBe('__builtin_default__');
    expect(DEFAULT_KINTALE_TEMPLATE.isDefault).toBe(true);
    expect(DEFAULT_KINTALE_TEMPLATE.isActive).toBe(true);
  });

  it('mirrors the section flags (petMood on, reviewBooster off)', () => {
    expect(DEFAULT_KINTALE_TEMPLATE.photoShowcaseEnabled).toBe(true);
    expect(DEFAULT_KINTALE_TEMPLATE.checklistEnabled).toBe(true);
    expect(DEFAULT_KINTALE_TEMPLATE.petMoodEnabled).toBe(true);
    expect(DEFAULT_KINTALE_TEMPLATE.visitNotesEnabled).toBe(true);
    expect(DEFAULT_KINTALE_TEMPLATE.nextAppointmentEnabled).toBe(true);
    expect(DEFAULT_KINTALE_TEMPLATE.reviewBoosterEnabled).toBe(false);
  });

  it('ports the 10 Android default checklist items, keys and order intact', () => {
    const items = DEFAULT_KINTALE_TEMPLATE.checklistItems;
    expect(items.map((i) => i.key)).toEqual([
      'peed',
      'pooed',
      'fed',
      'fresh_water',
      'meds_given',
      'played',
      'litter_scooped',
      'walk_water_refill',
      'trash_taken_out',
      'lights_off',
    ]);
    expect(items.map((i) => i.order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(items.filter((i) => i.scope === 'PER_PET')).toHaveLength(8);
    expect(items.filter((i) => i.scope === 'PER_VISIT')).toHaveLength(2);
  });

  /**
   * The keys the kinfolk portal can resolve for a blank `templateId`, verbatim
   * from `mytribe/functions/src/portal/getMyKinTales.ts`'s
   * `DEFAULT_TEMPLATE_CHECKLIST_ITEMS`. A tick written against a key absent from
   * that list is dropped by the portal, so this is the round-trip pin, not a
   * restatement of the test above.
   */
  it('uses only keys the portal can resolve for a blank templateId', () => {
    const portalResolvable = [
      'peed',
      'pooed',
      'fed',
      'fresh_water',
      'meds_given',
      'played',
      'litter_scooped',
      'walk_water_refill',
      'trash_taken_out',
      'lights_off',
    ];
    for (const item of DEFAULT_KINTALE_TEMPLATE.checklistItems) {
      expect(portalResolvable).toContain(item.key);
    }
  });

  it('keeps peed/pooed visible when unchecked, and ports the three conditional items', () => {
    const items = DEFAULT_KINTALE_TEMPLATE.checklistItems;
    const by = (key: string) => items.find((i) => i.key === key);

    expect(by('peed')?.showWhenUnchecked).toBe(true);
    expect(by('pooed')?.showWhenUnchecked).toBe(true);
    expect(by('fed')?.showWhenUnchecked).toBe(false);

    expect(by('meds_given')?.conditions).toEqual([
      { source: 'KIN_ATTRIBUTE', op: 'EXISTS', value: '', attributeKey: 'medicationHealthNotes' },
    ]);
    expect(by('litter_scooped')?.conditions).toEqual([
      { source: 'KIN_SPECIES', op: 'EQUALS', value: 'Cat', attributeKey: '' },
    ]);
    expect(by('walk_water_refill')?.conditions).toEqual([
      { source: 'SERVICE_TYPE', op: 'CONTAINS', value: 'walk', attributeKey: '' },
    ]);

    // Everything else is unconditional, exactly as on Android.
    const conditional = items.filter((i) => i.conditions.length > 0).map((i) => i.key);
    expect(conditional).toEqual(['meds_given', 'litter_scooped', 'walk_water_refill']);
  });

  it('ports the 8 mood options in order', () => {
    const moods = DEFAULT_KINTALE_TEMPLATE.moodOptions;
    expect(moods).toHaveLength(8);
    expect(moods.map((m) => m.key)).toEqual([
      'happy',
      'playful',
      'calm',
      'cuddly',
      'anxious',
      'shy',
      'energetic',
      'sleepy',
    ]);
    expect(moods[0]).toEqual({ key: 'happy', label: 'Happy', emoji: '😊', order: 0 });
  });
});

describe('makeFieldCondition / makeChecklistItem / makeMoodOption defaults', () => {
  it('makeFieldCondition mirrors the Kotlin data-class defaults', () => {
    expect(makeFieldCondition()).toEqual({
      source: 'KIN_SPECIES',
      op: 'EQUALS',
      value: '',
      attributeKey: '',
    });
  });

  it('makeChecklistItem defaults to PER_PET, not required, no conditions', () => {
    expect(makeChecklistItem()).toEqual({
      key: '',
      text: '',
      scope: 'PER_PET',
      showWhenUnchecked: false,
      required: false,
      order: 0,
      conditions: [],
    });
  });

  it('makeMoodOption defaults to blanks at order 0', () => {
    expect(makeMoodOption({ key: 'zoomies', label: 'Zoomies', emoji: '💨' })).toEqual({
      key: 'zoomies',
      label: 'Zoomies',
      emoji: '💨',
      order: 0,
    });
  });
});

describe('responseKey', () => {
  it('bare fieldKey when kinId is blank', () => {
    expect(responseKey('fed', '')).toBe('fed');
    expect(responseKey('fed', '   ')).toBe('fed');
  });

  it('composite "kinId|fieldKey" when kinId is present', () => {
    expect(responseKey('fed', 'kin1')).toBe('kin1|fed');
  });
});
