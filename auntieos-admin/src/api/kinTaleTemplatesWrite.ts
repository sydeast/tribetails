import { addDoc, collection, doc, setDoc } from 'firebase/firestore';
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
 * Create (blank `_id`) or update (real `_id`) a `kintale_templates` doc, and
 * return the id. CREATE stamps `createdAt` + `updatedAt`; UPDATE restamps only
 * `updatedAt` (a merge write, so the stored `createdAt` is preserved untouched).
 * Both use a client-computed ISO string, mirroring the Compose `nowIsoUtc()`.
 *
 * Fail-loud: any Firestore rejection (permission-denied, offline) propagates to
 * the caller unchanged; nothing is swallowed, no partial/fake success is
 * reported.
 */
export async function saveKinTaleTemplate(template: KinTaleTemplate): Promise<string> {
  const now = new Date().toISOString();
  const fields = templateFields(template);

  if (template._id.trim() === '') {
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
