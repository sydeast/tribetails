import { describe, it, expect } from 'vitest';
import {
  addChecklistItem,
  addCondition,
  addMood,
  attributeCatalogForSource,
  advancedOpenByDefault,
  changeConditionSource,
  freshChecklistKey,
  newTemplateDraft,
  nextOrderForScope,
  opLabel,
  perPetItems,
  perVisitItems,
  removeChecklistItem,
  removeCondition,
  removeMood,
  reorderChecklistItem,
  reorderMood,
  seedTemplateDraft,
  serviceKeysToText,
  textToServiceKeys,
  updateChecklistItem,
  updateCondition,
  updateMood,
  valuePlaceholder,
} from './kinTaleTemplateEdit';
import {
  ConditionOp,
  ConditionSource,
  makeChecklistItem,
  makeFieldCondition,
  makeMoodOption,
  type ChecklistItem,
} from './kinTale/model';
import { conditionAttributeCatalog, kinfolkAttributeCatalog } from './kinTale/engine';

function items(): ChecklistItem[] {
  return [
    makeChecklistItem({ key: 'a', scope: 'PER_PET', order: 0, text: 'A' }),
    makeChecklistItem({ key: 'b', scope: 'PER_PET', order: 1, text: 'B' }),
    makeChecklistItem({ key: 'c', scope: 'PER_VISIT', order: 0, text: 'C' }),
  ];
}

describe('scope partitioning', () => {
  it('splits per-pet / per-visit by scope, ordered', () => {
    expect(perPetItems(items()).map((i) => i.key)).toEqual(['a', 'b']);
    expect(perVisitItems(items()).map((i) => i.key)).toEqual(['c']);
  });

  it('treats a non-PER_PET scope as per-visit (fail-open, matching the engine)', () => {
    const list = [makeChecklistItem({ key: 'x', scope: 'weird', order: 0 })];
    expect(perVisitItems(list).map((i) => i.key)).toEqual(['x']);
    expect(perPetItems(list)).toEqual([]);
  });
});

describe('checklist add / update / remove', () => {
  it('freshChecklistKey skips existing item_N keys', () => {
    const list = [makeChecklistItem({ key: 'item_1' }), makeChecklistItem({ key: 'item_2' })];
    expect(freshChecklistKey(list)).toBe('item_3');
    expect(freshChecklistKey([])).toBe('item_1');
  });

  it('nextOrderForScope is max+1 within the scope, 0 when empty', () => {
    expect(nextOrderForScope(items(), 'PER_PET')).toBe(2);
    expect(nextOrderForScope(items(), 'PER_VISIT')).toBe(1);
    expect(nextOrderForScope([], 'PER_PET')).toBe(0);
  });

  it('addChecklistItem appends a blank item in the right scope at the next order', () => {
    const next = addChecklistItem(items(), 'PER_VISIT');
    const added = next[next.length - 1]!;
    expect(added.scope).toBe('PER_VISIT');
    expect(added.order).toBe(1);
    expect(added.key).toBe('item_1');
    expect(added.text).toBe('');
  });

  it('updateChecklistItem patches only the matching (key, scope)', () => {
    const next = updateChecklistItem(items(), 'a', 'PER_PET', { required: true, text: 'A!' });
    expect(next.find((i) => i.key === 'a')).toMatchObject({ required: true, text: 'A!' });
    expect(next.find((i) => i.key === 'b')?.required).toBe(false);
  });

  it('removeChecklistItem drops only the matching (key, scope)', () => {
    expect(removeChecklistItem(items(), 'a', 'PER_PET').map((i) => i.key)).toEqual(['b', 'c']);
  });
});

describe('reorderChecklistItem (swaps order within scope)', () => {
  it('moves an item later by swapping order with its neighbour', () => {
    const next = reorderChecklistItem(items(), 'a', 'PER_PET', 1);
    expect(next.find((i) => i.key === 'a')?.order).toBe(1);
    expect(next.find((i) => i.key === 'b')?.order).toBe(0);
  });

  it('is a no-op at the top edge', () => {
    expect(reorderChecklistItem(items(), 'a', 'PER_PET', -1)).toEqual(items());
  });

  it('never crosses scopes', () => {
    // 'c' is the only per-visit item; moving it down does nothing.
    expect(reorderChecklistItem(items(), 'c', 'PER_VISIT', 1)).toEqual(items());
  });
});

