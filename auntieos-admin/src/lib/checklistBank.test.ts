import { describe, expect, it } from 'vitest';
import { makeChecklistItem } from './kinTale/model';
import {
  bankItemsForScope,
  bankItemsNotInChecklist,
  checklistHasText,
  checklistItemFromBank,
  type ChecklistBankItem,
} from './checklistBank';

/** Ported case-for-case from the archive's `ChecklistBankTest.kt`. */

function bankItem(over: Partial<ChecklistBankItem> = {}): ChecklistBankItem {
  return { id: 'a', text: 'Fresh water', scope: 'PER_PET', ...over };
}

describe('checklistHasText', () => {
  it('matches ignoring case and surrounding space, so the bank never offers a near-duplicate', () => {
    const items = [makeChecklistItem({ key: 'i1', text: 'Fresh Water' })];
    expect(checklistHasText(items, '  fresh water ')).toBe(true);
    expect(checklistHasText(items, 'Walk')).toBe(false);
  });
});

describe('bankItemsNotInChecklist', () => {
  it('drops bank entries already present in the checklist', () => {
    const bank = [bankItem({ id: 'a', text: 'Fresh water' }), bankItem({ id: 'b', text: 'Walk' })];
    const items = [makeChecklistItem({ key: 'i1', text: 'fresh water' })];
    expect(bankItemsNotInChecklist(bank, items).map((b) => b.text)).toEqual(['Walk']);
  });

  it('returns the whole bank when the checklist is empty', () => {
    const bank = [bankItem({ id: 'a' }), bankItem({ id: 'b', text: 'Walk' })];
    expect(bankItemsNotInChecklist(bank, [])).toHaveLength(2);
  });
});

describe('bankItemsForScope', () => {
  it('offers a scope only the items saved for it, case-insensitively', () => {
    const bank = [
      bankItem({ id: 'a', text: 'Fresh water', scope: 'PER_PET' }),
      bankItem({ id: 'b', text: 'Home secured', scope: 'per_visit' }),
    ];
    expect(bankItemsForScope(bank, [], 'PER_VISIT').map((b) => b.text)).toEqual(['Home secured']);
    expect(bankItemsForScope(bank, [], 'PER_PET').map((b) => b.text)).toEqual(['Fresh water']);
  });

  it('excludes an item already in the checklist even when the scope matches', () => {
    const bank = [bankItem({ id: 'a', text: 'Fresh water', scope: 'PER_PET' })];
    const items = [makeChecklistItem({ key: 'i1', text: 'Fresh water', scope: 'PER_PET' })];
    expect(bankItemsForScope(bank, items, 'PER_PET')).toEqual([]);
  });
});

describe('checklistItemFromBank', () => {
  it('carries the text and scope onto a fresh checklist item at the given key/order', () => {
    const item = checklistItemFromBank(bankItem({ text: 'Walk', scope: 'PER_VISIT' }), 'item_9', 3);
    expect(item).toMatchObject({ key: 'item_9', text: 'Walk', scope: 'PER_VISIT', order: 3 });
    // Everything else comes from the model default: a bank item carries no
    // conditions, so the new row is unconditionally visible.
    expect(item.conditions).toEqual([]);
    expect(item.required).toBe(false);
  });

  it('normalizes an unrecognized scope to PER_PET rather than persisting it', () => {
    const item = checklistItemFromBank(bankItem({ scope: 'SOMETHING_ELSE' }), 'item_1', 0);
    expect(item.scope).toBe('PER_PET');
  });
});
