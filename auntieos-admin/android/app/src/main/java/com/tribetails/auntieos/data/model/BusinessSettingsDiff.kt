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
 * venmo/paypal/cashapp handles, the payment switches and the two tag vocabularies all sit on this doc
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
    /**
     * For a map the server merges key by key: the value to write given both
     * copies, or null to write nothing. Set only where sending the whole map
     * would put back a stale value for a key this save did not change.
     */
    val writeChange: ((loaded: BusinessSettings, edited: BusinessSettings) -> Any?)? = null,
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
    "privacyPolicyUrl" to SettingsDiffField({ it.privacyPolicyUrl }),
    "timeZone" to SettingsDiffField({ it.timeZone }),
    "serviceRates" to SettingsDiffField({ it.serviceRates }),
    "serviceDurations" to SettingsDiffField({ it.serviceDurations }),
    // True entries only, compared the same way, so a decoded `false` neither
    // reads as an edit nor is ever written back (#1092).
    "serviceStartTimeBooking" to SettingsDiffField({ settings -> settings.serviceStartTimeBooking.filterValues { it } }),
    // #1764: ONLY THE DAYS THAT CHANGED. The server merges this map key by key,
    // so the days left out keep what is stored, including a day the web changed
    // after this phone read the document. A day missing from the edited copy
    // is not sent at all: there is no "unset" in a key-by-key merge, and an
    // empty map would land as `{}` over the whole week.
    "businessHours" to SettingsDiffField(
        write = { it.businessHours },
        writeChange = { loaded, edited ->
            edited.businessHours.filter { (day, value) -> loaded.businessHours[day] != value }.ifEmpty { null }
        },
    ),
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
    // The per-method switches and instructions (#409 on web, #1177 here).
    // COMPARED DECODED, WRITTEN RAW, like the tag vocabularies below: a save from
    // any other panel hands back the raw map it read and is not a change, while
    // the Payment options panel writes the raw map [withPaymentDraft] built,
    // which carries every key it does not model forward untouched. Merged key by
    // key by `saveBusinessSettings`, the same as the web's save.
    "paymentOptions" to SettingsDiffField(
        write = { it.paymentOptions },
        // #1785: an unknown id's own entry is compared too, so editing one is a
        // change the save guard can refuse, and an untouched one is not.
        compare = { decodePaymentOptions(it.paymentOptions) to unknownPaymentEntries(it.paymentOptions) },
        // #1785: ONLY THE METHODS THAT CHANGED, like the web and desktop. The
        // server checks every key it receives, so a stored id it does not list
        // must not ride along on a save that did not touch it.
        writeChange = { loaded, edited -> changedPaymentOptions(loaded, edited) },
    ),
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
    //
    // #1783: only the `home` slice goes out. `saveBusinessSettings` merges the
    // portal key by key and checks the keys it is sent, so echoing the sibling
    // keys back (theme, banner, chat, logo) would hold a Home layout save to
    // their stored values for no gain: the server keeps them where they are.
    "mytribePortal" to SettingsDiffField(
        write = { portalHomeSlice(it.mytribePortal) },
        compare = { it.homeSections() },
    ),
)

/** The `home` key of a raw `mytribePortal` map, alone (#1783). Anything else, or no home, is sent as it is. */
internal fun portalHomeSlice(raw: Any?): Any? {
    val portal = raw as? Map<*, *> ?: return raw
    val home = portal["home"] ?: return raw
    return mapOf("home" to home)
}
/**
 * `business_settings` fields this client must never write, and who owns each.
 *
 * - `id`         the document id (`@DocumentId`, never serialised anyway)
 * - `updatedAt`  stamped by the `saveBusinessSettings` callable, never sent
 * - `updatedBy`  same, from the caller's sign-in
 * - `closedDayHours`  #1978, derived by that callable from the day it closes;
 *                the server refuses a save that names it
 *
 * The four `calendarSyncLast*` receipt fields are not listed because they are not
 * on this model at all; see the file header.
 */
internal val BUSINESS_SETTINGS_SERVER_OWNED = setOf("id", "updatedAt", "updatedBy", "closedDayHours")

