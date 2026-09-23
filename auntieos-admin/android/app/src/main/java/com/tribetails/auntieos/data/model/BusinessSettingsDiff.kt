package com.tribetails.auntieos.data.model

/**
 * What a settings save is allowed to write: the fields that ACTUALLY CHANGED
 * since the document was read, and nothing else.
 *
 * WHY A DIFF AND NOT THE MODEL. Every settings save used to hand Firestore the
 * whole [BusinessSettings] under `SetOptions.merge()`. `merge()` protects fields
 * OUTSIDE the written map; it does nothing about stale fields INSIDE it. All ~46
 * writable fields of this union are inside it, so a screen that loaded the doc an
 * hour ago wrote every one of them back at the value it read, reverting whatever
 * changed since. `AuntieRepository.saveBusinessSettings` said so in its own
 * comment and left the fix for its own change; this is that change.
 *
 * IT IS ONE DOCUMENT WITH MANY EDITORS, which is what makes it the worst case of
 * the three collections already converted (`household_data` in PR #312,
 * `kinfolk` + `kin` in PR #315):
 *
 *  - The React admin writes it as a PER-SECTION PARTIAL PATCH and says why:
 *    `auntieos-admin/src/api/settingsWrite.ts` sends `{ ...patch, updatedAt,
 *    updatedBy }` under `merge: true` precisely so "a caller that touches one
 *    section's fields can never clobber a sibling section's data".
 *  - Four android editors in three packages each own a different slice: the
 *    Settings panels (GPS, payments, weather, booking behavior, time off, tags,
 *    branding), Service Management, Enhanced Scheduling (booking mode + the
 *    Google Calendar id), and the inline tag promotion on a profile.
 *
 * So the phone reverting the web is not hypothetical here: `calendarSyncId`, the
 * venmo/paypal/cashapp handles and the two tag vocabularies all sit on this doc
 * and are all editable from both sides.
 *
 * NOT ON THIS MODEL, and staying off it: the four calendar-sync receipt fields
 * (`calendarSyncLastRunAt` and siblings). `CalendarSyncId.kt` keeps
 * [com.tribetails.auntieos.ui.admin.scheduling.CalendarSyncRun] off
 * [BusinessSettings] and `AuntieRepository.getCalendarSyncRun` reads them off the
 * raw snapshot. The diff makes that arrangement safer rather than obsolete: the
 * server is still their only writer, and now no android write can name a field
 * this list does not, so the receipt is unreachable from here by construction.
 *
 * The list is written out by hand rather than reflected, so it survives R8 and
 * reads as the contract it is. `BusinessSettingsDiffTest` reflects over the model
 * and fails if the two ever drift, because a field missing from here would simply
 * stop saving - a quieter loss than the one being fixed.
 */

/**
 * One diffable field: the value to WRITE, and the value to COMPARE on.
 *
 * They are usually the same lambda. They differ where the stored shape and the
 * meaningful value are not the same thing - see `householdTags` below, which
 * compares decoded and writes raw.
 */
internal class SettingsDiffField(
    val write: (BusinessSettings) -> Any?,
    val compare: (BusinessSettings) -> Any? = write,
)

/**
 * Fields on `business_settings/business_settings` this client may write, keyed by
 * Firestore field name.
 *
 * Absent ON PURPOSE, see [BUSINESS_SETTINGS_SERVER_OWNED]: the document id and
 * the two stamp fields. Named there rather than merely omitted so the drift guard
 * can tell "deliberately not ours" from "forgotten".
 */
