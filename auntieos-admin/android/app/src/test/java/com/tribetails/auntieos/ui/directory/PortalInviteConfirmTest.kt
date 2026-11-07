package com.tribetails.auntieos.ui.directory

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1602: Invite to portal fired on one click, with no recipient shown. The
 * profile now asks first and names the address it will mail.
 */
class PortalInviteConfirmTest {

    @Test
    fun theAskNamesTheHouseholdAndTheAddress() {
        val text = portalInviteConfirmText("Dre East", " catch@hanasamku.com ")
        assertTrue(text.startsWith("Send Dre East's portal claim link to catch@hanasamku.com?"))
        assertTrue(text.contains("expires in 14 days"))
    }

    @Test
    fun aBlankNameStillReadsAsASentence() {
        assertTrue(portalInviteConfirmText(" ", "catch@hanasamku.com").startsWith("Send this household's"))
    }

    @Test
    fun theButtonIsOffWithNoEmailOrAnActivePrimary() {
        assertEquals("No email on file, so there is nobody to invite.", portalInviteBlocker("", null))
        assertEquals("Already on the portal.", portalInviteBlocker("catch@hanasamku.com", true))
        assertNull(portalInviteBlocker("catch@hanasamku.com", false))
        assertNull(portalInviteBlocker("catch@hanasamku.com", null))
    }
}
