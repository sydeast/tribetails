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
}
