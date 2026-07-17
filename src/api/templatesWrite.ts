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
 * the backend's Zod contract, `{ templateId }` (the same field name
 * `saveTemplate` above uses, unlike `formSchemasWrite.ts`'s `getFormSchema`
 * vs. `formSchemas.ts`'s `deleteFormSchema`, which disagree on `schemaId` vs.
 * `id`). Throws (via `lib/fns.call`) on `not-found`, `failed-precondition`
 * (still bound to a notification catalog key), or an auth error; the caller
 * surfaces the message fail-loud rather than swallowing it, same as
 * `saveTemplate` above.
 */
export async function deleteTemplate(templateId: string): Promise<{ templateId: string }> {
  const result = await call<{ templateId: string }, { templateId: string }>('deleteTemplate', {
    templateId,
  });
  return result;
}
