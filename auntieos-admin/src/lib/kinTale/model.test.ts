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
 * from the Compose/android `DefaultKinTaleTemplate` (round-trip fidelity).
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

  it('ports the 12 default checklist items (6 per-pet, 6 per-visit)', () => {
    const items = DEFAULT_KINTALE_TEMPLATE.checklistItems;
    expect(items).toHaveLength(12);
    expect(items.filter((i) => i.scope === 'PER_PET')).toHaveLength(6);
    expect(items.filter((i) => i.scope === 'PER_VISIT')).toHaveLength(6);
    // peed/pooed are required; everything defaults to showWhenUnchecked=false, no conditions
    const peed = items.find((i) => i.key === 'peed');
    expect(peed?.required).toBe(true);
    expect(peed?.showWhenUnchecked).toBe(false);
    expect(peed?.conditions).toEqual([]);
    expect(items.find((i) => i.key === 'fed')?.required).toBe(false);
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