/**
 * #1593: [changes] as the `saveBusinessSettings` callable can carry it.
 *
 * The callable serializer takes null, String, Boolean, numbers, Map and List
 * and nothing else, where Firestore's `.set()` used to map a Kotlin class as a
 * POJO. So every value goes out as plain data, under the SAME field names that
 * mapper produced, because the stored document, the web admin and the server
 * checks all read those names:
 *
 *  - [TimeBlockDefinition] becomes `{ id, label, startTime, endTime, active }`.
 *    `active`, not `isActive`: the mapper names a Kotlin `isX` Boolean by its
 *    getter, which drops the `is`, and the server checks `active`.
 *  - An enum goes out as its name (what the mapper wrote).
 *  - A Long inside a raw map read back from Firestore stays a number; one that
 *    fits an Int is sent as an Int so the wire carries a plain number.
 *  - Maps keep their key order and recurse; lists recurse.
 *
 * Anything else throws, naming the field, rather than reach the serializer and
 * fail there with a message nobody can act on.
 *
 * What the server does with the patch (nested maps merge key by key, the
 * KinCare rate card replaces whole, arrays replace, `updatedAt`/`updatedBy`
 * stamped there) is `mytribe/functions/src/admin/saveBusinessSettings.ts`.
 */
internal fun businessSettingsWireChanges(changes: Map<String, Any?>): Map<String, Any?> {
    val out = LinkedHashMap<String, Any?>()
    for ((field, value) in changes) out[field] = settingsWireValue(field, value)
    return out
}

private fun settingsWireValue(field: String, value: Any?): Any? = when (value) {
    null, is String, is Boolean -> value
    is Int, is Double, is Float, is Short, is Byte -> value
    is Long -> if (value in Int.MIN_VALUE..Int.MAX_VALUE) value.toInt() else value
    is Enum<*> -> value.name
    is TimeBlockDefinition -> linkedMapOf(
        "id" to value.id,
        "label" to value.label,
        "startTime" to value.startTime,
        "endTime" to value.endTime,
        "active" to value.isActive,
    )
    is Map<*, *> -> {
        val out = LinkedHashMap<String, Any?>()
        for ((k, v) in value) {
            require(k is String) { "$field has a key that is not text, so it cannot be saved." }
            out[k] = settingsWireValue(field, v)
        }
        out
    }
    is Iterable<*> -> value.map { settingsWireValue(field, it) }
    is Array<*> -> value.map { settingsWireValue(field, it) }
    else -> throw IllegalArgumentException(
        "$field holds a ${value::class.java.simpleName}, which this app cannot send. Reload Settings and try again.",
    )
}

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
        if (spec.compare(edited) == spec.compare(loaded)) continue
        val byKey = spec.writeChange
        if (byKey == null) {
            changes[field] = spec.write(edited)
        } else {
            changes[field] = byKey(loaded, edited) ?: continue
        }
    }
    return changes
}
/**
 * [current] with exactly the [fields] put back to their [baseline] values.
 *
 * Used when a write for those fields failed after the screen had already shown
 * them (#1214): an edit the server never took must not sit in the on-screen copy
 * as if it had landed, but a field this save never touched (another panel's
 * unsaved draft) must keep whatever it holds, so only the named ones go back.
 *
 * [fields] are Firestore field names, the keys [businessSettingsFieldChanges]
 * returns. Each is also the property name, because the model's property names ARE
 * the wire names (see the header of [BusinessSettings]); `BusinessSettingsDiffTest`
 * pins that for every key. Reflection rather than a second hand-written table:
 * the class is `@Keep`, and a second table would be one more list a new field has
 * to be added to.
 */
internal fun revertBusinessSettingsFields(
    current: BusinessSettings,
    baseline: BusinessSettings,
    fields: Collection<String>,
): BusinessSettings {
    if (fields.isEmpty()) return current
    val reverted = current.copy()
    for (name in fields) {
        val field = BusinessSettings::class.java.getDeclaredField(name)
        field.isAccessible = true
        field.set(reverted, field.get(baseline))
    }
    return reverted
}
