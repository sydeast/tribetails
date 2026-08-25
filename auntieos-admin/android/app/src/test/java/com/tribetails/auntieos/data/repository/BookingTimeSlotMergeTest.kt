package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.firestore.CollectionReference
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.SetOptions
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.HttpsCallableReference
import com.google.firebase.functions.HttpsCallableResult
import com.tribetails.auntieos.data.model.BookingTimeSlot
import com.tribetails.auntieos.data.model.TimeSlotType
import com.tribetails.auntieos.data.model.bookingTimeSlotFieldChanges
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The android app is not the author of `booking_time_slots/{id}.createdBy`, and
 * must not be able to erase it - nor to write back a whole slot it read minutes
 * ago over a server edit.
 *
 * `updateTimeSlot` used to write the whole [BookingTimeSlot] with a BARE
 * `.set()` - no merge option, a full document REPLACE. Two server writers share
 * this collection and both put fields on it that this Kotlin model does not
 * declare:
 *
 *  - `mytribe/functions/src/admin/createBlockedTimeSlot.ts` writes `createdBy`
 *    (the uid of the admin who blocked the window) and an `updatedAt` stamp.
 *    Neither is on the model, so a bare set DELETED both. `createdBy` is the
 *    only copy of that provenance on the document itself; the audit entry the
 *    callable also writes is a different collection and is not client-readable.
 *  - `syncGoogleCalendarBusyEvents.ts` writes with `{ merge: true }`, so it
 *    preserves whatever it does not name - the shape this fix adopts.
 *
 * THE SAME LOSS THIS REPO HAS ALREADY PAID FOR TWICE: `ChecklistItem.required`
 * stripped from every KinTale template while the field was off the Kotlin model,
 * and the desktop admin's `deleted: true` erased by android edits.
 *
 * WHAT IT COSTS TODAY IS NOTHING, AND SAYING SO IS PART OF THE FIX.
 * `firestore.rules:798` reads
 * `match /booking_time_slots/{id} { allow read: if isAuntie(); allow write: if false; }`
 * - every client write to this collection is denied. The bare set could not
 * reach the server, so `createdBy` has never actually been erased in production.
 * The write shape was dangerous; the damage was latent, exactly as on
 * `coverage_package_config`. The rule is one line and one deploy away from
 * changing; the write shape should not be what stands between that line and a
 * silent erasure.
 *
 * The write mode is not asserted for its own sake. Each test replays the
 * recorded write against a stored document using Firestore's real semantics -
 * `set(obj)` REPLACES the document, `set(obj, merge())` overlays only the keys
 * the payload carries - and asserts on what survives. A test that merely counted
 * `SetOptions.merge()` calls would pass just as happily if merge stopped
 * preserving anything.
 *
 * No Robolectric: the Firestore write surface is mockk-stubbed and the returned
 * Tasks are already complete, so `await()` resolves inline on the JVM. Same
 * shape as `KinTaleTemplateMergeTest` and `UserProfileMergeTest`.
 */
class BookingTimeSlotMergeTest {

    private val firestore = mockk<FirebaseFirestore>()
    private val collection = mockk<CollectionReference>()
    private val docRef = mockk<DocumentReference>()

    /** The write the repo actually issued, and whether it asked Firestore to merge. */
    private data class RecordedWrite(val payload: Any, val merge: Boolean)

    private var recorded: RecordedWrite? = null

    /** Set if the repository ever issues a client DELETE on `booking_time_slots`. */
    private var deletedPath: String? = null

    private fun repo(slotId: String = SLOT_ID): BookingRepository {
        every { firestore.collection("booking_time_slots") } returns collection
        every { collection.document(slotId) } returns docRef
        every { collection.document() } returns docRef
        every { docRef.id } returns "generated-id"
        every { docRef.set(any()) } answers {
            recorded = RecordedWrite(firstArg(), merge = false)
            Tasks.forResult<Void>(null)
        }
        every { docRef.set(any(), any<SetOptions>()) } answers {
            recorded = RecordedWrite(firstArg(), merge = true)
            Tasks.forResult<Void>(null)
        }
        every { docRef.delete() } answers {
            deletedPath = "booking_time_slots/$slotId"
            Tasks.forResult<Void>(null)
        }
        return BookingRepository(firestore = firestore, functions = happyCallables())
    }

