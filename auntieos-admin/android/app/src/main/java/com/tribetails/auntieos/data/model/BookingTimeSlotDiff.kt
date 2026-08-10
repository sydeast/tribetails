package com.tribetails.auntieos.data.model

/**
 * What a `booking_time_slots/{id}` save is allowed to write: the fields that
 * ACTUALLY CHANGED since the document was read, and nothing else.
 *
 * `BookingRepository.updateTimeSlot` used to write the whole [BookingTimeSlot]
 * with a BARE `.set()` - no merge option, which REPLACES the document: every
 * field not on this Kotlin model was DELETED. That is a step worse than the
 * `.set(model, merge())` shape PRs #312, #315, #327 and #332 removed elsewhere,
 * where an unmodelled field at least survived, and it is the same shape #342
 * removed from `kintale_templates` - a collection that has already PAID for it
 * twice (see [KinTaleTemplateDiff]).
 *
 * TWO SERVER WRITERS SHARE THESE DOCUMENTS:
 *
 *  - `mytribe/functions/src/admin/createBlockedTimeSlot.ts` writes the admin
 *    "Block time" window, and puts [BOOKING_TIME_SLOT_SIBLING_WRITTEN]'s
 *    `createdBy` and `updatedAt` on it. Neither is declared here, so a bare set
 *    deleted both.
 *  - `mytribe/functions/src/admin/syncGoogleCalendarBusyEvents.ts` upserts every
 *    Google Calendar busy interval with `{ merge: true }`, so it preserves
 *    whatever it does not name. That is the shape this file adopts.
 *
 * WHAT THE BARE SET COSTS TODAY IS NOTHING, AND SAYING SO IS PART OF THE FIX.
 * `mytribe/firestore.rules:798` reads
 * `match /booking_time_slots/{id} { allow read: if isAuntie(); allow write: if false; }`
 * - every CLIENT write to this collection is denied, in both the deployed rules
 * files, on the single project `auntieos-ttpc`. The bare set could not reach the
 * server, so `createdBy` has never actually been erased in production. The write
 * shape was dangerous; the damage was latent, exactly as on
 * `coverage_package_config` (see [CoveragePackageConfigDiff]). One line of rules
 * and one deploy is all that stands between the old shape and a silent erasure,
 * and a security rule is the wrong place for a data-integrity guarantee to live.
 *
 * WHAT A FIELD-LEVEL DIFF CANNOT DO, stated so nobody reads more into it. Two
 * operators editing the same blocked window still resolve last-write-wins on any
 * field they both touch. What it removes is the case where they touch DIFFERENT
 * fields and one still loses.
 */

/**
 * Fields on `booking_time_slots/{id}` this client may write, keyed by Firestore
 * field name.
 *
 * Written out by hand rather than reflected, so it survives R8 and reads as the
 * contract it is.
 *
 * `syncState` IS here, and the inclusion is deliberate: `OVERRIDDEN` and
 * `DISMISSED` are admin decisions about an imported busy block, so this client
 * is a legitimate author of the field. It is in the differ precisely so such a
 * decision reaches the server as its own one-field change rather than riding
 * inside a whole-model replace. The three `external*`/`source` fields around it
 * are NOT, for the opposite reason - see [BOOKING_TIME_SLOT_SERVER_OWNED].
 */
internal val BOOKING_TIME_SLOT_DIFF_FIELDS: Map<String, (BookingTimeSlot) -> Any?> =
    linkedMapOf(
        "date" to { it.date },
        "startTime" to { it.startTime },
        "endTime" to { it.endTime },
        "isAvailable" to { it.isAvailable },
        "slotType" to { it.slotType },
        "notes" to { it.notes },
        "hideDetailsFromKinfolk" to { it.hideDetailsFromKinfolk },
        "isEditableByAdmin" to { it.isEditableByAdmin },
        "isRemovableByAdmin" to { it.isRemovableByAdmin },
        "syncState" to { it.syncState },
    )

