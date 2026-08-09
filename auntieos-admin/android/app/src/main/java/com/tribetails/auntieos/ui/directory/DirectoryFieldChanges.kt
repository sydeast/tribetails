package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kinfolk

/**
 * What a household (`kinfolk`) or pet (`kin`) save is allowed to write: the
 * fields that ACTUALLY CHANGED since the record was read, and nothing else.
 *
 * WHY A DIFF AND NOT THE MODEL. Both saves used to hand Firestore a whole
 * `Kinfolk` / `Kin` under `SetOptions.merge()`. `merge()` protects fields
 * OUTSIDE the written map; it does nothing for stale fields INSIDE it. Every
 * field the phone read went back at the phone's value, so any edit made in
 * between - on the React admin, or by the kinfolk themselves in MyTribe - was
 * silently reverted. `HouseholdDataDiff.kt` fixed the same shape on
 * `household_data`; this is that rule for the two collections the React side
 * already names as the ones being clobbered.
 *
 * The React admin writes both collections field-level and says why:
 * `auntieos-admin/src/api/kinfolkProfileWrite.ts:17-60` cites
 * `AuntieRepository.kt`'s whole-model `.set()` by name, and calls out
 * `preferredContactMethod` / `bestTimeToContact` as fields a KINFOLK can edit
 * from the portal under `firestore.rules#onlyAllowedKinfolkFields`. Android
 * genuinely edits those two (`DirectoryViewModel.updateEditPreferredContactMethod`),
 * so they are diffed here rather than dropped: written when the operator
 * actually changes them, untouched otherwise, which is the closest an editor
 * can get to leaving a portal edit alone.
 *
 * THE SECOND BUG THIS CLOSES, and the worse of the two. The edit screens
 * rebuilt the model FROM SCRATCH out of form state
 * (`Kinfolk(id = ..., firstName = ...)`), so every model field the form did not
 * carry was written back at its KOTLIN DEFAULT, not at a stale value:
 *
 *   Kinfolk.uid              -> "", unlinking the household's MyTribe login
 *                               (`functions/src/admin/setKinfolkClaim.ts` writes it)
 *   Kinfolk.contactOverride  -> null, erasing the comms pipeline's time-boxed
 *                               "reach me by text this week" override
 *   Kinfolk.archived*        -> "", erasing the archive audit trail
 *   Kin.tags                 -> null, wiping the pet tag vocabulary assignment
 *   Kin.photos               -> [], wiping the migrated photo list
 *   Kin.ownerEmail / ownerPhone -> ""
 *   Kin.status               -> hardcoded "active", un-archiving an archived pet
 *
 * `Kin.tags` is the sharp one: the model comment on that field says it was ADDED
 * so that android saves would stop wiping React's tags. Declaring it was only
 * half the fix - the builder never populated it, so the wipe continued. Building
 * the edited model as `loaded.copy(...)` is what actually closes it, and the
 * diff then means an untouched field is not written at all.
 *
 * The lists are written out by hand rather than reflected, so they survive R8
 * and read as the contract they are. `DirectoryFieldChangesTest` reflects over
 * both models and fails if a list ever drifts, because a field missing from
 * here would simply stop saving - a quieter loss than the one being fixed.
 */

/**
 * Fields on `kinfolk` this client may write, keyed by Firestore field name.
 *
 * Absent ON PURPOSE, see [KINFOLK_SERVER_OWNED]: the document id, the stamp,
 * and the four fields written by something other than this editor.
 */
internal val KINFOLK_DIFF_FIELDS: Map<String, (Kinfolk) -> Any> = linkedMapOf(
    "firstName" to { it: Kinfolk -> it.firstName },
    "lastName" to { it: Kinfolk -> it.lastName },
    "phoneNumber" to { it: Kinfolk -> it.phoneNumber },
    "email" to { it: Kinfolk -> it.email },
    "profilePictureUrl" to { it: Kinfolk -> it.profilePictureUrl },
    "status" to { it: Kinfolk -> it.status },
    "outstandingBalance" to { it: Kinfolk -> it.outstandingBalance },
    // Read and written as NAMES, never as the raw stored value. A legacy doc
    // holds no `tags` key at all and decodes to null; the editor turns that into
    // an empty list. Comparing the decoded names keeps "this household has never
    // had tags" from diffing as a change and writing an empty array over it.
    "tags" to { it: Kinfolk -> it.tagNames() },
    "secondaryPhone" to { it: Kinfolk -> it.secondaryPhone },
    "secondaryEmail" to { it: Kinfolk -> it.secondaryEmail },
    // Portal-writable (see the file header). Diffed, so an untouched form leaves
    // whatever the kinfolk set for themselves alone.
    "preferredContactMethod" to { it: Kinfolk -> it.preferredContactMethod },
    "bestTimeToContact" to { it: Kinfolk -> it.bestTimeToContact },
    "serviceAddress" to { it: Kinfolk -> it.serviceAddress },
    "gateCode" to { it: Kinfolk -> it.gateCode },
    "parkingInstructions" to { it: Kinfolk -> it.parkingInstructions },
    "entryNotes" to { it: Kinfolk -> it.entryNotes },
    "wifiName" to { it: Kinfolk -> it.wifiName },
    "wifiPassword" to { it: Kinfolk -> it.wifiPassword },
    "emergencyContactName" to { it: Kinfolk -> it.emergencyContactName },
    "emergencyContactPhone" to { it: Kinfolk -> it.emergencyContactPhone },
    "emergencyContactRelation" to { it: Kinfolk -> it.emergencyContactRelation },
    "internalNotes" to { it: Kinfolk -> it.internalNotes },
    "referralSource" to { it: Kinfolk -> it.referralSource },
    "joinDate" to { it: Kinfolk -> it.joinDate },
    "formValues" to { it: Kinfolk -> it.formValues },
)

