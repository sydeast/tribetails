package com.tribetails.auntieos.data.model
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
/** #1785: the Payments save sends only the methods that changed, and an unknown stored id rides along on nothing. */
class PaymentOptionsChangedOnlyTest {
    private val stored = mapOf(
        "venmo" to mapOf("enabled" to true, "instructions" to ""),
        "zelle" to mapOf("enabled" to false, "instructions" to "555"),
        "oldcoin" to mapOf("enabled" to true, "instructions" to ""),
    )
    private val loaded = BusinessSettings(paymentOptions = stored)
    private fun edit(f: (PaymentDraft) -> PaymentDraft): BusinessSettings =
        loaded.withPaymentDraft(f(paymentDraftOf(loaded)))
    @Suppress("UNCHECKED_CAST")
    private fun sent(edited: BusinessSettings): Map<String, Any?>? =
        businessSettingsFieldChanges(loaded, edited)["paymentOptions"] as Map<String, Any?>?
    @Test
    fun `only the edited method is sent`() {
        val edited = edit { d -> d.copy(options = d.options + ("venmo" to PaymentOptionDraft(false, ""))) }
        val out = sent(edited)!!
        assertEquals(setOf("venmo"), out.keys)
        assertEquals(false, (out["venmo"] as Map<*, *>)["enabled"])
    }
    @Test
    fun `editing zelle instructions sends zelle alone`() {
        val edited = edit { d -> d.copy(options = d.options + ("zelle" to PaymentOptionDraft(false, "555 and the invoice number"))) }
        assertEquals(setOf("zelle"), sent(edited)!!.keys)
    }
    @Test
    fun `an untouched unknown stored id is not sent`() {
        val edited = edit { d -> d.copy(options = d.options + ("cash" to PaymentOptionDraft(true, "exact change"))) }
        val out = sent(edited)!!
        assertEquals(setOf("cash"), out.keys)
        assertFalse(out.containsKey("oldcoin"))
        assertNull(paymentOptionsSaveProblem(loaded, edited))
    }
    @Test
    fun `editing an unknown id is refused with the server sentence`() {
        val raw = (loaded.paymentOptions as Map<*, *>).toMutableMap().apply {
            put("oldcoin", mapOf("enabled" to false, "instructions" to ""))
        }
        val edited = loaded.copy(paymentOptions = raw)
        assertEquals("\"oldcoin\" is not a payment method.", paymentOptionsSaveProblem(loaded, edited))
        assertTrue(sent(edited)!!.containsKey("oldcoin"))
    }
    @Test
    fun `a save with no payment change sends nothing for paymentOptions`() {
        val edited = edit { it }
        assertFalse(businessSettingsFieldChanges(loaded, edited).containsKey("paymentOptions"))
        val handleOnly = edit { d -> d.copy(handles = d.handles + (PaymentHandleField.VENMO to "new-venmo")) }
        assertEquals(setOf("venmoHandle"), businessSettingsFieldChanges(loaded, handleOnly).keys)
    }
    @Test
    fun `explicit entries that match the defaults send nothing`() {
        val bare = BusinessSettings()
        val edited = bare.withPaymentDraft(paymentDraftOf(bare).copy(handles = mapOf(PaymentHandleField.VENMO to "x-venmo")))
        assertFalse(businessSettingsFieldChanges(bare, edited).containsKey("paymentOptions"))
        val toggled = bare.withPaymentDraft(
            paymentDraftOf(bare).let { it.copy(options = it.options + ("stripe" to PaymentOptionDraft(false, ""))) },
        )
        assertEquals(setOf("stripe"), (businessSettingsFieldChanges(bare, toggled)["paymentOptions"] as Map<*, *>).keys)
    }
    @Test
    fun `unknown ids are listed in stored order`() {
        assertEquals(listOf("oldcoin"), unknownPaymentMethodIds(stored))
        assertEquals(emptyList<String>(), unknownPaymentMethodIds(null))
    }
}
