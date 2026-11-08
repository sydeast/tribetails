package com.tribetails.auntieos.web.data

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** #1592: a callable refusal reaches the operator as a sentence, never a function name or status. */
class CallableErrorTextTest {
    private val formSentence = "Something in this form was not accepted. Check what you entered and try again."

    @Test
    fun theWalksRefusalsReadAsASentence() {
        assertEquals(formSentence, plainCallableMessage("INVALID_ARGUMENT", "updateInvoice validation failed"))
        assertEquals(formSentence, plainCallableMessage("INVALID_ARGUMENT", "updateKinCareSession validation failed"))
        assertEquals(formSentence, plainCallableMessage("INVALID_ARGUMENT", "updateInvoice validation failed [400]"))
    }

    @Test
    fun anOperatorSentenceAndAMachineTokenAreKept() {
        assertEquals("This invoice is already paid.", plainCallableMessage("FAILED_PRECONDITION", "This invoice is already paid."))
        assertEquals("no_recipients", plainCallableMessage("FAILED_PRECONDITION", "no_recipients"))
    }

    @Test
    fun aRefusalKeepsItsStatusAndCodeAndLogsTheRawText() {
        val logged = mutableListOf<String>()
        val reply = refusedReply(
            name = "updateInvoice",
            status = "INVALID_ARGUMENT",
            rawMessage = "updateInvoice validation failed",
            code = null,
            httpStatus = 400,
            log = { logged += it },
        )
        assertEquals(formSentence, reply.message)
        assertEquals("INVALID_ARGUMENT", reply.status)
        assertFalse(reply.message.contains("updateInvoice"))
        assertTrue(logged.single().contains("updateInvoice validation failed"))
    }

    @Test
    fun aRefusalWithNoMessageNoLongerReadsCallable400() {
        val reply = refusedReply("updateInvoice", status = null, rawMessage = null, code = null, httpStatus = 400, log = {})
        assertEquals(CALLABLE_FALLBACK_TEXT, reply.message)
    }

    @Test
    fun anOperatorWordedRefusalIsPassedThroughUnlogged() {
        val reply = refusedReply(
            "recordPayment", "FAILED_PRECONDITION", "This invoice is already paid.", "already_paid", 400,
            log = { error("nothing to log") },
        )
        assertEquals("This invoice is already paid.", reply.message)
        assertEquals("already_paid", reply.code)
    }
}
