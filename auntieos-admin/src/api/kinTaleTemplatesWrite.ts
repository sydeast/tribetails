import { collection, doc, writeBatch } from 'firebase/firestore';
import { addDoc, commitBatch, setDoc } from '../lib/firestoreWrite';
import { db } from '../lib/firebase';
import { type KinTaleTemplate } from '../lib/kinTale/model';

/**
 * WRITE half of the `kintale_templates` admin surface (read side +
 * `KINTALE_TEMPLATES_QUERY` live in `api/kinTaleTemplates.ts`). Direct
 * client-SDK writes, gated by the Firestore rule
 * `match /kintale_templates/{id} { write: if isAuntie() }`
 * (MyTribe/firestore.rules): there is NO `saveKinTaleTemplate` callable, so
 * this mirrors `api/kinTalesWrite.ts`'s direct `addDoc`/`setDoc` pattern rather
 * than `lib/fns.call`. Confirmed against the Compose writers
 * `platformCreateKinTaleTemplate` / `platformUpdateKinTaleTemplate`
 * (FirestoreInterop.wasmJs.kt): create = `addDoc`, update = `setDoc` on the
 * existing id, both stamping a client-computed ISO `updatedAt` (never
 * `serverTimestamp()`), matching every other date field on these docs.
 *
 * DELIBERATE DIVERGENCE from Compose, the same one `api/kinTalesWrite.ts`
 * documents:
 *  - Compose serializes the WHOLE model, including `_id` (as `""` on create) and
 *    every default; the doc id is authoritative on read, so the body `_id` is
 *    redundant. We OMIT `_id` from the body (the id is the doc id) and write
 *    every OTHER model field explicitly.
 *  - Compose UPDATE is a full `setDoc` overwrite. We use `{ merge: true }` so a
 *    field a newer app added (that this build does not model) is preserved rather
 *    than silently erased. Because we write the COMPLETE current field set, the
 *    on-wire result is identical to a full overwrite for every field we DO model;
 *    merge only ever adds safety for fields we do not.
 *
 * Round-trip stays byte-compatible with Compose/android: the field names below
 * are exactly `KinTaleModels.kt`'s, and the nested `checklistItems` /
 * `moodOptions` / `conditions` shapes come straight off the piece-1 model types.
 */

/**
 * The complete editable field set of a template, minus `_id` (the doc id) and
 * the timestamps (stamped per-operation below). One place so create + update can
 * never drift in which fields they persist.
 */
function templateFields(t: KinTaleTemplate) {
  return {
    name: t.name,
    description: t.description,
    defaultEmailMessage: t.defaultEmailMessage,
    serviceTypeKeys: t.serviceTypeKeys,
    isActive: t.isActive,
    isDefault: t.isDefault,

    photoShowcaseEnabled: t.photoShowcaseEnabled,
    checklistEnabled: t.checklistEnabled,
    petMoodEnabled: t.petMoodEnabled,
    visitNotesEnabled: t.visitNotesEnabled,
    nextAppointmentEnabled: t.nextAppointmentEnabled,
    reviewBoosterEnabled: t.reviewBoosterEnabled,

    // Nested arrays of plain objects: Firestore stores them as arrays of maps,
    // and they decode back through `decodeKinTaleTemplate` byte-for-byte.
    checklistItems: t.checklistItems.map((i) => ({
      key: i.key,
      text: i.text,
      scope: i.scope,
      showWhenUnchecked: i.showWhenUnchecked,
      required: i.required,
      order: i.order,
      conditions: i.conditions.map((c) => ({
        source: c.source,
        op: c.op,
        value: c.value,
        attributeKey: c.attributeKey,
      })),
    })),
    moodOptions: t.moodOptions.map((m) => ({
      key: m.key,
      label: m.label,
      emoji: m.emoji,
      order: m.order,
    })),
  };
}

/**
 * The minimum a sibling template has to tell us for default exclusivity. The
 * editor already streams the whole collection, so it passes what it has rather
 * than making this module re-read a list it is holding.
 */
export interface TemplateDefaultFlag {
  _id: string;
  isDefault: boolean;
}

/**
 * Create (blank `_id`) or update (real `_id`) a `kintale_templates` doc, and
 * return the id. CREATE stamps `createdAt` + `updatedAt`; UPDATE restamps only
 * `updatedAt` (a merge write, so the stored `createdAt` is preserved untouched).
 * Both use a client-computed ISO string, mirroring the Compose `nowIsoUtc()`.
 *
 * `isDefault` IS EXCLUSIVE, and that is a deliberate divergence from Compose,
 * which let the flag pile up on any number of docs. `isDefault` is the GLOBAL
 * fallback the composer falls back to when no template's `serviceTypeKeys`
 * matches the visit's service: android's
 * `AuntieRepository.getActiveTemplateForService` ends in
 * `match ?: templates.firstOrNull { it.isDefault }`, and `pickInitialTemplate`
 * here does the same. With two flagged docs, which one wins is whatever order
 * the snapshot happened to arrive in. Exclusivity therefore has to be global
 * rather than per service scope; scoping it would preserve exactly the
 * ambiguity the flag exists to resolve.
 *
 * So a save that sets the flag goes through ONE `writeBatch`: this doc's write
 * plus an `isDefault: false` on every other flagged sibling, committed
 * together. No observer ever sees two defaults, or none. A save that does NOT
 * set the flag has no cross-document work to do and keeps the plain single-doc
 * path.
 *
 * Fail-loud: any Firestore rejection (permission-denied, offline, a batch that
 * aborts) propagates to the caller unchanged; nothing is swallowed, no
 * partial/fake success is reported.
 */
export async function saveKinTaleTemplate(
  template: KinTaleTemplate,
  siblings: readonly TemplateDefaultFlag[] = [],
): Promise<string> {
  const now = new Date().toISOString();
  const fields = templateFields(template);
  const isCreate = template._id.trim() === '';

  // Setting the default is a multi-document change; see the note on
  // `TemplateDefaultFlag` for why the flag has to be exclusive and why one
  // batch is the whole point.
  if (template.isDefault) {
    const batch = writeBatch(db);
    const coll = collection(db, 'kintale_templates');
    const ref = isCreate ? doc(coll) : doc(db, 'kintale_templates', template._id);

    if (isCreate) batch.set(ref, { ...fields, createdAt: now, updatedAt: now });
    else batch.set(ref, { ...fields, updatedAt: now }, { merge: true });

    const savedId = isCreate ? (ref as { id: string }).id : template._id;
    for (const other of siblings) {
      if (!other.isDefault) continue;
      if (other._id === savedId || other._id.trim() === '') continue;
      batch.update(doc(db, 'kintale_templates', other._id), { isDefault: false });
    }

    await commitBatch(batch, 'a KinTale template');
    return savedId;
  }

  if (isCreate) {
    const ref = await addDoc(collection(db, 'kintale_templates'), {
      ...fields,
      createdAt: now,
      updatedAt: now,
    });
    return ref.id;
  }

  await setDoc(doc(db, 'kintale_templates', template._id), { ...fields, updatedAt: now }, { merge: true });
  return template._id;
}
