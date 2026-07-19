import { describe, it, expect } from 'vitest';
import {
  KINTALE_TEMPLATES_QUERY,
  decodeKinTaleTemplate,
  decodeChecklistItem,
  decodeFieldCondition,
  pickInitialTemplate,
} from './kinTaleTemplates';
import { DEFAULT_KINTALE_TEMPLATE, type KinTaleTemplate } from '../lib/kinTale/model';

describe('KINTALE_TEMPLATES_QUERY', () => {
  it('is a bounded, ordered listener on kintale_templates', () => {
    expect(KINTALE_TEMPLATES_QUERY.path).toBe('kintale_templates');
    expect(KINTALE_TEMPLATES_QUERY.order).toEqual(['name', 'asc']);
    expect(KINTALE_TEMPLATES_QUERY.max).toBeGreaterThan(0);
  });
});

describe('decodeKinTaleTemplate: partial docs fill Kotlin data-class defaults', () => {
  it('fills every field for an almost-empty doc, defaulting arrays to EMPTY (not the built-in rows)', () => {
    const t = decodeKinTaleTemplate({ _id: 'x1', name: 'Bare' });
    expect(t).toEqual<KinTaleTemplate>({
      _id: 'x1',
      name: 'Bare',
      description: '',
      defaultEmailMessage: DEFAULT_KINTALE_TEMPLATE.defaultEmailMessage,
      serviceTypeKeys: [],
      isActive: true,
      isDefault: false,
      photoShowcaseEnabled: true,
      checklistEnabled: true,
      petMoodEnabled: false,
      visitNotesEnabled: true,
      nextAppointmentEnabled: true,
      reviewBoosterEnabled: false,
      checklistItems: [],
      moodOptions: [],
      createdAt: '',
      updatedAt: '',
    });
  });

  it('preserves booleans a doc explicitly sets to false', () => {
    const t = decodeKinTaleTemplate({
      _id: 'x2',
      name: 'Off',
      isActive: false,
      photoShowcaseEnabled: false,
      checklistEnabled: false,
    });
    expect(t.isActive).toBe(false);
    expect(t.photoShowcaseEnabled).toBe(false);
    expect(t.checklistEnabled).toBe(false);
  });

  it('decodes nested checklist items with conditions, filling item defaults', () => {
    const t = decodeKinTaleTemplate({
      _id: 'x3',
      name: 'With items',
      checklistItems: [
        {
          key: 'meds',
          text: 'Meds',
          scope: 'PER_PET',
          order: 2,
          conditions: [{ source: 'KINFOLK_TAG', op: 'EXISTS' }],
        },
      ],
    });
    expect(t.checklistItems).toHaveLength(1);
    const item = t.checklistItems[0]!;
    expect(item).toMatchObject({ key: 'meds', text: 'Meds', scope: 'PER_PET', order: 2 });
    // Missing item fields default (required false, showWhenUnchecked false).
    expect(item.required).toBe(false);
    expect(item.showWhenUnchecked).toBe(false);
    // Condition value/attributeKey default to blank.
    expect(item.conditions[0]).toEqual({ source: 'KINFOLK_TAG', op: 'EXISTS', value: '', attributeKey: '' });
  });

  it('ignores non-string entries in serviceTypeKeys rather than passing junk through', () => {
    const t = decodeKinTaleTemplate({ _id: 'x4', name: 'n', serviceTypeKeys: ['Dog Walk', 3, null, 'Drop-in'] });
    expect(t.serviceTypeKeys).toEqual(['Dog Walk', 'Drop-in']);
  });

  it('is robust to a wholly malformed value', () => {
    expect(decodeKinTaleTemplate(null).name).toBe('');
    expect(decodeKinTaleTemplate('nope').checklistItems).toEqual([]);
  });
});

describe('decodeChecklistItem / decodeFieldCondition', () => {
  it('keeps an unknown source/op as-is (forward-compatible; the engine fails open)', () => {
    const c = decodeFieldCondition({ source: 'FUTURE_SOURCE', op: 'FUTURE_OP', value: 'v' });
    expect(c).toEqual({ source: 'FUTURE_SOURCE', op: 'FUTURE_OP', value: 'v', attributeKey: '' });
  });

  it('defaults a blank condition to KIN_SPECIES / EQUALS', () => {
    expect(decodeFieldCondition({})).toEqual({ source: 'KIN_SPECIES', op: 'EQUALS', value: '', attributeKey: '' });
  });

  it('defaults a bare checklist item to PER_PET, not required', () => {
    expect(decodeChecklistItem({})).toEqual({
      key: '',
      text: '',
      scope: 'PER_PET',
      showWhenUnchecked: false,
      required: false,
      order: 0,
      conditions: [],
    });
  });
});

describe('pickInitialTemplate', () => {
  const t = (over: Partial<KinTaleTemplate>): KinTaleTemplate =>
    decodeKinTaleTemplate({ _id: 'id', name: 'n', ...over });

  it('prefers the default template', () => {
    const list = [t({ _id: 'a', isDefault: false }), t({ _id: 'b', isDefault: true })];
    expect(pickInitialTemplate(list)?._id).toBe('b');
  });

  it('falls back to the first when none is default', () => {
    const list = [t({ _id: 'a' }), t({ _id: 'b' })];
    expect(pickInitialTemplate(list)?._id).toBe('a');
  });

  it('is null for an empty list (caller then seeds a fresh draft)', () => {
    expect(pickInitialTemplate([])).toBeNull();
  });
});
