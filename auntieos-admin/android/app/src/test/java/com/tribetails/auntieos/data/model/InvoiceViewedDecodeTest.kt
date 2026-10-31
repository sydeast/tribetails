package com.tribetails.auntieos.data.model
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.util.CustomClassMapper
import io.mockk.mockk
import org.junit.Assert.assertEquals
import org.junit.Test
/**
 * #1180. `viewed` is the old system's Viewed flag on migrated invoices. Nothing in
 * this system writes it, so a document may hold a string ("Yes"), a boolean, or
 * nothing. This runs the REAL Firestore decoder (the code `toObjects(Invoice)`
 * calls) because one wrong-typed field fails the whole query, not one row.
 */
class InvoiceViewedDecodeTest {
    private val noopDocRef = mockk<DocumentReference>(relaxed = true)
    private fun decode(raw: Map<String, Any?>): Invoice =
        CustomClassMapper.convertToCustomClass(raw, Invoice::class.java, noopDocRef)
    @Test fun `a migrated string Yes decodes`() {
        assertEquals("Yes", decode(mapOf("viewed" to "Yes")).viewed)
    }
    @Test fun `a boolean false decodes instead of dropping the invoice`() {
        assertEquals(false, decode(mapOf("viewed" to false)).viewed)
    }
    @Test fun `a boolean true decodes`() {
        assertEquals(true, decode(mapOf("viewed" to true)).viewed)
    }
    @Test fun `an explicit null decodes`() {
        assertEquals(null, decode(mapOf("viewed" to null)).viewed)
    }
    @Test fun `an absent field decodes`() {
        assertEquals(null, decode(emptyMap()).viewed)
    }
}
