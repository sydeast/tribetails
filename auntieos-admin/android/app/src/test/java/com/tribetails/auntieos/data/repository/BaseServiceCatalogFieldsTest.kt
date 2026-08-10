package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.firestore.CollectionReference
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.SetOptions
import com.tribetails.auntieos.data.model.baseServiceFieldChanges
import com.tribetails.auntieos.data.model.BaseService
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The android app is not the author of the portal's service catalog fields, and
 * must not be able to delete them.
 *
 * `base_services/{id}` is read SERVER-SIDE by two MyTribe functions, and each
 * reads field names [BaseService] has never declared:
 *
 *  - `portal/requestBooking.ts#resolveService` takes `name` and `priceCents` as
 *    the canonical, server-trusted label and price for a kinfolk booking
 *    ("a kinfolk client must never be trusted to supply its own price"). It has
 *    NO fallback to `title`/`basePrice`: a missing `priceCents` resolves to
 *    `priceCents: null` and the booking is persisted with no price at all.
 *  - `portal/getServiceCatalog.ts` filters the catalog on `d.data()?.active
 *    !== false` and maps `priceMinCents`, `priceMaxCents`, `isOvernight` and
 *    `iconKey` onto the ServiceDto the kinfolk portal renders.
 *
 * [BaseService] declares `title`, `basePrice` and `isActive` — three DIFFERENT
 * field names. Nothing else in this repository writes `base_services`
 * (no callable, no script, no React admin path: `firestore.rules:805` grants
 * `write: if isAuntie()` and only `ServiceRepository` uses it), so a field this
 * client deletes is gone for good — there is no other writer to put it back.
 *
 * `active` is the crisp one, and it does not depend on which pricing shape a
 * given production document happens to carry: delete `active`, and
 * `active !== false` becomes true, so a service deliberately hidden from the
 * kinfolk portal REAPPEARS in the catalog the next time an operator edits it on
 * the phone.
 *
 * The write mode is not asserted for its own sake. Each test replays the
 * recorded write against a stored document using Firestore's real semantics -
 * `set(obj)` REPLACES the document, `set(obj, merge())` overlays only the keys
 * the payload carries - and asserts on what survives. A test that merely
 * counted `SetOptions.merge()` calls would pass just as happily if merge
 * stopped preserving anything.
 *
 * No Robolectric: the Firestore write surface is mockk-stubbed and the returned
 * Tasks are already complete, so `await()` resolves inline on the JVM. Same
 * shape as KinCareReportReconcileMergeTest.
 */
class BaseServiceCatalogFieldsTest {

    private val firestore = mockk<FirebaseFirestore>()
    private val collection = mockk<CollectionReference>()
    private val docRef = mockk<DocumentReference>()

    /** The write the repo actually issued, and whether it asked Firestore to merge. */
    private data class RecordedWrite(val payload: Any, val merge: Boolean)

    private var recorded: RecordedWrite? = null

    private fun repo(docId: String): ServiceRepository {
        every { firestore.collection("base_services") } returns collection
        every { collection.document(docId) } returns docRef
        every { docRef.set(any()) } answers {
            recorded = RecordedWrite(firstArg(), merge = false)
            Tasks.forResult<Void>(null)
        }
        every { docRef.set(any(), any<SetOptions>()) } answers {
            recorded = RecordedWrite(firstArg(), merge = true)
            Tasks.forResult<Void>(null)
        }
        return ServiceRepository(firestoreProvider = { firestore })
    }

    /**
     * The keys the recorded payload puts on the wire. A field-map write carries
     * exactly its own keys; a POJO write carries every declared property of the
     * data class, blank ones included - and, by omission, exactly the set of
     * server-written fields a bare `set()` destroys.
     */
    private fun writtenKeys(): Set<String> {
        val write = requireNotNull(recorded) { "the repository issued no document write at all" }
        val payload = write.payload
        return if (payload is Map<*, *>) {
            payload.keys.map { it.toString() }.toSet()
        } else {
            payload.javaClass.declaredFields.map { it.name }.filterNot { it.startsWith("$") }.toSet()
        }
    }

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

    /** The catalog document as the portal functions actually find it in production. */
    private fun storedCatalogDoc(): Map<String, Any> = mapOf(
        "title" to "Dog Walk",
        "basePrice" to 25.0,
        "isActive" to true,
        // Server-read, client-undeclared. See the class comment for each reader.
        "name" to "Dog Walk",
        "priceCents" to 2500L,
        "priceMinCents" to 2000L,
        "priceMaxCents" to 3000L,
        "isOvernight" to false,
        "iconKey" to "paw",
        "active" to false,
    )

    // ── the premise: the client cannot name these fields ──────────────────────

    @Test
    fun `BaseService declares none of the portal catalog's field names`() {
        val keys = BaseService::class.java.declaredFields
            .map { it.name }
            .filterNot { it.startsWith("$") }
            .toSet()
        // If this ever fails the fix went the wrong way. Declaring `priceCents`
        // would make this app an owner of the server-trusted price, so a save
        // that races an edit elsewhere writes the stale amount it read back over
        // the real one - the same trade KinCareReport declines to make.
        listOf("name", "priceCents", "priceMinCents", "priceMaxCents", "isOvernight", "iconKey", "active")
            .forEach { assertFalse("model must not own portal catalog field $it", it in keys) }
        // Sanity: the reflection above is reading real fields, not an empty set.
        assertTrue("title" in keys)
        assertTrue("basePrice" in keys)
        assertTrue("isActive" in keys)
    }

