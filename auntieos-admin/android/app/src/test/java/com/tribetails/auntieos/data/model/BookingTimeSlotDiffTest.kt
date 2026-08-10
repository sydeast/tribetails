package com.tribetails.auntieos.data.model

import com.google.firebase.Timestamp
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.util.CustomClassMapper
import io.mockk.every
import io.mockk.mockk
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Drift guard for the `booking_time_slots` field contract, the diff's own
 * behaviour, and the DECODE contract that says which side of the `syncState`
 * disagreement is wrong.
 *
 * Three halves, and the third is the one that costs a person something today:
 *
 *  - every field [BookingTimeSlot] declares is either written by the differ or
 *    named server-owned, so ADDING a field cannot silently stop it saving;
 *  - the two fields the server writes and this model does not declare stay OFF
 *    the model, because a client that cannot name a field cannot erase it; and
 *  - the exact document `createBlockedTimeSlot.ts` writes must DECODE. It did
 *    not, and the failure is not cosmetic: `toObjects` throws for the whole
 *    snapshot, so one operator-blocked window takes the entire busy overlay and
 *    every availability check on the phone down with it.
 *
 * Same shape as `KinTaleTemplateDiffTest` and `CoveragePackageConfigDiffTest`.
 */
class BookingTimeSlotDiffTest {

    private fun modelFields(): Set<String> =
        BookingTimeSlot::class.java.declaredFields
            .map { it.name }
            .filterNot { it.startsWith("$") }
            .toSet()

    // ── the contract ──────────────────────────────────────────────────────────

    @Test
    fun `every field on the model is either diffed or named server-owned`() {
        val covered = BOOKING_TIME_SLOT_DIFF_FIELDS.keys + BOOKING_TIME_SLOT_SERVER_OWNED
        val uncovered = modelFields() - covered
        assertEquals(
            "a new BookingTimeSlot field must join the differ or be named server-owned, " +
                "or the phone silently stops saving it: $uncovered",
            emptySet<String>(),
            uncovered,
        )
    }

    @Test
    fun `the differ names no field the model does not declare`() {
        assertEquals(emptySet<String>(), BOOKING_TIME_SLOT_DIFF_FIELDS.keys - modelFields())
    }

    /**
     * The mirror of the `deleted` guard on `kintale_templates`. `createdBy` and
     * `updatedAt` are written by `createBlockedTimeSlot.ts` and by nothing on
     * this client. Declaring them would let a phone write its own empty copy
     * over the server's, which is the erasure spelled out in the payload instead
     * of implied by omission.
     */
    @Test
    fun `the server-written provenance fields stay off the model`() {
        for (field in BOOKING_TIME_SLOT_SIBLING_WRITTEN) {
            assertTrue("$field must not be declared on BookingTimeSlot", field !in modelFields())
            assertTrue("$field must not be in the differ", field !in BOOKING_TIME_SLOT_DIFF_FIELDS.keys)
        }
        // Sanity: the reflection above is reading real fields, not an empty set.
        assertTrue("date" in modelFields())
        assertTrue("syncState" in modelFields())
    }

    /**
     * The Google importer's identity fields are the ones a re-sync depends on.
     * `externalEventId` is the dedup key `syncGoogleCalendarBusyEvents` queries
     * on (`where('externalEventId','==',…).limit(1)`), so a client that
     * overwrote it would make the next sync create a DUPLICATE busy block rather
     * than update the existing one. `source` is what
     * `mytribe/functions/src/lib/bookingBusyConflict.ts` filters on before it
     * will refuse a booking, so overwriting it silently drops the window out of
     * the server-side conflict guard.
     */
    @Test
    fun `the importer identity fields are named server-owned`() {
        for (field in listOf("source", "externalEventId", "externalCalendarId")) {
            assertTrue("$field must be server-owned", field in BOOKING_TIME_SLOT_SERVER_OWNED)
        }
    }

    // ── the diff ──────────────────────────────────────────────────────────────

    @Test
    fun `an untouched slot produces no changes`() {
        val loaded = slot()
        assertEquals(emptyMap<String, Any?>(), bookingTimeSlotFieldChanges(loaded, loaded.copy()))
    }

