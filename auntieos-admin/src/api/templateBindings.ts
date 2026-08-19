import { call } from '../lib/fns';

/**
 * The template-ASSIGNMENT surface: the binding between a notification catalog
 * key and the email template that dispatch sends for it. Separate from
 * `templates.ts` (the `emailTemplates` bank itself) and `templatesWrite.ts`
 * (create/edit/delete a template): a binding lives in its own collection,
 * `notificationTemplateBindings/{catalogKey}`, and is what
 * `TemplateAssignmentScreen.kt` managed in the wasm app.
 *
 * SOURCE CONFIRMED against the callables, not assumed:
 *  - `listTemplateBindings` (MyTribe/functions/src/admin/listTemplates.ts):
 *    every `notificationTemplateBindings` doc → { catalogKey (=doc id),
 *    templateId, audience, triggerKey, active }.
 *  - `listCatalogKeys` (…/admin/listCatalogKeys.ts): every key an admin can bind,
 *    as rows. It used to return the keys already bound, a read of the same
 *    collection it was meant to describe, so with no bindings it returned
 *    nothing and no client could offer a picker (issue #383). It now returns the
 *    notification catalog plus the direct-send keys, each row saying what it is
 *    and what it dispatches today.
 *  - `assignTemplate` (…/admin/assignTemplate.ts): upserts the binding with
 *    `{ merge: true }`, verifying the target template exists (throws
 *    `not-found` otherwise) and that the catalog key is real (throws
 *    `invalid-argument` naming the key, issue #382). Per AO-30 it writes
 *    `triggerKey` only when supplied.
 *  - `unassignTemplate` (…/admin/unassignTemplate.ts, added 2026-07-17 to close
 *    AO-56): deletes the binding doc; idempotent (removed:false if it was
 *    already gone). This is the missing half without which a bound template
 *    could never be deleted (deleteTemplate refuses while a binding points at it).
 */
export interface TemplateBinding {
  /** The notification catalog key; also the binding doc id. */
  catalogKey: string;
  /** The `emailTemplates` doc this key dispatches. '' when the doc lost the field. */
  templateId: string;
  /** 'kinfolk' | 'auntie' | 'admin' | 'guest' | null. */
  audience: string | null;
  triggerKey: string | null;
  active: boolean;
}

export async function listTemplateBindings(): Promise<TemplateBinding[]> {
  const res = await call<Record<string, never>, { bindings: TemplateBinding[] }>(
    'listTemplateBindings',
    {},
  );
  return res.bindings ?? [];
}

/**
 * Where a catalog key comes from.
 *  - `catalog`     a row in the notification catalog.
 *  - `direct-send` a key sent straight through `sendFromTemplate`, outside the
 *                  dispatcher (portal invites, recovery mail, the error digest).
 *  - `legacy`      a key sitting in the bindings collection that is neither of
 *                  the above. Nothing dispatches it, so it is shown but never
 *                  offered as something new to bind.
 */
export type CatalogKeySource = 'catalog' | 'direct-send' | 'legacy';

export interface CatalogKeyRow {
  key: string;
  /** Human name for the key, e.g. 'KinCare booking confirmed'. */
  label: string;
  /** Catalog category, or null for keys that live outside the catalog. */
  category: string | null;
  /** Catalog audience ('kinfolk' | 'business' | 'both'), or null outside it. */
  audience: string | null;
  source: CatalogKeySource;
  /** What dispatch falls back to when this key has no binding. */
  defaultTemplateId: string;
  /** Whether that fallback template actually exists in the bank. */
  hasDefaultTemplate: boolean;
  /** Whether a binding doc exists for this key. */
  bound: boolean;
  /** What dispatch sends for this key right now. */
  resolvedTemplateId: string;
}

export async function listCatalogKeys(): Promise<CatalogKeyRow[]> {
  const res = await call<Record<string, never>, { keys: string[]; rows: CatalogKeyRow[] }>(
    'listCatalogKeys',
    {},
  );
  return res.rows ?? [];
}

/** The keys a NEW binding may be written under. Legacy keys are not among them. */
export function bindableKeys(rows: CatalogKeyRow[]): CatalogKeyRow[] {
  return rows.filter((r) => r.source !== 'legacy');
}

export const BINDING_AUDIENCES = ['kinfolk', 'auntie', 'admin', 'guest'] as const;

export interface AssignTemplateArgs {
  catalogKey: string;
  templateId: string;
  /**
   * Passed through only when set. assignTemplate merges `audience: value ?? null`,
   * so this form always sends the current/chosen audience rather than dropping
   * the field and letting the backend null it on a re-assign.
   */
  audience?: string;
  active?: boolean;
}

export async function assignTemplate(
  args: AssignTemplateArgs,
): Promise<{ catalogKey: string; templateId: string; active: boolean }> {
  return await call<AssignTemplateArgs, { catalogKey: string; templateId: string; active: boolean }>(
    'assignTemplate',
    args,
  );
}

export async function unassignTemplate(
  catalogKey: string,
): Promise<{ catalogKey: string; removed: boolean }> {
  return await call<{ catalogKey: string }, { catalogKey: string; removed: boolean }>(
    'unassignTemplate',
    { catalogKey },
  );
}