    // ── the defect ────────────────────────────────────────────────────────────

    @Test
    fun `editing a service does not erase the server-trusted price`() {
        val loaded = BaseService(id = "svc-1", title = "Dog Walk", basePrice = 25.0)
        val edited = loaded.copy(title = "Dog Walk (30 min)")

        val result = runBlocking {
            repo("svc-1").updateBaseServiceFields("svc-1", baseServiceFieldChanges(loaded, edited))
        }

        assertTrue(result.isSuccess)
        val after = serverDocAfterWrite(storedCatalogDoc())
        // The whole point. Lose priceCents and `resolveService` returns
        // `priceCents: null`, so every portal booking for this service is
        // persisted with no price and deferred to invoice time.
        assertEquals(2500L, after["priceCents"])
        assertEquals("Dog Walk", after["name"])
    }

    @Test
    fun `editing a service does not un-hide it from the kinfolk portal`() {
        val loaded = BaseService(id = "svc-1", title = "Dog Walk", basePrice = 25.0)
        val edited = loaded.copy(basePrice = 30.0)

        runBlocking {
            repo("svc-1").updateBaseServiceFields("svc-1", baseServiceFieldChanges(loaded, edited))
        }.getOrThrow()

        val after = serverDocAfterWrite(storedCatalogDoc())
        // `getServiceCatalog` filters on `active !== false`. Deleting the key
        // makes a deliberately hidden service visible again.
        assertEquals(false, after["active"])
        assertEquals(2000L, after["priceMinCents"])
        assertEquals("paw", after["iconKey"])
    }

    @Test
    fun `an edited field still reaches the server, blanked ones included`() {
        // The diff must not become a way to silence a real edit: a field the
        // operator deliberately cleared has to arrive as cleared.
        val loaded = BaseService(id = "svc-1", title = "Dog Walk", equipmentNotes = "bring the long lead")
        val edited = loaded.copy(equipmentNotes = "")

        runBlocking {
            repo("svc-1").updateBaseServiceFields("svc-1", baseServiceFieldChanges(loaded, edited))
        }.getOrThrow()

        assertEquals("", requireNotNull(recorded).let { (it.payload as Map<*, *>)["equipmentNotes"] })
        assertEquals("written-by-client", serverDocAfterWrite(storedCatalogDoc())["equipmentNotes"])
    }

    @Test
    fun `an unrelated modelled field is not rewritten at its stale value`() {
        // A second phone (or a stale screen) is a concurrent writer of the
        // fields this model DOES own. Renaming a service must not put the
        // `isActive` this screen read minutes ago back over a soft delete.
        val loaded = BaseService(id = "svc-1", title = "Dog Walk", isActive = true)
        val edited = loaded.copy(title = "Dog Walk (30 min)")

        runBlocking {
            repo("svc-1").updateBaseServiceFields("svc-1", baseServiceFieldChanges(loaded, edited))
        }.getOrThrow()

        assertEquals(setOf("title", "updatedAt"), writtenKeys())
    }

    @Test
    fun `the save stamps updatedAt rather than round-tripping the read value`() {
        val loaded = BaseService(id = "svc-1", title = "Dog Walk", updatedAt = "1999-01-01T00:00:00")
        val edited = loaded.copy(title = "Dog Walk (30 min)")

        runBlocking {
            repo("svc-1").updateBaseServiceFields("svc-1", baseServiceFieldChanges(loaded, edited))
        }.getOrThrow()

        val stamp = (requireNotNull(recorded).payload as Map<*, *>)["updatedAt"] as String
        assertTrue(stamp != "1999-01-01T00:00:00")
    }

    /**
     * A write that changes nothing could only move the stamp, claiming an edit
     * that never happened. It is a caller bug, and it fails loud here rather
     * than reaching Firestore.
     */
    @Test
    fun `a save that changed nothing is refused, not sent`() {
        val loaded = BaseService(id = "svc-1", title = "Dog Walk")
        val result = runBlocking {
            repo("svc-1").updateBaseServiceFields("svc-1", baseServiceFieldChanges(loaded, loaded.copy()))
        }
        assertTrue(result.isFailure)
        assertTrue(recorded == null)
    }

    /**
     * `createBaseService` used to take `document(service.id)` when the id was
     * non-blank - an UPDATE wearing a create's name, through the same bare
     * `set()`, on the same document. Same precedent as
     * `AuntieRepository.saveHouseholdData`: it fails loud rather than quietly
     * re-opening the path this change closed.
     */
    @Test
    fun `createBaseService refuses an id and points at the edit path`() {
        val result = runBlocking {
            repo("svc-1").createBaseService(BaseService(id = "svc-1", title = "Dog Walk"))
        }
        assertTrue(result.isFailure)
        assertTrue(recorded == null)
        assertTrue(
            result.exceptionOrNull()?.message.orEmpty().contains("updateBaseServiceFields"),
        )
    }
}
