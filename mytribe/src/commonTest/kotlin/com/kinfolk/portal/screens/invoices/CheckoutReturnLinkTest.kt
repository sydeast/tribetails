package com.kinfolk.portal.screens.invoices

import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #2401: the link that brings a household back into this app after paying by
 * card. Two shapes are read, the https address this app claims and the app's
 * own scheme, and nothing else is. Whatever the link says, it only names an
 * invoice to open and whether to check it; `CheckoutReturnTest` covers what
 * the app then does.
 */
class CheckoutReturnLinkTest {
    @BeforeTest
    fun nothingWaiting() {
        PendingCheckoutReturn.clear()
        PendingCheckoutReturn.onAccount(null)
    }
    @AfterTest
    fun leaveNothingWaiting() {
        PendingCheckoutReturn.clear()
        PendingCheckoutReturn.onAccount(null)
    }

    private fun https(vararg path: String, checkout: String? = null, host: String = "kinfolk.tribetails.com") =
        checkoutReturnFromLink(scheme = "https", host = host, pathSegments = path.toList(), checkout = checkout)

    private fun own(vararg path: String, checkout: String? = null, host: String = "invoices") =
        checkoutReturnFromLink(scheme = "mytribe", host = host, pathSegments = path.toList(), checkout = checkout)

    @Test
    fun `the address this app sends Stripe reads back as the invoice it was sent for`() {
        // What `checkoutReturnUrls` builds, taken apart the way Android hands it over.
        val (success, cancel) = checkoutReturnUrls("inv-1")
        assertEquals("https://kinfolk.tribetails.com/app/invoices/inv-1?checkout=done", success)
        assertEquals("https://kinfolk.tribetails.com/app/invoices/inv-1", cancel)
        assertEquals(CheckoutReturn("inv-1", finished = true), https("app", "invoices", "inv-1", checkout = "done"))
        assertEquals(CheckoutReturn("inv-1", finished = false), https("app", "invoices", "inv-1"))
    }

    @Test
    fun `the app's own scheme reads the same way`() {
        assertEquals(CheckoutReturn("inv-1", finished = true), own("inv-1", checkout = "done"))
        assertEquals(CheckoutReturn("inv-1", finished = false), own("inv-1"))
    }

    @Test
    fun `only exactly checkout=done is a finished checkout`() {
        for (value in listOf(null, "", "DONE", "done ", "true", "1", "cancelled", "done&x=1")) {
            assertEquals(
                CheckoutReturn("inv-1", finished = false),
                https("app", "invoices", "inv-1", checkout = value),
                "checkout=$value must not start a payment check",
            )
        }
    }

    @Test
    fun `any other host, scheme or path is not a return link`() {
        // Plain http, and hosts that only look like the portal.
        assertNull(checkoutReturnFromLink("http", "kinfolk.tribetails.com", listOf("app", "invoices", "inv-1"), "done"))
        assertNull(https("app", "invoices", "inv-1", checkout = "done", host = "tribetails.com"))
        assertNull(https("app", "invoices", "inv-1", checkout = "done", host = "kinfolk.tribetails.com.evil.example"))
        assertNull(https("app", "invoices", "inv-1", checkout = "done", host = "evil.example"))
        assertNull(checkoutReturnFromLink(null, null, listOf("app", "invoices", "inv-1"), "done"))
        assertNull(checkoutReturnFromLink("HTTPS", "kinfolk.tribetails.com", listOf("app", "invoices", "inv-1"), "done"))
        // The web portal's own invoice page is the web portal's, not this app's.
        assertNull(https("invoices", "inv-1", checkout = "done"))
        // Anything before, between or after the three parts.
        assertNull(https("app", "invoices"))
        assertNull(https("app", "invoices", "inv-1", "pay"))
        assertNull(https("x", "app", "invoices", "inv-1"))
        assertNull(https("app", "kin", "inv-1"))
        assertNull(https("App", "Invoices", "inv-1"))
        assertNull(https())
        // The own scheme: only `mytribe://invoices/<id>`.
        assertNull(own("inv-1", checkout = "done", host = "claim"))
        assertNull(own("inv-1", "extra"))
        assertNull(own())
        assertNull(checkoutReturnFromLink("mytribe", null, listOf("invoices", "inv-1"), "done"))
        assertNull(checkoutReturnFromLink("othertribe", "invoices", listOf("inv-1"), "done"))
    }

