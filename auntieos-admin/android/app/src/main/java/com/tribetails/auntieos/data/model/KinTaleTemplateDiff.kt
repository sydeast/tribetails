package com.tribetails.auntieos.data.model

/**
 * What a `kintale_templates/{id}` save is allowed to write: the fields that
 * ACTUALLY CHANGED since the document was read, and nothing else.
 *
 * `updateKinTaleTemplate` used to write the whole [KinTaleTemplate] with a BARE
 * `.set()`, no merge option, which REPLACES the document: every field not on
 * this Kotlin model was DELETED. That is a step worse than the
 * `.set(model, merge())` shape PRs #312, #315, #327 and #332 removed elsewhere,
 * where an unmodelled field at least survived.
 *
 * THIS COLLECTION HAS ALREADY PAID FOR IT. [ChecklistItem.required] carries the
 * note: React and the Compose commonMain model both declared `required` while
 * the Android model did not, so for as long as that was true every android edit
 * of a template STRIPPED `required` from every item on it. That is not a
 * hypothetical - it is the recorded history of this exact write.
 *
 * THREE OTHER WRITERS SHARE THESE DOCUMENTS, and they all patch:
 *
 *  - `auntieos-admin/src/api/kinTaleTemplatesWrite.ts` (React admin) writes the
 *    complete editable field set with `{ merge: true }`, and says why in its own
 *    comment: "Compose UPDATE is a full `setDoc` overwrite. We use
 *    `{ merge: true }` so a field a newer app added (that this build does not
 *    model) is preserved rather than silently erased."
 *  - the same module's default-exclusivity batch demotes siblings with a
 *    single-field `batch.update(ref, { isDefault: false })`.
 *  - the desktop admin's `platformDeleteKinTaleTemplate`
 *    (`auntieos-admin/web/composeApp/src/jvmMain/.../FirestoreInterop.jvm.kt`)
 *    patches [KINTALE_TEMPLATE_SIBLING_WRITTEN]'s `deleted` flag.
 *
 * And `mytribe/functions/src/portal/getMyKinTales.ts` READS these documents
 * server-side: `parseTemplateChecklistItems` resolves the `key`/`text`/`order`
 * of every checklist row a kinfolk sees on their visit recap, and DROPS a
 * checked key it cannot find in the template. So a stale `checklistItems`
 * written back from a phone does not merely look wrong in the editor - it makes
 * a row the Auntie really ticked vanish from the family's KinTale.
 *
 * WHAT THAT COST A PERSON, in plain terms. An operator renames a checklist item
 * on the web, then toggles a section on their phone. The phone wrote back the
 * whole template it had loaded, so the rename was reverted, and every visit
 * recap that had already recorded the new key stopped resolving a label for it -
 * the row simply disappeared from the recap. Separately, a template a desktop
 * operator had deleted came back: the soft-delete flag is not on this model, and
 * a bare set cannot preserve what it cannot name.
 */

/**
 * Fields on `kintale_templates/{id}` this client may write, keyed by Firestore
 * field name.
 *
 * Written out by hand rather than reflected, so it survives R8 and reads as the
 * contract it is.
 *
 * `reviewBoosterConfig` IS here, and the asymmetry is deliberate: this model
 * declares it and neither the React model nor Compose commonMain does. React
 * writes under merge, so its saves preserve the field rather than deleting it,
 * and the android editor is its only author. Dropping it from the diff would
 * make the review-booster editor silently stop saving, which is the quiet
 * failure this whole class of fix exists to remove.
 */
internal val KINTALE_TEMPLATE_DIFF_FIELDS: Map<String, (KinTaleTemplate) -> Any?> =
    linkedMapOf(
        "name" to { it.name },
        "description" to { it.description },
        "defaultEmailMessage" to { it.defaultEmailMessage },
        "serviceTypeKeys" to { it.serviceTypeKeys },
        "isActive" to { it.isActive },
        "isDefault" to { it.isDefault },
        "photoShowcaseEnabled" to { it.photoShowcaseEnabled },
        "checklistEnabled" to { it.checklistEnabled },
        "petMoodEnabled" to { it.petMoodEnabled },
        "visitNotesEnabled" to { it.visitNotesEnabled },
        "nextAppointmentEnabled" to { it.nextAppointmentEnabled },
        "reviewBoosterEnabled" to { it.reviewBoosterEnabled },
        "checklistItems" to { it.checklistItems },
        "moodOptions" to { it.moodOptions },
        "reviewBoosterConfig" to { it.reviewBoosterConfig },
    )

/**
 * `kintale_templates/{id}` fields on this model that a save must never
 * round-trip.
 *
 * - `id`         the document id (`@DocumentId`, never serialised anyway)
 * - `createdAt`  stamped once at create; round-tripping it is how it gets lost
 * - `updatedAt`  stamped at write time by the repository, never round-tripped
 */
internal val KINTALE_TEMPLATE_SERVER_OWNED = setOf("id", "createdAt", "updatedAt")

/**
 * Fields another writer puts on `kintale_templates/{id}` that [KinTaleTemplate]
 * does not declare, and must not start declaring.
 *
 * - `deleted`  the desktop admin's SOFT DELETE.
 *   `platformDeleteKinTaleTemplate` (FirestoreInterop.jvm.kt) patches
 *   `deleted: true` rather than removing the document, so the template stays
 *   readable and recoverable. Android's editor does not filter on it, so a
 *   desktop-deleted template is still listed on the phone - and one edit there
 *   used to erase the flag outright, resurrecting the template for every
 *   surface that does honour it.
 *
 * Declaring `deleted` would be the wrong fix. This editor has no delete-state
 * concept and no screen that sets it, so it could only ever write `false` -
 * which is precisely the resurrection, now spelled out in the payload instead of
 * implied by omission. Only a write that cannot NAME the field can be trusted
 * not to change it, and only merge preserves a field the client cannot name.
 * `KinTaleTemplateMergeTest` pins both halves.
 */
internal val KINTALE_TEMPLATE_SIBLING_WRITTEN = setOf("deleted")

/**
 * The fields [edited] changes relative to [loaded], keyed by Firestore field
 * name. Empty when nothing changed, which the caller must treat as "do not
 * write" rather than "write the stamp".
 *
 * [loaded] must be the copy Firestore handed us, never a re-read: re-reading to
 * diff would hand back exactly the concurrent edit this is protecting.
 *
 * A field cleared to blank IS a change and is written as blank. Skipping it
 * would make "remove this template's description" the one edit no screen can
 * perform.
 *
 * `checklistItems` and `moodOptions` are compared and written WHOLE. Data-class
 * equality makes the comparison exact, and Firestore replaces an array field
 * wholesale under merge anyway, so there is no per-row patch to be had here -
 * only the guarantee that an untouched list is never sent at all.
 */
internal fun kinTaleTemplateFieldChanges(
    loaded: KinTaleTemplate,
    edited: KinTaleTemplate,
): Map<String, Any?> {
    val changes = LinkedHashMap<String, Any?>()
    for ((field, read) in KINTALE_TEMPLATE_DIFF_FIELDS) {
        if (read(edited) != read(loaded)) changes[field] = read(edited)
    }
    return changes
}
