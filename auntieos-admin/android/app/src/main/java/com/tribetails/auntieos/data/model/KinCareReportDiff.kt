package com.tribetails.auntieos.data.model

/**
 * What a KinTale save is allowed to write: the fields the operator ACTUALLY
 * CHANGED since the document was read, and nothing else.
 *
 * WHY A DIFF AND NOT THE MODEL. `updateKinCareReport` used to hand Firestore the
 * whole [KinCareReport] under `SetOptions.merge()`. `merge()` protects fields
 * OUTSIDE the written map; it does nothing about stale fields INSIDE it. So every
 * persist wrote back all 30 modelled fields at the value this client last loaded.
 * That is the shape PR #312 removed from `household_data`, #315 from `kinfolk` and
 * `kin`, #327 from `business_settings` and #332 from `coverage_package_config`;
 * #332 named this site as the last whole-model android write a live screen still
 * issues, and pointed at the two call sites in `KinTaleReportViewModel`.
 *
 * THIS DOCUMENT IS THE WORST OF THE SIX TO GET WRONG, because the casualty is
 * written work rather than configuration. `kin_care_reports` has FOUR writers, and
 * three of them are not this screen:
 *
 *   this editor              title, bodyCopy, fieldResponses, petMoodSelections,
 *                            mediaFileIds, formValues
 *   markReportSent           status, sentAt, sentVia, deliveryReceiptId
 *   triageOrphanReport       kinfolkId, kinfolkName, triageStatus, triagedAt,
 *   (server callable)        triagedBy, duplicateOfReportId, archiveReason
 *   the repository           id, authorId, authorDisplayName, createdAt, updatedAt
 *
 * A draft open on a phone therefore held a stale copy of every field the other
 * three own, and handed all of them back on the next blur. The concrete loss: an
 * admin triages an orphan KinTale in KinTale Logs while a draft of it is open in
 * the editor, and the next blur reverts `triageStatus` to blank and `kinfolkId` to
 * the empty string the orphan carried - putting the report back in the Needs
 * Triage bucket with the triage decision erased.
 *
 * THE THREE SETS BELOW PARTITION THE MODEL, and the partition is the fix. Only
 * [KIN_CARE_REPORT_DIFF_FIELDS] can ever reach the wire from this client's draft
 * saves. A field in [KIN_CARE_REPORT_OTHER_WRITERS] cannot be written here even if
 * this client's copy of it differs, because "differs" on those fields means
 * SOMEONE ELSE CHANGED IT and our copy is the stale one. That is a stronger
 * guarantee than diffing alone: diffing would happily write `status = DRAFT` back
 * over a `SENT` this client had not yet seen.
 *
 * WHAT A FIELD-LEVEL DIFF CANNOT DO, said so nobody reads more into it. Two
 * operators typing into the SAME KinTale's body at once still resolve
 * last-write-wins: `bodyCopy` is one string and both sides write it whole. Nothing
 * here merges prose. What it does close is the cross-field case, which is the one
 * that was actually happening: editing the body must not revert the photos, the
 * mood picks, the send state, or the triage decision.
 */

/**
 * Fields on `kin_care_reports/{id}` a KinTale draft save may write, keyed by
 * Firestore field name.
 *
 * These six are exactly what the editor screen puts a control on. Written out by
 * hand rather than reflected, so it survives R8 and reads as the contract it is;
 * `KinCareReportDiffTest` reflects over the model and fails the build if the model
 * gains a field none of the three sets names.
 */
internal val KIN_CARE_REPORT_DIFF_FIELDS: Map<String, (KinCareReport) -> Any?> =
    linkedMapOf(
        "title" to { it.title },
        "bodyCopy" to { it.bodyCopy },
        "fieldResponses" to { it.fieldResponses },
        "petMoodSelections" to { it.petMoodSelections },
        "mediaFileIds" to { it.mediaFileIds },
        "formValues" to { it.formValues },
    )

/**
 * Fields the repository stamps, which must never be round-tripped from a value
 * this client read.
 *
 * - `id`                 the document id (`@DocumentId`, never serialised anyway)
 * - `authorId`           stamped from `auth.currentUser` at create
 * - `authorDisplayName`  same
 * - `createdAt`          stamped at create, immutable thereafter
 * - `updatedAt`          stamped at write time, never round-tripped
 *
 * Sending the `updatedAt` we read is the specific way a stamp starts lying about
 * when the document last changed.
 */
internal val KIN_CARE_REPORT_SERVER_OWNED = setOf(
    "id",
    "authorId",
    "authorDisplayName",
    "createdAt",
    "updatedAt",
)

/**
 * Fields on this document that belong to a DIFFERENT writer, listed with the
 * writer that owns each. Named rather than merely omitted, so "someone else's" is
 * distinguishable from "forgotten" - and so the drift guard can tell them apart.
 *
 * Send lifecycle, written by `KinCareRepository.markReportSent` as a named-field
 * `update()`:
 *   `status`, `sentAt`, `sentVia`, `deliveryReceiptId`
 *
 * Orphan triage, written server-side by the `triageOrphanReport` callable, which
 * re-validates the admin claim and binds the audit entry to the mutation:
 *   `kinfolkId`, `kinfolkName`, `triageStatus`, `triagedAt`, `triagedBy`,
 *   `duplicateOfReportId`, `archiveReason`
 *
 * Session prefill, copied onto the report once at create so the KinTale is
 * self-contained, and never legitimately re-derived by an edit:
 *   `sessionId`, `kinIds`, `serviceType`, `visitDate`, `arrivedAt`, `departedAt`,
 *   `visitRouteId`, `templateId`
 *
 * `arrivedAt` and `departedAt` are worth one extra line: both are `String?`
 * declared with a `""` default, so a document that stored null decodes to null
 * while a freshly scaffolded report carries `""`. Under the old whole-model write
 * that difference shipped on every save. Off the diff entirely, it cannot.
 */
internal val KIN_CARE_REPORT_OTHER_WRITERS = setOf(
    // markReportSent
    "status", "sentAt", "sentVia", "deliveryReceiptId",
    // triageOrphanReport (server callable)
    "kinfolkId", "kinfolkName", "triageStatus", "triagedAt", "triagedBy",
    "duplicateOfReportId", "archiveReason",
    // session prefill, write-once at create
    "sessionId", "kinIds", "serviceType", "visitDate", "arrivedAt", "departedAt",
    "visitRouteId", "templateId",
)

/**
 * The fields [edited] changes relative to [loaded], keyed by Firestore field name.
 * Empty when nothing changed, which the caller must treat as "do not write" rather
 * than "write the stamp".
 *
 * [loaded] must be the copy Firestore handed us, never a re-read: re-reading to
 * diff would hand back exactly the concurrent edit this is protecting.
 *
 * A field cleared to blank or emptied IS a change and is written as blank/empty.
 * Skipping it would make "delete the headline I wrote" the one edit no screen can
 * perform.
 */
internal fun kinCareReportFieldChanges(
    loaded: KinCareReport,
    edited: KinCareReport,
): Map<String, Any?> {
    val changes = LinkedHashMap<String, Any?>()
    for ((field, read) in KIN_CARE_REPORT_DIFF_FIELDS) {
        if (read(edited) != read(loaded)) changes[field] = read(edited)
    }
    return changes
}
