package com.kinfolk.portal.error

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class ErrorEnvelopeTest {
    @Test
    fun opaque_builds_envelope_with_stable_opaque_message() {
        val env = ErrorEnvelope.opaque(IllegalStateException("internal: secret"))
        assertEquals("An error occurred. It's been reported to Auntie.", env.userMessage)
        assertNotNull(env.clientErrorId)
        assertTrue(env.clientErrorId.length >= 8)
    }
}
