package com.tribetails.auntieos.web.screens.directory

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** #1888: Invite to portal is off until the household's standing is known. */
class PortalInviteStandingTest {
    @Test fun `only an active primary counts as on the portal`() {
        assertTrue(decodeHasActivePrimary("""{"members":[{"role":"PRIMARY","status":"ACTIVE"}]}"""))
        assertFalse(decodeHasActivePrimary("""{"members":[{"role":"PRIMARY","status":"INVITED"}]}"""))
        assertFalse(decodeHasActivePrimary("""{"members":[{"role":"SECONDARY","status":"ACTIVE"}]}"""))
        assertFalse(decodeHasActivePrimary("""{"members":[]}"""))
    }

    @Test fun `a reply with no members is an error, never a no`() {
        assertFailsWith<IllegalStateException> { decodeHasActivePrimary("""{"ok":true}""") }
    }

    @Test fun `the button says where the household stands`() {
        assertEquals("Sending", portalInviteLabel(true, true, null))
        assertEquals("Checking portal…", portalInviteLabel(false, true, null))
        assertEquals("Already on the portal", portalInviteLabel(false, false, true))
        assertEquals("Invite to portal", portalInviteLabel(false, false, false))
        assertEquals("Invite to portal", portalInviteLabel(false, false, null))
    }
}