    @Test
    fun `moving a blocked window writes only the times`() {
        val loaded = slot()
        assertEquals(
            mapOf<String, Any?>("startTime" to "10:00", "endTime" to "13:00"),
            bookingTimeSlotFieldChanges(loaded, loaded.copy(startTime = "10:00", endTime = "13:00")),
        )
    }

    @Test
    fun `notes cleared by the operator are written as blank`() {
        val loaded = slot()
        assertEquals(
            mapOf<String, Any?>("notes" to ""),
            bookingTimeSlotFieldChanges(loaded, loaded.copy(notes = "")),
        )
    }

    /**
     * `syncState` IS the client's to write, and this is the case it exists for:
     * dismissing an imported busy block is an admin decision recorded on the
     * slot. It is in the differ so that decision can reach the server as its own
     * one-field change, never as a whole-model replace.
     */
    @Test
    fun `dismissing an imported busy block is a single-field change`() {
        val loaded = slot().copy(syncState = TimeSlotSyncState.SYNCED)
        assertEquals(
            mapOf<String, Any?>("syncState" to TimeSlotSyncState.DISMISSED),
            bookingTimeSlotFieldChanges(loaded, loaded.copy(syncState = TimeSlotSyncState.DISMISSED)),
        )
    }

    /**
     * A phone holding a Google-imported slot must not be able to relabel it as
     * its own, however different its copy is. Every one of these differs and
     * none of them is written.
     */
    @Test
    fun `the importer identity and the create stamp never enter the diff`() {
        val loaded = slot().copy(
            source = TimeSlotSource.GOOGLE_BUSY_IMPORT,
            externalEventId = "busy_cal_1_2_3",
            externalCalendarId = "cal-1",
        )
        val changes = bookingTimeSlotFieldChanges(
            loaded,
            loaded.copy(
                id = "other",
                createdAt = "2020-01-01T00:00:00",
                source = TimeSlotSource.INTERNAL_MANUAL,
                externalEventId = null,
                externalCalendarId = null,
            ),
        )
        assertEquals(emptyMap<String, Any?>(), changes)
    }

    // ── the decode contract ───────────────────────────────────────────────────

    /**
     * The exact document `createBlockedTimeSlot.ts` writes, decoded through the
     * same `CustomClassMapper` `DocumentSnapshot.toObject`/`toObjects` uses.
     *
     * BEFORE THE FIX this threw, twice over:
     *
     *   Could not deserialize object. Could not find enum value of
     *   com.tribetails.auntieos.data.model.TimeSlotSyncState for value "LOCAL"
     *   (found in field 'syncState')
     *
     *   Could not deserialize object. Failed to convert value of type
     *   com.google.firebase.Timestamp to String (found in field 'createdAt')
     *
     * Not a wrong label - a `RuntimeException` out of `toObjects`, which in
     * `bookingTimeSlotsStream` is raised inside the snapshot-listener callback
     * with nothing catching it, and in `getTimeSlots`/`getUnavailableSlotsForDate`
     * turns the WHOLE read into `Result.failure`. One blocked window written from
     * the web admin blanks the phone's entire busy overlay.
     */
    @Test
    fun `the document createBlockedTimeSlot writes decodes into the model`() {
        val decoded = CustomClassMapper.convertToCustomClass(
            serverBlockedSlotDoc(),
            BookingTimeSlot::class.java,
            docRef(),
        )

        assertNotNull(decoded)
        assertEquals(TimeSlotSyncState.LOCAL_ONLY, decoded.syncState)
        assertEquals(TimeSlotType.BLOCKED, decoded.slotType)
        assertEquals("2026-06-25T09:00:00.000Z", decoded.createdAt)
    }

