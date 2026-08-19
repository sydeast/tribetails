import { call } from '../lib/fns';
import type { SaveTemplatePayload } from '../lib/templateFormat';

/**
 * The Template Bank WRITE surface: `saveTemplate` (admin) -> { templateId },
 * and `deleteTemplate` (admin) -> { templateId }. Split from `templates.ts`
 * (the read-only `listTemplates`/`listCategories` pair) the same way
 * `formSchemas.ts`'s reads and this repo's write modules are already
 * separated by convention: reads and writes are separate files even when
 * they share one Firestore collection.
 *
 * SOURCE CONFIRMED against the callables, not assumed:
 * `MyTribe/functions/src/admin/saveTemplate.ts`'s `saveTemplateHandler` is
 * ONE upsert for both create and update: `emailTemplates/{templateId}` is set
 * with `{ merge: true }`, and whether the call is treated as a create or an
 * update server-side is decided purely by whether the doc already existed
 * before the write (`isCreate = !snap.exists`), not by a separate argument or
 * a separate callable. There is exactly one write callable for this
 * collection's create/update path: no `createTemplate`, no `updateTemplate`.
 * This module reflects that with a single `saveTemplate` export, matching the
 * backend 1:1 rather than inventing a create/update split the server does
 * not have.
 *
 * `deleteTemplate` (`MyTribe/functions/src/admin/deleteTemplate.ts`, added
 * 2026-07-17 to close the gap the paragraph above used to document) deletes
 * `emailTemplates/{templateId}` outright. It throws `not-found` if the doc
 * does not exist, and `failed-precondition` (naming every catalog key still
 * bound) if `notificationTemplateBindings` still points a notification
 * catalog key at this template, rather than silently orphaning that binding.
 * This client does not pre-check bindings itself: it forwards whatever the
 * server decides and surfaces the rejection fail-loud, the same way
 * `saveTemplate`'s Handlebars-triple-stash rejection is surfaced above.
 */
/**
 * Issue #468: the server's refusal when `expectNew` was sent and the key was
 * already taken. Duck-typed on `details.reason` rather than `instanceof
 * FirebaseError`, matching `isLiveNotificationKeyWarning` below, so a plain
 * rejected object in a test takes the same branch production does.
 */
export function isTemplateKeyTakenError(err: unknown): boolean {
  const details = (err as { details?: unknown } | null | undefined)?.details;
  if (typeof details !== 'object' || details === null) return false;
  return (details as { reason?: unknown }).reason === 'template-exists';
}
export async function saveTemplate(payload: SaveTemplatePayload): Promise<{ templateId: string }> {
  // Explicitly awaited, not `return call(...)`: matches the `await
  // call(...)` convention every other write module in this repo uses
  // (`accountWrite.ts#saveUserProfile`, `formSchemas.ts#deleteFormSchema`),
  // rather than forwarding the callable's promise unawaited.
  const result = await call<SaveTemplatePayload, { templateId: string }>('saveTemplate', payload);
  return result;
}

/**
 * deleteTemplate: permanently deletes `emailTemplates/{templateId}`. Matches
 * the backend's Zod contract, `{ templateId, acknowledgeLiveKey? }` (the same
 * `templateId` field name `saveTemplate` above uses, unlike
 * `formSchemasWrite.ts`'s `getFormSchema` vs. `formSchemas.ts`'s
 * `deleteFormSchema`, which disagree on `schemaId` vs. `id`). Throws (via
 * `lib/fns.call`) on `not-found`, `failed-precondition`, or an auth error; the
 * caller surfaces the message fail-loud rather than swallowing it, same as
 * `saveTemplate` above.
 *
 * `acknowledgeLiveKey` is sent ONLY on a second attempt, after the server has
 * refused once and said which notification the delete would break. It is not a
 * flag a screen sets up front: the point of the round trip is that the operator
 * has read the consequence before they confirm it.
 */
export interface DeleteTemplateOptions {
  acknowledgeLiveKey?: boolean;
}

export async function deleteTemplate(
  templateId: string,
  options: DeleteTemplateOptions = {},
): Promise<{ templateId: string }> {
  const result = await call<
    { templateId: string; acknowledgeLiveKey?: boolean },
    { templateId: string }
  >('deleteTemplate', {
    templateId,
    ...(options.acknowledgeLiveKey === true ? { acknowledgeLiveKey: true } : {}),
  });
  return result;
}

/**
 * True when [err] is the server's live-notification-key warning, the one refusal
 * a second, acknowledged call can get past.
 *
 * Read off `HttpsError.details`, which the Functions SDK puts on the thrown
 * `FirebaseError` and `lib/fns.call` rethrows untouched. Deliberately NOT a
 * match against the message text: `deleteTemplate` throws `failed-precondition`
 * for the binding case too, and that one has a different remedy (unassign) and
 * cannot be acknowledged past, so telling them apart by prose would be one copy
 * edit away from offering "Delete anyway" on a delete that can never succeed.
 * Duck-typed rather than `instanceof FirebaseError` so a plain rejected object
 * in a test exercises the same branch the SDK does.
 */
export function isLiveNotificationKeyWarning(err: unknown): boolean {
  const details = (err as { details?: unknown } | null | undefined)?.details;
  if (typeof details !== 'object' || details === null) return false;
  return (details as { reason?: unknown }).reason === 'live-catalog-key';
}

export interface AssignTemplatesToCategoryArgs {
  category: string;
  templateIds: string[];
}

export interface AssignTemplatesToCategoryResult {
  category: string;
  assigned: number;
  templateIds: string[];
}

/**
 * assignTemplatesToCategory (admin) -> { category, assigned, templateIds }. The
 * I9 "New Binding" batch write: merge one category onto MANY templates in a
 * single call, creating the category inline (the backend upserts the managed
 * `template_categories` pool). A binding of a template to a category is the
 * template's own `category` field; a batch callable rather than looping
 * `saveTemplate` because `saveTemplate` requires the full subject+body payload
 * on every call (see `MyTribe/functions/src/admin/assignTemplatesToCategory.ts`).
 * Rejects (fail-loud, via `lib/fns.call`) with `not-found` naming any missing
 * template, or an auth error; the caller surfaces the message rather than
 * swallowing it, same as `saveTemplate` above.
 */
export async function assignTemplatesToCategory(
  args: AssignTemplatesToCategoryArgs,
): Promise<AssignTemplatesToCategoryResult> {
  return await call<AssignTemplatesToCategoryArgs, AssignTemplatesToCategoryResult>(
    'assignTemplatesToCategory',
    args,
  );
}