describe('condition source change (the I7 defaulting)', () => {
  it('defaults the attribute key when switching to KIN_ATTRIBUTE from a blank', () => {
    const c = changeConditionSource(makeFieldCondition(), ConditionSource.KIN_ATTRIBUTE);
    expect(c.source).toBe('KIN_ATTRIBUTE');
    expect(c.attributeKey).toBe(conditionAttributeCatalog[0]!.key);
  });

  it('defaults the attribute key when switching to KINFOLK_ATTRIBUTE', () => {
    const c = changeConditionSource(makeFieldCondition(), ConditionSource.KINFOLK_ATTRIBUTE);
    expect(c.source).toBe('KINFOLK_ATTRIBUTE');
    expect(c.attributeKey).toBe(kinfolkAttributeCatalog[0]!.key);
  });

  it('resets a KIN key that is invalid for the KINFOLK catalog when switching between the two', () => {
    const kin = makeFieldCondition({ source: ConditionSource.KIN_ATTRIBUTE, attributeKey: 'vetInfo' });
    const moved = changeConditionSource(kin, ConditionSource.KINFOLK_ATTRIBUTE);
    // 'vetInfo' is a KIN key, not a household key, so it is replaced.
    expect(moved.attributeKey).toBe(kinfolkAttributeCatalog[0]!.key);
  });

  it('keeps a still-valid attribute key untouched', () => {
    const kf = makeFieldCondition({ source: ConditionSource.KINFOLK_ATTRIBUTE, attributeKey: 'gateCode' });
    expect(changeConditionSource(kf, ConditionSource.KINFOLK_ATTRIBUTE).attributeKey).toBe('gateCode');
  });

  it('leaves the attribute key alone for a non-attribute source (KINFOLK_TAG, KIN_SPECIES)', () => {
    const c = makeFieldCondition({ source: ConditionSource.KIN_ATTRIBUTE, attributeKey: 'vetInfo' });
    expect(changeConditionSource(c, ConditionSource.KINFOLK_TAG).attributeKey).toBe('vetInfo');
    expect(changeConditionSource(c, ConditionSource.KIN_SPECIES).attributeKey).toBe('vetInfo');
  });

  it('attributeCatalogForSource maps each attribute source to its catalog, empty otherwise', () => {
    expect(attributeCatalogForSource(ConditionSource.KIN_ATTRIBUTE)).toBe(conditionAttributeCatalog);
    expect(attributeCatalogForSource(ConditionSource.KINFOLK_ATTRIBUTE)).toBe(kinfolkAttributeCatalog);
    expect(attributeCatalogForSource(ConditionSource.KINFOLK_TAG)).toEqual([]);
    expect(attributeCatalogForSource(ConditionSource.SERVICE_TYPE)).toEqual([]);
  });
});

describe('condition list add / update / remove', () => {
  it('addCondition appends a KIN_SPECIES / EQUALS default', () => {
    const next = addCondition([]);
    expect(next).toHaveLength(1);
    expect(next[0]).toEqual({ source: 'KIN_SPECIES', op: 'EQUALS', value: '', attributeKey: '' });
  });

  it('updateCondition replaces at index; removeCondition drops at index', () => {
    const base = [makeFieldCondition({ value: 'one' }), makeFieldCondition({ value: 'two' })];
    const edited = updateCondition(base, 1, makeFieldCondition({ value: 'TWO' }));
    expect(edited[1]?.value).toBe('TWO');
    expect(removeCondition(base, 0).map((c) => c.value)).toEqual(['two']);
  });
});

