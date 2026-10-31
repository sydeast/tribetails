package com.tribetails.auntieos.web.data
import kotlinx.serialization.json.decodeFromJsonElement
import kotlin.test.Test
import kotlin.test.assertEquals
/**
 * #1180. `viewed` is the old system's Viewed flag on migrated invoices. Nothing in
 * this system writes it, so a document may hold text ("Yes"), a boolean, an
 * explicit null, or nothing. `JvmFirestoreRest.list` drops any document whose
 * decode throws (runCatching), so a wrong-typed `viewed` would silently remove
 * the invoice from the desktop list. This runs the same codec on the same shapes.
 */
class InvoiceViewedDecodeTest {
    private fun decode(viewedJson: String?): Invoice {
        val field = if (viewedJson == null) "" else ""","viewed":$viewedJson"""
        val el = JvmFirestoreRest.codec.parseToJsonElement("""{"_id":"inv-1"$field}""")
        return JvmFirestoreRest.codec.decodeFromJsonElement<Invoice>(el)
    }
    @Test fun migratedStringYesDecodes() = assertEquals("Yes", decode("\"Yes\"").viewed)
    @Test fun booleanFalseDecodes() = assertEquals("false", decode("false").viewed)
    @Test fun booleanTrueDecodes() = assertEquals("true", decode("true").viewed)
    @Test fun explicitNullDecodes() = assertEquals(null, decode("null").viewed)
    @Test fun absentDecodes() = assertEquals(null, decode(null).viewed)
}
