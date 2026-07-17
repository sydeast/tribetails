import { call } from '../lib/fns';
import type { SaveTemplatePayload } from '../lib/templateFormat';

/**
 * The Template Bank WRITE surface: `saveTemplate` (admin) -> { templateId }.
 * Split from `templates.ts` (the read-only `listTemplates`/`listCategories`
 * pair) the same way `formSchemas.ts`'s reads and this repo's write modules
 * are already separated by convention: reads and writes are separate files
 * even when they share one Firestore collection.
 *
 * SOURCE CONFIRMED against the callable, not assumed:
 * `MyTribe/functions/src/admin/saveTemplate.ts`'s `saveTemplateHandler` is
 * ONE upsert for both create and update: `emailTemplates/{templateId}` is set
 * with `{ merge: true }`, and whether the call is treated as a create or an
 * update server-side is decided purely by whether the doc already existed
 * before the write (`isCreate = !snap.exists`), not by a separate argument or
 * a separate callable. There is exactly one write callable for this
 * collection: no `createTemplate`, no `updateTemplate`. This module reflects
 * that with a single `saveTemplate` export, matching the backend 1:1 rather
 * than inventing a create/update split the server does not have.
 *
 * NO delete callable exists for `emailTemplates` as of this port
 * (2026-07-17): grepped the full `MyTribe/functions/src` tree and its
 * `index.ts` export list for `deleteTemplate`/`removeTemplate`/any writer
 * that touches `emailTemplates` other than `saveTemplate.ts` itself, zero
 * hits. `saveTemplate`, `assignTemplate`, and the two list callables are the
 * complete set. TemplateEditor.tsx is therefore CREATE + UPDATE only: there
 * is no delete affordance in this port, and none is invented here. A delete
 * callable is a backend addition out of scope for this frontend slice; flag
 * it back for a dedicated MyTribe Cloud Function task rather than fabricating
 * a client call to a callable that does not exist server-side.
 */
export async function saveTemplate(payload: SaveTemplatePayload): Promise<{ templateId: string }> {
  // Explicitly awaited, not `return call(...)`: matches the `await
  // call(...)` convention every other write module in this repo uses
  // (`accountWrite.ts#saveUserProfile`, `formSchemas.ts#deleteFormSchema`),
  // rather than forwarding the callable's promise unawaited.
  const result = await call<SaveTemplatePayload, { templateId: string }>('saveTemplate', payload);
  return result;
}
