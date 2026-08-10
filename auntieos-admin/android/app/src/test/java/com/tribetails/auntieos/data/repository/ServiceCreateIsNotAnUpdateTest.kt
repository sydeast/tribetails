package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.firestore.CollectionReference
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.FirebaseFirestore
import com.tribetails.auntieos.data.model.Discount
import com.tribetails.auntieos.data.model.PromoCode
import com.tribetails.auntieos.data.model.SupplementalService
import com.tribetails.auntieos.data.model.Surcharge
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Four create functions with an update hiding inside them, the same shape #337
 * closed on `createBaseService`.
 *
 * Each one chose its document reference with
 * `if (model.id.isBlank()) collection.document() else collection.document(model.id)`
 * and then bare-`set()` the whole model over whatever was there - an UPDATE
 * wearing a create's name, through the write mode that REPLACES a document
 * rather than patching it. Every field the stored document carries and the
 * Kotlin model does not declare would be deleted by it.
 *
 * No screen reaches that branch today: every Add dialog builds a blank-id model
 * (`AddSupplementalServiceDialog` constructs one outright; the other three go
 * through `initial ?: Model()` with `initial` null on the Add route), and the
 * Edit route calls the `updateX` functions instead. That is exactly why the
 * branch is worth removing rather than leaving as a convenience: it is a
 * whole-document replace that nothing calls, waiting for the first caller that
 * passes an id and does not know what it costs.
 *
 * These do not assert a write mode. They assert that the refusal happens BEFORE
 * any document is written at all, which is the only thing that keeps the branch
 * shut.
 */
class ServiceCreateIsNotAnUpdateTest {

    private val firestore = mockk<FirebaseFirestore>()

    /** The payload the repo actually put on the wire, if it got that far. */
    private var recorded: Any? = null

    private fun repo(collectionName: String): ServiceRepository {
        val collection = mockk<CollectionReference>()
        val docRef = mockk<DocumentReference>()
        every { firestore.collection(collectionName) } returns collection
        every { collection.document() } returns docRef
        every { collection.document(any()) } returns docRef
        every { docRef.id } returns "generated-id"
        every { docRef.set(any()) } answers {
            recorded = firstArg()
            Tasks.forResult<Void>(null)
        }
        return ServiceRepository(firestoreProvider = { firestore })
    }

    // ── the branch that must not exist ────────────────────────────────────────

    @Test
    fun `creating a supplemental service with an id is refused before any write`() {
        val result = runBlocking {
            repo("supplemental_services").createSupplementalService(
                SupplementalService(id = "sup-1", title = "Extra walk"),
            )
        }

        assertNull(
            "createSupplementalService with an id REPLACED supplemental_services/sup-1: $recorded",
            recorded,
        )
        assertTrue("a create handed an id must fail loud, not update", result.isFailure)
    }

    @Test
    fun `creating a surcharge with an id is refused before any write`() {
        val result = runBlocking {
            repo("surcharges").createSurcharge(Surcharge(id = "sur-1", title = "Holiday rate"))
        }

        assertNull("createSurcharge with an id REPLACED surcharges/sur-1: $recorded", recorded)
        assertTrue("a create handed an id must fail loud, not update", result.isFailure)
    }

    @Test
    fun `creating a discount with an id is refused before any write`() {
        val result = runBlocking {
            repo("discounts").createDiscount(Discount(id = "dis-1", title = "Repeat kinfolk"))
        }

        assertNull("createDiscount with an id REPLACED discounts/dis-1: $recorded", recorded)
        assertTrue("a create handed an id must fail loud, not update", result.isFailure)
    }

    @Test
    fun `creating a promo code with an id is refused before any write`() {
        val result = runBlocking {
            repo("promo_codes").createPromoCode(PromoCode(id = "promo-1", code = "SPRING"))
        }

        assertNull("createPromoCode with an id REPLACED promo_codes/promo-1: $recorded", recorded)
        assertTrue("a create handed an id must fail loud, not update", result.isFailure)
    }

    /**
     * The refusal names the function that does the job, so a caller who lands on
     * it is not left guessing which of the two paths they wanted.
     */
    @Test
    fun `the refusal points at the update function`() {
        val result = runBlocking {
            repo("surcharges").createSurcharge(Surcharge(id = "sur-1", title = "Holiday rate"))
        }

        val message = result.exceptionOrNull()?.message.orEmpty()
        assertTrue("unhelpful refusal: $message", message.contains("updateSurcharge"))
    }

    // ── the path that IS a create ─────────────────────────────────────────────

    @Test
    fun `a blank id still creates, on a generated document`() {
        val result = runBlocking {
            repo("surcharges").createSurcharge(Surcharge(title = "Holiday rate"))
        }

        assertEquals("generated-id", result.getOrNull())
        assertTrue("the create must still write the whole model", recorded is Surcharge)
    }

    @Test
    fun `a blank id still creates a supplemental service`() {
        val result = runBlocking {
            repo("supplemental_services").createSupplementalService(SupplementalService(title = "Extra walk"))
        }

        assertEquals("generated-id", result.getOrNull())
        assertTrue(recorded is SupplementalService)
    }

    @Test
    fun `a blank id still creates a discount`() {
        val result = runBlocking {
            repo("discounts").createDiscount(Discount(title = "Repeat kinfolk"))
        }

        assertEquals("generated-id", result.getOrNull())
        assertTrue(recorded is Discount)
    }

    @Test
    fun `a blank id still creates a promo code`() {
        val result = runBlocking {
            repo("promo_codes").createPromoCode(PromoCode(code = "SPRING"))
        }

        assertEquals("generated-id", result.getOrNull())
        assertTrue(recorded is PromoCode)
    }
}