    /**
     * A Firebase Functions surface where every callable succeeds. The point of
     * the two #574 tests is what does NOT reach Firestore, so the callable half
     * only has to complete: a relaxed mock would hand `await()` a Task that
     * never finishes and the test would hang rather than fail.
     */
    private fun happyCallables(): FirebaseFunctions {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        val result = mockk<HttpsCallableResult>(relaxed = true)
        every { result.getData() } returns mapOf("ok" to true, "docId" to "slot-new", "slotId" to SLOT_ID)
        every { ref.call(any<Map<String, Any?>>()) } returns Tasks.forResult(result)
        every { functions.getHttpsCallable(any()) } returns ref
        return functions
    }

    /**
     * The keys the recorded payload puts on the wire. A field-map write carries
     * exactly its own keys; a POJO write carries every declared property of the
     * data class - and, by omission, exactly the set of sibling-written fields a
     * bare `set()` destroys.
     */
    private fun writtenKeys(): Set<String> {
        val payload = requireNotNull(recorded) { "the repository issued no document write at all" }.payload
        return if (payload is Map<*, *>) {
            payload.keys.map { it.toString() }.toSet()
        } else {
            payload.javaClass.declaredFields.map { it.name }.filterNot { it.startsWith("$") }.toSet()
        }
    }

    private fun payloadMap(): Map<*, *> =
        requireNotNull(recorded) { "the repository issued no document write at all" }.payload as Map<*, *>

    /**
     * Replays the recorded write against a stored document, as Firestore would.
     * `set(obj)` REPLACES the whole document; `set(obj, merge())` overlays only
     * the keys the payload carries and leaves every other stored key alone.
     */
    private fun serverDocAfterWrite(stored: Map<String, Any>): Map<String, Any> {
        val write = requireNotNull(recorded) { "the repository issued no document write at all" }
        val incoming = writtenKeys().associateWith { "written-by-client" as Any }
        return if (write.merge) stored + incoming else incoming
    }

    /**
     * The slot as `createBlockedTimeSlot.ts` actually leaves it: the callable's
     * own field set, including the two fields [BookingTimeSlot] does not declare.
     */
    private fun storedBlockedSlotDoc(): Map<String, Any> = mapOf(
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
        // Written by createBlockedTimeSlot.ts. Not on BookingTimeSlot, by design.
        "createdBy" to "auntie-1",
        "updatedAt" to "2026-06-25T09:00:00.000Z",
    )

    private val loaded = BookingTimeSlot(
        id = SLOT_ID,
        date = "2026-06-25",
        startTime = "09:00",
        endTime = "12:00",
        isAvailable = false,
        slotType = TimeSlotType.BLOCKED,
        notes = "PTO",
        createdAt = "2026-06-25T09:00:00.000Z",
    )

    private fun save(edited: BookingTimeSlot, from: BookingTimeSlot = loaded) = runBlocking {
        repo().updateTimeSlotFields(from.id, bookingTimeSlotFieldChanges(from, edited))
    }

    // ── the premise: the client cannot name these fields ───────────────────────

    @Test
    fun `BookingTimeSlot declares none of the server-written fields`() {
        val keys = BookingTimeSlot::class.java.declaredFields
            .map { it.name }
            .filterNot { it.startsWith("$") }
            .toSet()
        assertTrue("createdBy" !in keys)
        assertTrue("updatedBy" !in keys)
        // Sanity: the reflection above is reading real fields, not an empty set.
        assertTrue("date" in keys)
        assertTrue("slotType" in keys)
    }

    // ── the defect ────────────────────────────────────────────────────────────

    /**
     * Renaming the reason on a blocked window must not take the record of WHO
     * blocked it. Under the bare set the whole document was replaced by the 14
     * fields this model declares, and `createdBy` was simply gone.
     */
    @Test
    fun `editing the note does not erase who blocked the window`() {
        val result = save(loaded.copy(notes = "Dentist"))

        assertTrue(result.isSuccess)
        assertEquals("auntie-1", serverDocAfterWrite(storedBlockedSlotDoc())["createdBy"])
    }

    @Test
    fun `moving the window writes only the times and the stamp`() {
        save(loaded.copy(startTime = "10:00", endTime = "13:00")).getOrThrow()

        assertEquals(setOf("startTime", "endTime", "updatedAt"), writtenKeys())
        // Everything the payload does not name survives the write.
        val after = serverDocAfterWrite(storedBlockedSlotDoc())
        assertEquals("auntie-1", after["createdBy"])
        assertEquals("PTO", after["notes"])
        assertEquals("LOCAL_ONLY", after["syncState"])
    }

