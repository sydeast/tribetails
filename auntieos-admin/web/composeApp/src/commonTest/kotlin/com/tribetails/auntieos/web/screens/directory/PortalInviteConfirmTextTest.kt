package com.tribetails.auntieos.web.screens.directory

import kotlin.test.Test
import kotlin.test.assertTrue

/** #1602: Invite to portal fired on one click with no recipient shown. */
class PortalInviteConfirmTextTest {
    @Test
    fun theAskNamesTheHouseholdAndTheAddress() {
        val text = portalInviteConfirmText("Dre East", " catch@hanasamku.com ")
        assertTrue(text.startsWith("Send Dre East's portal claim link to catch@hanasamku.com?"))
        assertTrue(text.contains("expires in 14 days"))
    }

    @Test
    fun aBlankNameStillReadsAsASentence() {
        assertTrue(portalInviteConfirmText("", "catch@hanasamku.com").startsWith("Send this household's"))
    }
}