describe('op labels + value placeholder', () => {
  it('labels the four ops, falling back to the raw name for an unknown one', () => {
    expect(opLabel(ConditionOp.EQUALS)).toBe('is');
    expect(opLabel(ConditionOp.NOT_EQUALS)).toBe('is not');
    expect(opLabel(ConditionOp.CONTAINS)).toBe('contains');
    expect(opLabel(ConditionOp.EXISTS)).toBe('is set');
    expect(opLabel('FUTURE_OP')).toBe('FUTURE_OP');
  });

  it('tunes the value placeholder per source', () => {
    expect(valuePlaceholder(ConditionSource.KIN_SPECIES)).toMatch(/cat/i);
    expect(valuePlaceholder(ConditionSource.SERVICE_TYPE)).toMatch(/walk/i);
    expect(valuePlaceholder(ConditionSource.KINFOLK_TAG)).toMatch(/vip/i);
  });
});

describe('mood options', () => {
  it('addMood appends a fresh mood_N at the next order', () => {
    const next = addMood([makeMoodOption({ key: 'mood_1', order: 0 })]);
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ key: 'mood_2', order: 1 });
  });

  it('updateMood patches by key; removeMood drops by key', () => {
    const moods = [makeMoodOption({ key: 'happy', label: 'Happy' }), makeMoodOption({ key: 'sad', label: 'Sad' })];
    expect(updateMood(moods, 'happy', { emoji: '😊' }).find((m) => m.key === 'happy')?.emoji).toBe('😊');
    expect(removeMood(moods, 'happy').map((m) => m.key)).toEqual(['sad']);
  });

  it('reorderMood swaps order with the neighbour; no-op at the edges', () => {
    const moods = [
      makeMoodOption({ key: 'happy', order: 0 }),
      makeMoodOption({ key: 'sad', order: 1 }),
    ];
    const moved = reorderMood(moods, 'happy', 1);
    expect(moved.find((m) => m.key === 'happy')?.order).toBe(1);
    expect(moved.find((m) => m.key === 'sad')?.order).toBe(0);
    expect(reorderMood(moods, 'happy', -1)).toEqual(moods);
  });
});

describe('service-type keys CSV round-trip', () => {
  it('joins and splits, trimming blanks', () => {
    expect(serviceKeysToText(['Dog Walk', 'Drop-in'])).toBe('Dog Walk, Drop-in');
    expect(textToServiceKeys('Dog Walk,  Drop-in ,,')).toEqual(['Dog Walk', 'Drop-in']);
    expect(textToServiceKeys('')).toEqual([]);
  });
});

describe('new-template drafts', () => {
  it('seedTemplateDraft is the built-in default, unsaved, still the default', () => {
    const d = seedTemplateDraft();
    expect(d._id).toBe('');
    expect(d.name).toBe('Default KinTale');
    expect(d.isDefault).toBe(true);
    expect(d.checklistItems).toHaveLength(12);
  });

  it('newTemplateDraft is unsaved, renamed, and NOT default', () => {
    const d = newTemplateDraft();
    expect(d._id).toBe('');
    expect(d.name).toBe('New template');
    expect(d.isDefault).toBe(false);
  });

  it('drafts are deep clones: editing one never mutates the shared default constant', () => {
    const d = newTemplateDraft();
    d.checklistItems[0]!.text = 'MUTATED';
    d.moodOptions[0]!.label = 'MUTATED';
    const fresh = newTemplateDraft();
    expect(fresh.checklistItems[0]!.text).not.toBe('MUTATED');
    expect(fresh.moodOptions[0]!.label).not.toBe('MUTATED');
  });
});

/**
 * Item 8: which checklist items open their "Advanced" fold on load. Anything
 * off the defaults stays visible, so folding never hides configuration the
 * operator already made.
 */
describe('advancedOpenByDefault', () => {
  it('stays folded for a plain, default item', () => {
    expect(advancedOpenByDefault(makeChecklistItem({ text: 'Meds' }))).toBe(false);
  });
  it('opens for a required item', () => {
    expect(advancedOpenByDefault(makeChecklistItem({ required: true }))).toBe(true);
  });
  it('opens for a show-when-unchecked item', () => {
    expect(advancedOpenByDefault(makeChecklistItem({ showWhenUnchecked: true }))).toBe(true);
  });
  it('opens for an item carrying any condition', () => {
    const item = makeChecklistItem({
      conditions: [{ source: 'KIN_SPECIES', op: 'EQUALS', value: 'dog', attributeKey: '' }],
    });
    expect(advancedOpenByDefault(item)).toBe(true);
  });
});