    /** The importer's document decodes too; it always did, and must keep doing so. */
    @Test
    fun `the document syncGoogleCalendarBusyEvents writes decodes into the model`() {
        val decoded = CustomClassMapper.convertToCustomClass(
            serverBlockedSlotDoc() + mapOf(
                "source" to "GOOGLE_BUSY_IMPORT",
                "externalEventId" to "busy_cal-1_1_2",
                "externalCalendarId" to "cal-1",
                "syncState" to "SYNCED",
                "notes" to "Imported busy event",
            ) - "createdBy" - "updatedAt",
            BookingTimeSlot::class.java,
            docRef(),
        )

        assertEquals(TimeSlotSyncState.SYNCED, decoded.syncState)
        assertEquals(TimeSlotSource.GOOGLE_BUSY_IMPORT, decoded.source)
    }

    /**
     * The failure this whole enum question is about, pinned so nobody "fixes" it
     * by adding `LOCAL` to the vocabulary. A value outside the enum does not
     * fall back to the default and does not decode to null: it throws, and the
     * throw names the field.
     */
    @Test
    fun `an out-of-vocabulary syncState throws rather than degrading`() {
        val thrown = runCatching {
            CustomClassMapper.convertToCustomClass(
                serverBlockedSlotDoc() + mapOf("syncState" to "LOCAL"),
                BookingTimeSlot::class.java,
                docRef(),
            )
        }.exceptionOrNull()

        assertNotNull("an unknown enum string must fail loud, not default", thrown)
        assertTrue(
            "the throw must name the field: ${thrown?.message}",
            thrown?.message?.contains("syncState") == true,
        )
    }

    /** The second, independent decode break on the same document. */
    @Test
    fun `a Timestamp createdAt throws rather than degrading`() {
        val thrown = runCatching {
            CustomClassMapper.convertToCustomClass(
                serverBlockedSlotDoc() + mapOf("createdAt" to Timestamp(1_780_000_000L, 0)),
                BookingTimeSlot::class.java,
                docRef(),
            )
        }.exceptionOrNull()

        assertNotNull("a Timestamp in a String field must fail loud", thrown)
        assertTrue(
            "the throw must name the field: ${thrown?.message}",
            thrown?.message?.contains("createdAt") == true,
        )
    }

    /**
     * The fields this model does not declare are IGNORED on decode, not fatal.
     * That is why `createdBy`/`updatedAt` are safe to leave off the model - and
     * exactly why a bare `.set()` of the model was not safe: what the decoder
     * ignores, a whole-document replace deletes.
     */
    @Test
    fun `undeclared server fields are ignored on decode rather than throwing`() {
        val decoded = CustomClassMapper.convertToCustomClass(
            serverBlockedSlotDoc() + mapOf("someFieldFromTheFuture" to 7L),
            BookingTimeSlot::class.java,
            docRef(),
        )

        assertEquals("2026-06-25", decoded.date)
    }

    /**
     * `@DocumentId` is filled from the snapshot's own reference, so the mapper
     * needs one. Only its id is ever read.
     */
    private fun docRef(): DocumentReference = mockk<DocumentReference>().also {
        every { it.id } returns "slot-1"
    }
    /**
     * The document `createBlockedTimeSlot.ts` writes, field for field, as the
     * fix leaves it. Kept as one fixture so a change to the callable that this
     * model cannot read shows up here.
     */
    private fun serverBlockedSlotDoc(): Map<String, Any?> = mapOf(
        "date" to "2026-06-25",
        "startTime" to "09:00",
        "endTime" to "12:00",
        "isAvailable" to false,
        "slotType" to "BLOCKED",
        "notes" to "PTO",
        "source" to "INTERNAL_MANUAL",
        "externalEventId" to "",
        "externalCalendarId" to "",
        "hideDetailsFromKinfolk" to true,
        "isEditableByAdmin" to true,
        "isRemovableByAdmin" to true,
        "syncState" to "LOCAL_ONLY",
        "createdBy" to "auntie-1",
        "createdAt" to "2026-06-25T09:00:00.000Z",
        "updatedAt" to "2026-06-25T09:00:00.000Z",
    )

    private fun slot() = BookingTimeSlot(
        id = "slot-1",
        date = "2026-06-25",
        startTime = "09:00",
        endTime = "12:00",
        isAvailable = false,
        slotType = TimeSlotType.BLOCKED,
        notes = "PTO",
        createdAt = "2026-06-25T09:00:00.000Z",
    )
}