internal val BUSINESS_SETTINGS_DIFF_FIELDS: Map<String, SettingsDiffField> = linkedMapOf(
    // --- Business profile ---
    "businessName" to SettingsDiffField({ it.businessName }),
    "businessEmail" to SettingsDiffField({ it.businessEmail }),
    "businessPhone" to SettingsDiffField({ it.businessPhone }),
    "businessAddress" to SettingsDiffField({ it.businessAddress }),
    "timeZone" to SettingsDiffField({ it.timeZone }),
    "serviceRates" to SettingsDiffField({ it.serviceRates }),
    "serviceDurations" to SettingsDiffField({ it.serviceDurations }),
    "businessHours" to SettingsDiffField({ it.businessHours }),
    // --- GPS / tracking ---
    "enableGPSTrackingForAllVisits" to SettingsDiffField({ it.enableGPSTrackingForAllVisits }),
    "enablePhotoLocationTagging" to SettingsDiffField({ it.enablePhotoLocationTagging }),
    "requireArrivalDepartureVerification" to SettingsDiffField({ it.requireArrivalDepartureVerification }),
    "arrivalRadiusMeters" to SettingsDiffField({ it.arrivalRadiusMeters }),
    "autoStartTrackingOnVisitStart" to SettingsDiffField({ it.autoStartTrackingOnVisitStart }),
    // Written as the enum NAME, which is byte-for-byte what the whole-object
    // write produced (Firestore serialises an enum to `name()`). Spelling it out
    // keeps the wire value a property of this file rather than of the mapper.
    "trackingAccuracy" to SettingsDiffField({ it.trackingAccuracy.name }),
    "saveRoutesForDays" to SettingsDiffField({ it.saveRoutesForDays }),
    "allowClientLocationSharing" to SettingsDiffField({ it.allowClientLocationSharing }),
    // --- "On My Way" defaults ---
    "defaultEtaMinutes" to SettingsDiffField({ it.defaultEtaMinutes }),
    "etaMinuteOptions" to SettingsDiffField({ it.etaMinuteOptions }),
    // --- KinTale draft retention ---
    "draftRetentionDays" to SettingsDiffField({ it.draftRetentionDays }),
    "draftRetentionOptions" to SettingsDiffField({ it.draftRetentionOptions }),
    // --- Time off ---
    "observedUsHolidays" to SettingsDiffField({ it.observedUsHolidays }),
    "companyHolidays" to SettingsDiffField({ it.companyHolidays }),
    "specialHours" to SettingsDiffField({ it.specialHours }),
    "observeUsHolidays" to SettingsDiffField({ it.observeUsHolidays }),
    // --- Booking / scheduling config ---
    "defaultBookingMode" to SettingsDiffField({ it.defaultBookingMode }),
    "defaultCalendarView" to SettingsDiffField({ it.defaultCalendarView }),
    "allowTimeBlockBooking" to SettingsDiffField({ it.allowTimeBlockBooking }),
    "allowSpecificTimeBooking" to SettingsDiffField({ it.allowSpecificTimeBooking }),
    "enableConflictDetection" to SettingsDiffField({ it.enableConflictDetection }),
    "enableAutoReminder24h" to SettingsDiffField({ it.enableAutoReminder24h }),
    "defaultTimeBlockDurationHours" to SettingsDiffField({ it.defaultTimeBlockDurationHours }),
    "travelBufferMinutes" to SettingsDiffField({ it.travelBufferMinutes }),
    "timeBlocks" to SettingsDiffField({ it.timeBlocks }),
    // The id the server-side sync resolves before it falls back to the operator
    // secret. Written by ONE android screen (Scheduling Options) and by the React
    // Calendar section; the two used to overwrite each other on any save.
    "calendarSyncId" to SettingsDiffField({ it.calendarSyncId }),
    // --- Booking behavior ---
    "autoConfirmRepeatKinfolk" to SettingsDiffField({ it.autoConfirmRepeatKinfolk }),
    "snapRescheduleTo15Min" to SettingsDiffField({ it.snapRescheduleTo15Min }),
    // --- Notification schedule ---
    // The two hours are the only NULLABLE fields on this map, and null has to
    // survive the diff rather than be dropped by it: null is how the operator
    // unschedules a job, so a change from 9 to null is a real edit that must be
    // written. `businessSettingsFieldChanges` compares with `!=`, which is boxed
    // Integer equality and gets 9-to-null right, and writes the raw value, which
    // puts an explicit null on the wire. `firestore.rules` allows null on exactly
    // these two fields for that reason, where every other numeric field takes a
    // plain range check.
    "householdNotificationsLive" to SettingsDiffField({ it.householdNotificationsLive }),
    "householdNotificationHour" to SettingsDiffField({ it.householdNotificationHour }),
    "scheduleDigestHour" to SettingsDiffField({ it.scheduleDigestHour }),
    // --- Branding ---
    "logoUrl" to SettingsDiffField({ it.logoUrl }),
    // Also written server-side by the `confirmBrandAssetUpload` callable, so a
    // stale copy of it is a stale copy of something a server just stamped.
    "logoRemovedAt" to SettingsDiffField({ it.logoRemovedAt }),
    "brandWordmark" to SettingsDiffField({ it.brandWordmark }),
    "brandTagline" to SettingsDiffField({ it.brandTagline }),
    "homeGreeting" to SettingsDiffField({ it.homeGreeting }),
    "homeAccentTail" to SettingsDiffField({ it.homeAccentTail }),
    // --- Payment handles ---
    "venmoHandle" to SettingsDiffField({ it.venmoHandle }),
    "paypalHandle" to SettingsDiffField({ it.paypalHandle }),
    "cashappHandle" to SettingsDiffField({ it.cashappHandle }),
    // --- Weather area ---
    "weatherLocation" to SettingsDiffField({ it.weatherLocation }),
    // --- Tag vocabularies ---
    // COMPARED DECODED, WRITTEN RAW, the same split `Kinfolk.tags` needed in
    // `DirectoryFieldChanges.kt`. A doc that has never had a vocabulary holds no
    // key at all and reads as null, while the Tags panel re-encodes BOTH scopes
    // on every save and so offers `[]` for the one it did not touch. Comparing
    // the raw values would call that a change and write an empty array over
    // "never configured"; comparing the decoded vocabulary calls it what it is.
    // The written value stays the raw encoded list so `TagColor.css` round-trips
    // to React unchanged.
    "householdTags" to SettingsDiffField(
        write = { it.householdTags },
        compare = { it.householdTagDefs() },
    ),
    "petTags" to SettingsDiffField(
        write = { it.petTags },
        compare = { it.petTagDefs() },
    ),
    // --- MyTribe portal Home layout (issue #397 M10) ---
    // Same split as the tag vocabularies just above, and for the same reason:
    // this client only edits `home.sections` (`withHomeSections`), never
    // `logoUrl`/`themeId`/`banner`/`chat`, so comparing the RAW `mytribePortal`
    // value would call re-encoding an untouched layout a change (or comparing
    // a stray unmodelled sibling key an edit here never touched). Comparing the
    // decoded Home layout means only an actual reorder/toggle/limit edit
    // writes, and the value it writes is the raw map [withHomeSections]
    // produced, which carries every sibling key forward untouched.
    "mytribePortal" to SettingsDiffField(
        write = { it.mytribePortal },
        compare = { it.homeSections() },
    ),
)