/**
 * `kinfolk` fields this client must never write, and who owns each instead.
 * Named here rather than merely omitted so the drift guard can tell "deliberately
 * left to its owner" from "forgotten".
 *
 * - `id`             the document id (`@DocumentId`, never serialised anyway)
 * - `updatedAt`      stamped at write time by the repository, never round-tripped
 * - `uid`            the MyTribe portal auth linkage, `admin/setKinfolkClaim.ts`
 * - `contactOverride` the comms reconcile pipeline's time-boxed channel override
 * - `archivedAt` / `archivedReason` / `archivedBy`
 *                    the archive audit trail, `AuntieRepository.archiveKinfolk`
 */
internal val KINFOLK_SERVER_OWNED = setOf(
    "id", "updatedAt", "uid", "contactOverride",
    "archivedAt", "archivedReason", "archivedBy",
)

/** Fields on `kin` this client may write, keyed by Firestore field name. */
internal val KIN_DIFF_FIELDS: Map<String, (Kin) -> Any> = linkedMapOf(
    "kinfolkId" to { it: Kin -> it.kinfolkId },
    "name" to { it: Kin -> it.name },
    "species" to { it: Kin -> it.species },
    "breed" to { it: Kin -> it.breed },
    "age" to { it: Kin -> it.age },
    "sex" to { it: Kin -> it.sex },
    "weight" to { it: Kin -> it.weight },
    // No editor renders the photo list, and that is precisely why it is diffed:
    // unrendered means unchanged, so it is carried and never written.
    "photos" to { it: Kin -> it.photos },
    // Owned by the archive flow, not by this form. Diffed rather than dropped so
    // a future status control saves, and so today's form - which does not touch
    // it - cannot resurrect an archived pet the way the old hardcoded
    // `status = "active"` did.
    "status" to { it: Kin -> it.status },
    "profilePictureUrl" to { it: Kin -> it.profilePictureUrl },
    "colorMarkings" to { it: Kin -> it.colorMarkings },
    "spayedNeutered" to { it: Kin -> it.spayedNeutered },
    "staysAs" to { it: Kin -> it.staysAs },
    "routine" to { it: Kin -> it.routine },
    "trainingCommands" to { it: Kin -> it.trainingCommands },
    "feedingBrand" to { it: Kin -> it.feedingBrand },
    "vaccinations" to { it: Kin -> it.vaccinations },
    "medicationHealthNotes" to { it: Kin -> it.medicationHealthNotes },
    // Read-only on the pet since the vet moved to `household_data` (ruling
    // 2026-08-01). Still diffed so the legacy value survives until migration.
    "vetInfo" to { it: Kin -> it.vetInfo },
    "checklist" to { it: Kin -> it.checklist },
    "reactive" to { it: Kin -> it.reactive },
    "ownerEmail" to { it: Kin -> it.ownerEmail },
    "ownerPhone" to { it: Kin -> it.ownerPhone },
    "officeNotes" to { it: Kin -> it.officeNotes },
    "formValues" to { it: Kin -> it.formValues },
    // Names, not the raw value: same reason as `Kinfolk.tags` above.
    "tags" to { it: Kin -> it.tagNames() },
)

/**
 * `kin` fields this client must never write.
 *
 * - `id`             the document id (`@DocumentId`)
 * - `updatedAt`      stamped at write time by the repository
 * - `familyKinPath`  the MyTribe mirror FK, owned by
 *                    `AuntieRepository.stampFamilyKinPath`, which re-derives it
 *                    from the kin and kinfolk ids on every write
 */
internal val KIN_SERVER_OWNED = setOf("id", "updatedAt", "familyKinPath")

/**
 * The fields [edited] changes relative to [loaded], keyed by Firestore field
 * name. Empty when nothing changed, which the caller must treat as "do not
 * write" rather than "write the stamp".
 *
 * [loaded] must be the copy Firestore handed us, never a re-read: re-reading to
 * diff would hand back exactly the concurrent edit this is protecting.
 *
 * A field cleared to blank IS a change and is written as `""`. Skipping blanks
 * would make "delete this note" the one edit the screen cannot perform.
 */
internal fun kinfolkFieldChanges(loaded: Kinfolk, edited: Kinfolk): Map<String, Any> =
    changesBetween(KINFOLK_DIFF_FIELDS, loaded, edited)

/** The `kin` half of [kinfolkFieldChanges]; same rules. */
internal fun kinFieldChanges(loaded: Kin, edited: Kin): Map<String, Any> =
    changesBetween(KIN_DIFF_FIELDS, loaded, edited)

private fun <T> changesBetween(
    fields: Map<String, (T) -> Any>,
    loaded: T,
    edited: T,
): Map<String, Any> {
    val changes = LinkedHashMap<String, Any>()
    for ((field, read) in fields) {
        val next = read(edited)
        if (next != read(loaded)) changes[field] = next
    }
    return changes
}
