package com.kinfolk.portal.screens.claim

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ClaimFlowTest {

    private val valid = InvitePreview("valid", "kin@example.com", "The Parkers")

    @Test
    fun signedOutValidInviteCollectsPassword() {
        val step = stepForPreview(valid, signedIn = false, signedInEmail = null)
        assertEquals(ClaimStep.CreateAccount("kin@example.com", "The Parkers"), step)
    }

    @Test
    fun signedInMatchingEmailAutoAccepts() {
        val step = stepForPreview(valid, signedIn = true, signedInEmail = "Kin@Example.com")
        assertEquals(ClaimStep.AutoAccept("kin@example.com"), step)
    }

    @Test
    fun signedInDifferentEmailIsWrongAccount() {
        val step = stepForPreview(valid, signedIn = true, signedInEmail = "auntie@tribetails.com")
        assertEquals(ClaimStep.WrongAccount("kin@example.com", "auntie@tribetails.com"), step)
    }

    @Test
    fun signedInWithoutEmailIsWrongAccount() {
        val step = stepForPreview(valid, signedIn = true, signedInEmail = null)
        assertIs<ClaimStep.WrongAccount>(step)
    }

    @Test
    fun claimedExpiredRevokedNotFoundAreTerminal() {
        for (status in listOf("claimed", "expired", "revoked", "not_found", "garbage")) {
            val step = stepForPreview(InvitePreview(status), signedIn = false, signedInEmail = null)
            assertIs<ClaimStep.InviteInvalid>(step, "status=$status")
        }
    }

    @Test
    fun emailExistsDetectionCoversRestAndJsSdkShapes() {
        assertTrue(isEmailAlreadyInUse("EMAIL_EXISTS"))
        assertTrue(isEmailAlreadyInUse("Firebase: Error (auth/email-already-in-use)."))
        assertFalse(isEmailAlreadyInUse("WEAK_PASSWORD"))
        assertFalse(isEmailAlreadyInUse(null))
    }

    @Test
    fun passwordValidation() {
        assertEquals("Password needs at least 8 characters.", validateNewPassword("short", "short"))
        assertEquals("Passwords don't match.", validateNewPassword("longenough", "different"))
        assertNull(validateNewPassword("longenough", "longenough"))
    }

    /**
     * RULING: "secondary needs email verification as well." `acceptInvite`
     * refuses an unverified invitee with an actionable failed-precondition. The
     * claim screen must not confuse that with the dead-invite failed-precondition:
     * one is "confirm and come back", the other is "this link is finished".
     */
    @Test
    fun isEmailUnverified_detectsTheVerificationRefusalOnly() {
        assertTrue(
            isEmailUnverified(
                "functions/failed-precondition Verify jane@example.com before joining. " +
                    "We just emailed a verification link to that address.",
            ),
        )
        // FOLLOWUPS #16: the refusal has two wordings now, because a suppressed
        // send is reported back to the handler and the message stopped claiming
        // a mail that never left. This screen prints the server message
        // verbatim, so both wordings have to route to the confirm-your-email
        // heading rather than "Invite couldn't be accepted".
        assertTrue(
            isEmailUnverified(
                "functions/failed-precondition Verify jane@example.com before joining. " +
                    "We could not send the verification email just now.",
            ),
        )
        assertFalse(isEmailUnverified("functions/failed-precondition invite no longer valid"))
        assertFalse(isEmailUnverified("functions/failed-precondition invite expired"))
        assertFalse(isEmailUnverified("functions/permission-denied invite email mismatch"))
        assertFalse(isEmailUnverified(null))
    }
}