/**
 * `business_settings` fields this client must never write, and who owns each.
 *
 * - `id`         the document id (`@DocumentId`, never serialised anyway)
 * - `updatedAt`  stamped at write time by the repository, never round-tripped
 * - `updatedBy`  same, from the caller's actor string
 *
 * The four `calendarSyncLast*` receipt fields are not listed because they are not
 * on this model at all; see the file header.
 */
internal val BUSINESS_SETTINGS_SERVER_OWNED = setOf("id", "updatedAt", "updatedBy")

/**
 * Map fields this client always writes WHOLE, where a key it left out is a
 * key the operator removed.
 *
 * `SetOptions.merge()` merges a nested map key by key, so a `serviceRates`
 * write that no longer carries "Walk" leaves the stored "Walk" exactly where
 * it was, and the KinCare types editor's Remove would come back on the next
 * load (the one case it worked was removing the LAST type, since an empty map
 * does overwrite). The rate card is a flat name-to-value map one editor owns
 * outright, so a write naming it goes out under `SetOptions.mergeFields`,
 * which replaces each named top-level field wholesale and still leaves every
 * field the write does not name untouched. Mirrors `WHOLE_MAP_FIELDS` in the
 * React admin's `settingsWrite.ts`.
 *
 * Not the rule for every write: `mytribePortal` is a nested map more than one
 * client writes a slice of, and the key-by-key merge is what keeps one save
 * from clobbering another's.
 */
internal val BUSINESS_SETTINGS_WHOLE_MAP_FIELDS = setOf("serviceRates", "serviceDurations")

/** True when [changes] names a field that must replace, not merge, the stored value. */
internal fun businessSettingsReplacesWholeFields(changes: Map<String, Any?>): Boolean =
    changes.keys.any { it in BUSINESS_SETTINGS_WHOLE_MAP_FIELDS }

/**
 * The fields [edited] changes relative to [loaded], keyed by Firestore field
 * name. Empty when nothing changed, which the caller must treat as "do not
 * write" rather than "write the stamp".
 *
 * [loaded] must be the copy Firestore handed us, never a re-read: re-reading to
 * diff would hand back exactly the concurrent edit this is protecting.
 *
 * A field cleared to blank IS a change and is written as `""`. Skipping blanks
 * would make "take my Venmo handle off the invoice" the one edit no screen can
 * perform.
 */
internal fun businessSettingsFieldChanges(
    loaded: BusinessSettings,
    edited: BusinessSettings,
): Map<String, Any?> {
    val changes = LinkedHashMap<String, Any?>()
    for ((field, spec) in BUSINESS_SETTINGS_DIFF_FIELDS) {
        if (spec.compare(edited) != spec.compare(loaded)) changes[field] = spec.write(edited)
    }
    return changes
}
