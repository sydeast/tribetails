package com.kinfolk.portal.portal
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
/** #1326: the same rule as portal web's lib/inviteEmail.ts. */
class InviteEmailTest {
    @Test
    fun acceptsRealAddresses_trimmedAndInAnyCase() {
        assertTrue(isInvitableEmail("catch@hanasamku.com"))
        assertTrue(isInvitableEmail("  Pawsome@Hanasamku.COM "))
    }
    @Test
    fun refusesWhatTheQaWalkTyped_andWhatTheServerWouldRefuse() {
        for (bad in listOf("bad-email", "catch@", "@hanasamku.com", "catch@hanasamku", "catch @hanasamku.com", "catch@hanasamku..com")) {
            assertFalse(isInvitableEmail(bad), bad)
        }
    }
    @Test
    fun saysWhyOnlyOnceSomethingIsTyped() {
        assertNull(inviteEmailProblem(""))
        assertNull(inviteEmailProblem("   "))
        assertNull(inviteEmailProblem("catch@hanasamku.com"))
        assertEquals(INVALID_INVITE_EMAIL_MESSAGE, inviteEmailProblem("bad-email"))
    }
}
