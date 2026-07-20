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
 *  - `listCatalogKeys` (…/admin/listCatalogKeys.ts): the distinct set of
 *    catalog keys already bound (a read of the same collection's ids). Used to
 *    warn about a key already in use before assigning.
 *  - `assignTemplate` (…/admin/assignTemplate.ts): upserts the binding with
 *    `{ merge: true }`, verifying the target template exists (throws
 *    `not-found` otherwise). Per AO-30 it writes `triggerKey` only when supplied.
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

export async function listCatalogKeys(): Promise<string[]> {
  const res = await call<Record<string, never>, { keys: string[] }>('listCatalogKeys', {});
  return res.keys ?? [];
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
