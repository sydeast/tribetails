package com.kinfolk.portal.screens.account

import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * #2427: the address Stripe returns a card setup to, read back as a return,
 * and the holder that keeps it until Account Settings can open.
 */
class CardSetupReturnTest {
    @AfterTest
    fun leaveNothingWaiting() {
        PendingCardSetupReturn.onAccount(null)
        PendingCardSetupReturn.clear()
    }

    private fun https(vararg path: String, billing: String? = null) =
        cardSetupReturnFromLink("https", "kinfolk.tribetails.com", path.toList(), billing)

    @Test
    fun theTwoAddressesThisAppSendsStripe_areOnThePortalUnderApp() {
        val (success, cancel) = cardSetupReturnUrls()
        assertEquals("https://kinfolk.tribetails.com/app/account?billing=saved", success)
        assertEquals("https://kinfolk.tribetails.com/app/account", cancel)
    }

    @Test
    fun theSuccessAndCancelAddressesReadBack() {
        assertEquals(CardSetupReturn(saved = true), https("app", "account", billing = "saved"))
        assertEquals(CardSetupReturn(saved = false), https("app", "account"))
        assertEquals(CardSetupReturn(saved = false), https("app", "account", billing = "nope"))
    }

    @Test
    fun theAppsOwnSchemeReadsTheSameWay() {
        assertEquals(CardSetupReturn(saved = true), cardSetupReturnFromLink("mytribe", "account", emptyList(), "saved"))
        assertEquals(CardSetupReturn(saved = false), cardSetupReturnFromLink("mytribe", "account", emptyList(), null))
    }

    @Test
    fun anythingElseIsNotACardSetupReturn() {
        // The web portal's own Account page stays the browser's.
        assertNull(https("account", billing = "saved"))
        assertNull(https("app", "account", "extra"))
        assertNull(https("x", "app", "account"))
        assertNull(https("app"))
        assertNull(https("account", "secure-reset"))
        assertNull(cardSetupReturnFromLink("http", "kinfolk.tribetails.com", listOf("app", "account"), "saved"))
        assertNull(cardSetupReturnFromLink("https", "evil.example", listOf("app", "account"), "saved"))
        assertNull(cardSetupReturnFromLink("mytribe", "account", listOf("x"), "saved"))
        assertNull(cardSetupReturnFromLink("mytribe", "invoices", emptyList(), "saved"))
        assertNull(cardSetupReturnFromLink(null, null, emptyList(), null))
    }

    @Test
    fun aWaitingReturnIsTakenOnce() {
        PendingCardSetupReturn.offer(CardSetupReturn(saved = true))
        assertEquals(CardSetupReturn(saved = true), PendingCardSetupReturn.take())
        assertNull(PendingCardSetupReturn.take())
    }

    @Test
    fun aReturnWaitsThroughSignInButNotForSomeoneElse() {
        PendingCardSetupReturn.onAccount("uidA")
        PendingCardSetupReturn.offer(CardSetupReturn(saved = true))
        PendingCardSetupReturn.onAccount(null)
        assertNull(PendingCardSetupReturn.pending.value, "a sign-out drops it")

        PendingCardSetupReturn.offer(CardSetupReturn(saved = true))
        PendingCardSetupReturn.onAccount("uidB")
        assertEquals(CardSetupReturn(saved = true), PendingCardSetupReturn.take(), "a first sign-in after the link arrived keeps it")
    }
}