/**
 * `booking_time_slots/{id}` fields on this model that a save must never
 * round-trip, and who owns each.
 *
 * - `id`                  the document id (`@DocumentId`, never serialised anyway)
 * - `createdAt`           stamped once at create by whichever writer created the
 *                         slot; round-tripping it is how it gets lost
 * - `source`              the writer's identity, `INTERNAL_MANUAL` or
 *                         `GOOGLE_BUSY_IMPORT`. `mytribe/functions/src/lib/
 *                         bookingBusyConflict.ts` will only refuse a booking for
 *                         a slot whose `source` is `GOOGLE_BUSY_IMPORT`, so a
 *                         client that rewrote this field would silently drop the
 *                         window out of the server-side conflict guard.
 * - `externalEventId`     the Google importer's DEDUP KEY.
 *                         `syncGoogleCalendarBusyEvents` finds the slot to update
 *                         with `where('externalEventId','==',…).limit(1)`; lose
 *                         it and the next sync CREATES A DUPLICATE busy block
 *                         instead of updating this one.
 * - `externalCalendarId`  the calendar that interval came from, same provenance.
 *
 * The `external*` pair is nullable on this model and null on every
 * manually-blocked slot, which is exactly why it must be named here rather than
 * merely omitted: a phone that loaded an imported slot and re-saved it would
 * otherwise have had a perfectly ordinary-looking `null` to write over the key.
 */
internal val BOOKING_TIME_SLOT_SERVER_OWNED = setOf(
    "id",
    "createdAt",
    "source",
    "externalEventId",
    "externalCalendarId",
)

/**
 * Fields another writer puts on `booking_time_slots/{id}` that [BookingTimeSlot]
 * does not declare, and must not start declaring.
 *
 * - `createdBy`  the uid of the admin who blocked the window, written by
 *                `createBlockedTimeSlot.ts`. It is the only copy of that
 *                provenance on the document itself: the callable also writes an
 *                audit entry, but that is a different collection and is not
 *                client-readable, so an erasure here is not recoverable from any
 *                surface a person can open. Nothing READS the field today, which
 *                is why the loss would have been silent rather than loud.
 * - `updatedAt`  written by `createBlockedTimeSlot.ts`, and stamped fresh by
 *                [BookingRepository.updateTimeSlotFields] as a literal payload
 *                key. Deliberately NOT modelled: a field this client cannot read
 *                is a field it cannot round-trip a stale copy of.
 *
 * Declaring either would be the wrong fix, the same way declaring `deleted`
 * would have been on `kintale_templates`. This app has no author for `createdBy`
 * - it never blocks a window server-side - so it could only ever write its own
 * empty string over the server's uid, which is the erasure spelled out in the
 * payload instead of implied by omission. Only a write that cannot NAME a field
 * can be trusted not to change it, and only merge preserves a field the client
 * cannot name. `BookingTimeSlotDiffTest` and `BookingTimeSlotMergeTest` pin both
 * halves.
 */
internal val BOOKING_TIME_SLOT_SIBLING_WRITTEN = setOf("createdBy", "updatedAt")

/**
 * The fields [edited] changes relative to [loaded], keyed by Firestore field
 * name. Empty when nothing changed, which the caller must treat as "do not
 * write" rather than "write the stamp".
 *
 * [loaded] must be the copy Firestore handed us, never a re-read: re-reading to
 * diff would hand back exactly the concurrent edit this is protecting. It must
 * also be a REAL loaded document rather than a freshly-constructed
 * [BookingTimeSlot] - against a default-constructed baseline every field differs
 * and the diff degrades back into the whole-model write it replaces.
 *
 * A note cleared to blank IS a change and is written as blank. Skipping it would
 * make "remove the reason on this blocked window" the one edit no screen can
 * perform.
 */
internal fun bookingTimeSlotFieldChanges(
    loaded: BookingTimeSlot,
    edited: BookingTimeSlot,
): Map<String, Any?> {
    val changes = LinkedHashMap<String, Any?>()
    for ((field, read) in BOOKING_TIME_SLOT_DIFF_FIELDS) {
        if (read(edited) != read(loaded)) changes[field] = read(edited)
    }
    return changes
}
