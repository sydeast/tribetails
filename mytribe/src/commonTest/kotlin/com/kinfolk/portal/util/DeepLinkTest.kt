package com.kinfolk.portal.util

import com.kinfolk.portal.auth.EmailAction
import kotlin.test.Test
import kotlin.test.assertEquals

/** #1018 item 3: the claim link shown in place of the old "Invite sent." */
class DeepLinkTest {

    @Test
    fun `claimInviteUrl builds the portal host's claim link with the invite id as a query param`() {
        assertEquals(
            "https://${EmailAction.PORTAL_HOST}/claim?invite=i1",
            claimInviteUrl("i1"),
        )
    }
}
