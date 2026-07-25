import { makeChecklistItem, type ChecklistItem } from './kinTale/model';

/**
 * The shared bank of common KinTale checklist items: the pure half, ported
 * case-for-case from the archive's `data/ChecklistBank.kt` (and matching
 * android's `ui/kintales/ChecklistBankHelpers.kt`, so the same item offered on
 * either platform lands identically).
 *
 * The I/O half is `api/checklistBank.ts` (the `listChecklistBank` /
 * `saveChecklistBankItem` admin callables). Kept apart so the picker's
 * de-duplication and scope rules are testable without a callable in sight.
 */

export type BankScope = 'PER_PET' | 'PER_VISIT';

/** One saved bank row. `scope` is narrowed on decode, so it is never a third value. */
export interface ChecklistBankItem {
  id: string;
  text: string;
  scope: string;
}

function norm(s: string): string {
  return (s ?? '').trim().toLowerCase();
}

/**
 * Narrows a free-text scope to the two the bank models. Anything unrecognized
 * becomes PER_PET, matching the Kotlin decoder's
 * `takeIf { it == "PER_VISIT" } ?: "PER_PET"` and the callable's zod default.
 */
export function normalizeBankScope(scope: string): BankScope {
  return norm(scope) === 'per_visit' ? 'PER_VISIT' : 'PER_PET';
}

/** True when [items] already carries this text, ignoring case and surrounding space. */
export function checklistHasText(items: readonly ChecklistItem[], text: string): boolean {
  const key = norm(text);
  return items.some((i) => norm(i.text) === key);
}

/**
 * Bank rows not already present in the template's checklist, so the quick-add
 * never offers a duplicate of something the operator has already added.
 */
export function bankItemsNotInChecklist(
  bank: readonly ChecklistBankItem[],
  items: readonly ChecklistItem[],
): ChecklistBankItem[] {
  return bank.filter((b) => !checklistHasText(items, b.text));
}

/**
 * What one checklist SECTION should offer: the not-yet-added bank rows saved for
 * that scope. Scope is compared after normalization, so a legacy lowercase
 * `per_visit` row still lands in the per-visit section rather than silently
 * defaulting into per-pet.
 */
export function bankItemsForScope(
  bank: readonly ChecklistBankItem[],
  items: readonly ChecklistItem[],
  scope: string,
): ChecklistBankItem[] {
  const want = normalizeBankScope(scope);
  return bankItemsNotInChecklist(bank, items).filter((b) => normalizeBankScope(b.scope) === want);
}

/**
 * Build a template checklist row from a picked bank item. Everything except
 * text/scope/key/order comes from the model default: a bank item carries no
 * visibility conditions, so the new row starts unconditionally visible.
 */
export function checklistItemFromBank(
  bankItem: ChecklistBankItem,
  key: string,
  order: number,
): ChecklistItem {
  return makeChecklistItem({
    key,
    text: bankItem.text,
    scope: normalizeBankScope(bankItem.scope),
    order,
  });
}
