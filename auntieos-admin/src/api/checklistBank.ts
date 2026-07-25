import { call } from '../lib/fns';
import { normalizeBankScope, type ChecklistBankItem } from '../lib/checklistBank';

/**
 * I/O half of the shared KinTale checklist bank. Both callables are DEPLOYED
 * admin-gated onCalls in the MyTribe codebase
 * (`mytribe/functions/src/admin/checklistBank.ts`, exported from `index.ts:161`,
 * both wrapped in `wrapAdminCallable`), so nothing here needs building on the
 * backend: the React admin simply never wired them.
 *
 * `listChecklistBank` returns `{ items: [{id, text, scope}], schemaVersion }`,
 * already merged server-side from five code defaults plus the persisted
 * `checklist_bank` collection, deduped by normalized text and sorted. So there
 * is nothing to sort or seed here; decode defensively and hand it on.
 *
 * Fail-loud: a rejection propagates unchanged so the editor names the reason.
 * An empty picker must mean "the bank is empty", never "the read failed".
 */

interface RawBankItem {
  id?: unknown;
  text?: unknown;
  scope?: unknown;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Decode the callable body. Mirrors the Kotlin `decodeChecklistBank`: unknown
 * scopes normalize to PER_PET and blank-texted rows are dropped, because a
 * textless row would render as an unlabeled quick-add button.
 */
export function decodeChecklistBank(body: unknown): ChecklistBankItem[] {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items
    .map((raw): ChecklistBankItem => {
      const o = (raw ?? {}) as RawBankItem;
      return { id: str(o.id), text: str(o.text), scope: normalizeBankScope(str(o.scope)) };
    })
    .filter((i) => i.text.trim() !== '');
}

/** The merged bank (code defaults union the persisted `checklist_bank`). */
export async function listChecklistBank(): Promise<ChecklistBankItem[]> {
  const body = await call<Record<string, never>, unknown>('listChecklistBank', {});
  return decodeChecklistBank(body);
}

/**
 * Persist one item to the shared bank ("Save to bank"). Blank text is refused
 * here rather than spent on a round trip the callable's
 * `z.string().trim().min(1)` would reject anyway.
 */
export async function saveChecklistBankItem(text: string, scope: string): Promise<ChecklistBankItem> {
  const trimmed = (text ?? '').trim();
  if (trimmed === '') throw new Error('A bank item needs text; blank items are not saved.');
  const payload = { text: trimmed, scope: normalizeBankScope(scope) };
  const body = await call<typeof payload, RawBankItem>('saveChecklistBankItem', payload);
  return { id: str(body?.id), text: str(body?.text), scope: normalizeBankScope(str(body?.scope)) };
}
