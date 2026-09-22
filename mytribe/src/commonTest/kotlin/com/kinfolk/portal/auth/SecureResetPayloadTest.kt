package com.kinfolk.portal.auth

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * #905: the body the app posts to `confirmSecureReset`, and what it makes of
 * the answer.
 *
 * PR #903 made the server derive the account from the oobCode, and the web page
 * posts exactly `oobCode`, `newPassword` and `userAgent`. The app posts the same
 * three keys, so an address in a link can never reach the incident record.
 */
class SecureResetPayloadTest {

    @Test
    fun theBodyIsTheThreeKeysWebPosts() {
        assertEquals(
            """{"oobCode":"abc","newPassword":"hunter2hunter2","userAgent":"MyTribe-Android/34"}""",
            secureResetPayload("abc", "hunter2hunter2", "MyTribe-Android/34"),
        )
    }

    @Test
    fun theBodyCarriesNoEmail() {
        assertTrue("email" !in secureResetPayload("abc", "pw", "ua"))
    }

    @Test
    fun quotesAndControlCharactersAreEscaped() {
        assertEquals(
            """{"oobCode":"a\"b\\c","newPassword":"line\nbreak","userAgent":"tab\there"}""",
            secureResetPayload("a\"b\\c", "line\nbreak", "tab\there"),
        )
    }

    @Test
    fun a200ReturnsTheIncidentId() {
        assertEquals("inc_1", secureResetResult(200, """{"ok":true,"incidentId":"inc_1"}"""))
    }

    /** A 200 with no id means the outcome is unknown; it must not read as success. */
    @Test
    fun a200WithNoIncidentIdStillFails() {
        val e = assertFailsWith<SecureResetException> { secureResetResult(200, """{"ok":true}""") }
        assertEquals(
            "We couldn't confirm your account was secured. Try signing in with your new password.",
            e.message,
        )
    }

    @Test
    fun eachServerErrorGetsItsOwnAnswer() {
        val cases = listOf(
            Triple(429, """{"error":"rate_limited"}""", "Too many attempts for this account today. Try again tomorrow."),
            Triple(400, """{"error":"password_too_short"}""", "Password needs at least 8 characters."),
            Triple(400, """{"error":"missing_required"}""", "Type a new password in both boxes, then try again."),
            Triple(
                400,
                """{"error":"reset_failed","detail":"wrong_code_type"}""",
                "This link can't be used to reset a password.",
            ),
            Triple(
                400,
                """{"error":"reset_failed","detail":"INVALID_OOB_CODE"}""",
                "This reset link has expired or has already been used. Go back and send a new link.",
            ),
            Triple(
                502,
                """{"error":"outcome_unknown","incidentId":"inc_9"}""",
                "We couldn't confirm your password changed. Try signing in with your new password. " +
                    "Tribe Tails has been alerted.",
            ),
            Triple(502, """{"error":"upstream"}""", "We couldn't reach the sign-in service. Check your connection and try again."),
            Triple(503, "", "Securing accounts isn't available right now. Try again in a few minutes."),
            Triple(418, "", "We couldn't secure your account (error 418). Try again in a moment."),
        )
        for ((status, body, expected) in cases) {
            val e = assertFailsWith<SecureResetException>("status $status") { secureResetResult(status, body) }
            assertEquals(expected, e.message, "status $status")
        }
    }
}