    /**
     * The importer's dedup key. A phone holding a `GOOGLE_BUSY_IMPORT` slot must
     * not be able to null `externalEventId` out: `syncGoogleCalendarBusyEvents`
     * finds an existing slot by exactly that field, so losing it makes the next
     * sync CREATE A DUPLICATE busy block rather than update this one.
     */
    @Test
    fun `an edit never touches the Google importer's dedup key`() {
        save(loaded.copy(notes = "Dentist")).getOrThrow()

        assertTrue("externalEventId" !in writtenKeys())
        assertTrue("source" !in writtenKeys())
        assertEquals("busy_cal-1_1_2", serverDocAfterWrite(importedSlotDoc())["externalEventId"])
    }

    private fun importedSlotDoc(): Map<String, Any> =
        storedBlockedSlotDoc() + mapOf(
            "source" to "GOOGLE_BUSY_IMPORT",
            "externalEventId" to "busy_cal-1_1_2",
            "externalCalendarId" to "cal-1",
            "syncState" to "SYNCED",
        )

    @Test
    fun `a note cleared by the operator still reaches the server as cleared`() {
        save(loaded.copy(notes = "")).getOrThrow()

        assertEquals("", payloadMap()["notes"])
    }

    @Test
    fun `the save stamps updatedAt rather than round-tripping the read value`() {
        save(loaded.copy(notes = "Dentist")).getOrThrow()

        assertNotEquals("2026-06-25T09:00:00.000Z", payloadMap()["updatedAt"])
    }

    // ── the refusals ──────────────────────────────────────────────────────────

    /**
     * An empty change set could only move `updatedAt`, claiming an edit that
     * never happened - and on this collection that stamp is the server's, so the
     * lie would be told in the server's own field.
     */
    @Test
    fun `a write with no changed fields is refused rather than stamping`() {
        val result = runBlocking { repo().updateTimeSlotFields(SLOT_ID, emptyMap()) }

        assertTrue(result.isFailure)
        assertNull(recorded)
    }

    @Test
    fun `a blank slot id is refused rather than written to a document named empty`() {
        val result = runBlocking { repo("").updateTimeSlotFields("", mapOf("notes" to "x")) }

        assertTrue(result.isFailure)
        assertNull(recorded)
    }

    // ── #574: the write that could never land ────────────────────────────────
    //
    // `createTimeSlot` and `deleteTimeSlot` stood here and wrote/deleted
    // `booking_time_slots` DIRECTLY. The rule quoted in this class's header
    // (`allow write: if false`) denies every client write to this collection, so
    // both failed with PERMISSION_DENIED every single time an operator pressed
    // the button - "Save Block" on Scheduling Options, "Unblock" on either list.
    // The write shape was dangerous AND the write was impossible; #574 moved
    // both paths onto the `createBlockedTimeSlot` / `deleteBlockedTimeSlot`
    // callables.
    //
    // These two tests are the ones that would have caught it. They give the
    // repository a Firestore whose every write and delete is recorded, drive the
    // two block-time paths, and assert that NOTHING reached the collection. A
    // test asserting the callable was invoked would pass just as happily beside
    // a stray direct write left in place next to it; this asserts the absence.
    // What goes ON the wire instead is pinned by `BookingTimeSlotCallableTest`.
    @Test
    fun `blocking a window issues no client write to booking_time_slots`() {
        runBlocking {
            repo().createBlockedTimeSlot(
                date = "2026-08-24",
                startTime = "09:00",
                endTime = "12:00",
                notes = "Vet",
                startTimeMs = 1_000L,
                endTimeMs = 2_000L,
            )
        }

        assertNull(
            "blocking a window wrote booking_time_slots straight from the client: $recorded",
            recorded,
        )
    }

    @Test
    fun `unblocking a window issues no client delete on booking_time_slots`() {
        runBlocking { repo().deleteBlockedTimeSlot(SLOT_ID) }

        assertNull(
            "unblocking deleted booking_time_slots/$SLOT_ID straight from the client",
            deletedPath,
        )
    }

    private companion object {
        const val SLOT_ID = "slot-1"
    }
}
