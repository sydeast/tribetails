package com.tribetails.auntieos.util

import com.google.firebase.functions.FirebaseFunctionsException
import com.tribetails.auntieos.data.repository.operatorCopyOf
import io.mockk.every
import io.mockk.mockk
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** #1592: the walk's "updateInvoice validation failed" errors, and what must survive untouched. */
class CallableErrorTextTest {
    /** The SDK's constructors are Kotlin-internal, so a refusal is a mock, as elsewhere in this suite. */
    private fun refusal(message: String, code: FirebaseFunctionsException.Code, details: Any?): FirebaseFunctionsException =
        mockk<FirebaseFunctionsException>(relaxed = true).also {
            every { it.message } returns message
            every { it.code } returns code
            every { it.details } returns details
        }

    private val formSentence = "Something in this form was not accepted. Check what you entered and try again."

    @Test
    fun aValidationRefusalReadsAsASentence() {
        assertEquals(formSentence, plainCallableMessage("INVALID_ARGUMENT", "updateInvoice validation failed"))
        assertEquals(formSentence, plainCallableMessage("INVALID_ARGUMENT", "updateKinCareSession validation failed"))
        assertEquals(formSentence, plainCallableMessage("functions/invalid-argument", "updateInvoice validation failed [400]"))
        assertEquals(formSentence, plainCallableMessage("INVALID_ARGUMENT", " [400]"))
    }

    @Test
    fun aCodeNameReadsAsThatCodesSentence() {
        assertEquals(CALLABLE_FALLBACK_TEXT, plainCallableMessage("INTERNAL", "INTERNAL"))
        assertEquals("Your account is not allowed to do this.", plainCallableMessage("PERMISSION_DENIED", ""))
        assertEquals(CALLABLE_FALLBACK_TEXT, plainCallableMessage("UNKNOWN", null))
    }

    @Test
    fun anOperatorSentenceAndAMachineTokenAreKept() {
        assertEquals("This invoice is already paid.", plainCallableMessage("FAILED_PRECONDITION", "This invoice is already paid."))
        assertEquals("no_recipients", plainCallableMessage("FAILED_PRECONDITION", "no_recipients"))
    }

    @Test
    fun theRethrownRefusalKeepsCodeDetailsAndTheRawCause() {
        val details = mapOf("validationErrors" to listOf(mapOf("path" to "lineItems.0.unitPrice")))
        val raw = refusal("updateInvoice validation failed", FirebaseFunctionsException.Code.INVALID_ARGUMENT, details)
        val notes = mutableListOf<String>()
        val shown = operatorCopyOf(raw) { notes += it } as FirebaseFunctionsException

        assertEquals(formSentence, shown.message)
        assertEquals(FirebaseFunctionsException.Code.INVALID_ARGUMENT, shown.code)
        assertSame(details, shown.details)
        assertSame(raw, shown.cause)
        assertFalse(shown.message!!.contains("updateInvoice"))
        assertTrue("the raw text is kept for triage", notes.single().contains("updateInvoice validation failed"))
    }

    @Test
    fun anythingElseIsRethrownAsItCame() {
        val operatorWorded = refusal("This invoice is already paid.", FirebaseFunctionsException.Code.FAILED_PRECONDITION, null)
        assertSame(operatorWorded, operatorCopyOf(operatorWorded) { error("no note expected") })
        val other = IllegalStateException("boom")
        assertSame(other, operatorCopyOf(other) { error("no note expected") })
    }
}