    @Test
    fun `an id that is blank, too long or shaped like a path is refused`() {
        // Android hands over DECODED path parts, so an encoded slash arrives as a slash.
        for (bad in listOf("", " ", "a/b", "a\\b", "a?b", "a#b", "a b", "a\tb", "a\nb", "a\u0000b", "x".repeat(201))) {
            assertNull(https("app", "invoices", bad, checkout = "done"), "id '$bad' must be refused")
            assertNull(own(bad, checkout = "done"), "id '$bad' must be refused in the own scheme")
        }
        assertEquals(CheckoutReturn("x".repeat(200), finished = false), https("app", "invoices", "x".repeat(200)))
        assertEquals(CheckoutReturn("INV-2027_0042.a~b", finished = true), own("INV-2027_0042.a~b", checkout = "done"))
    }

    @Test
    fun `surrounding space on an id is trimmed, not carried into the lookup`() {
        assertEquals(CheckoutReturn("inv-1", finished = true), https("app", "invoices", " inv-1 ", checkout = "done"))
    }

    // ── the link waiting to be opened ──

    @Test
    fun `a waiting link is taken exactly once`() {
        val link = CheckoutReturn("inv-1", finished = true)
        PendingCheckoutReturn.offer(link)
        assertEquals(link, PendingCheckoutReturn.pending.value)
        assertTrue(PendingCheckoutReturn.isWaitingFor("inv-1"))
        assertFalse(PendingCheckoutReturn.isWaitingFor("inv-2"))
        assertEquals(link, PendingCheckoutReturn.take())
        assertNull(PendingCheckoutReturn.take())
        assertNull(PendingCheckoutReturn.pending.value)
        assertFalse(PendingCheckoutReturn.isWaitingFor("inv-1"))
    }

    @Test
    fun `a newer link replaces one that never opened`() {
        PendingCheckoutReturn.offer(CheckoutReturn("inv-1", finished = true))
        PendingCheckoutReturn.offer(CheckoutReturn("inv-2", finished = false))
        assertEquals(CheckoutReturn("inv-2", finished = false), PendingCheckoutReturn.take())
    }

    @Test
    fun `a link that arrives while signed out waits through sign-in`() {
        PendingCheckoutReturn.onAccount(null)
        PendingCheckoutReturn.offer(CheckoutReturn("inv-1", finished = true))
        PendingCheckoutReturn.onAccount("uidA")
        assertEquals(CheckoutReturn("inv-1", finished = true), PendingCheckoutReturn.take())
    }

    @Test
    fun `the same account being confirmed again keeps the link`() {
        PendingCheckoutReturn.onAccount("uidA")
        PendingCheckoutReturn.offer(CheckoutReturn("inv-1", finished = true))
        PendingCheckoutReturn.onAccount("uidA")
        assertEquals(CheckoutReturn("inv-1", finished = true), PendingCheckoutReturn.take())
    }

    @Test
    fun `signing out drops a link that has not opened`() {
        PendingCheckoutReturn.onAccount("uidA")
        PendingCheckoutReturn.offer(CheckoutReturn("inv-1", finished = true))
        PendingCheckoutReturn.onAccount(null)
        assertNull(PendingCheckoutReturn.pending.value)
        PendingCheckoutReturn.onAccount("uidB")
        assertNull(PendingCheckoutReturn.take())
    }

    @Test
    fun `another person signing in on the same phone does not get the link`() {
        PendingCheckoutReturn.onAccount("uidA")
        PendingCheckoutReturn.offer(CheckoutReturn("inv-1", finished = true))
        PendingCheckoutReturn.markAnswered("inv-7")
        PendingCheckoutReturn.onAccount("uidB")
        assertNull(PendingCheckoutReturn.take())
        assertFalse(PendingCheckoutReturn.wasAnswered("inv-7"))
    }

    @Test
    fun `clear drops the link and what was answered`() {
        PendingCheckoutReturn.offer(CheckoutReturn("inv-1", finished = true))
        PendingCheckoutReturn.markAnswered("inv-1")
        PendingCheckoutReturn.clear()
        assertNull(PendingCheckoutReturn.take())
        assertFalse(PendingCheckoutReturn.wasAnswered("inv-1"))
    }

    @Test
    fun `an answered link answers only for its own invoice, and only until that invoice is handed off again`() {
        assertFalse(PendingCheckoutReturn.wasAnswered("inv-1"))
        PendingCheckoutReturn.markAnswered("inv-1")
        assertTrue(PendingCheckoutReturn.wasAnswered("inv-1"))
        assertFalse(PendingCheckoutReturn.wasAnswered("inv-2"))
        // Another invoice going to checkout changes nothing for this one.
        PendingCheckoutReturn.handedOff("inv-2")
        assertTrue(PendingCheckoutReturn.wasAnswered("inv-1"))
        PendingCheckoutReturn.handedOff("inv-1")
        assertFalse(PendingCheckoutReturn.wasAnswered("inv-1"))
    }
}
