package com.kinfolk.portal.util

import android.net.Uri
import com.kinfolk.portal.screens.invoices.CheckoutReturn
import com.kinfolk.portal.screens.invoices.checkoutReturnUrls
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #2401: the address Stripe returns a card payment to, read off a real
 * `android.net.Uri` the way `MainActivity` gets it from the launch intent.
 *
 * The rules themselves are `CheckoutReturnLinkTest`'s, in common code. This
 * covers the one step that only exists on Android: taking the URI apart. An
 * encoded id has to arrive decoded, an encoded slash has to arrive as a slash
 * (and so be refused), and a URI with no `//` must be refused before the query
 * read that would throw on it.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CheckoutReturnUriTest {

    private fun read(url: String): CheckoutReturn? = checkoutReturnOf(Uri.parse(url))

    @Test
    fun theTwoAddressesThisAppSendsStripeReadBackAsTheirInvoice() {
        val (success, cancel) = checkoutReturnUrls("inv-1")
        assertEquals(CheckoutReturn("inv-1", finished = true), read(success))
        assertEquals(CheckoutReturn("inv-1", finished = false), read(cancel))
    }

    @Test
    fun anIdTheAppHadToEncodeReadsBackAsTheIdItWas() {
        val (success, _) = checkoutReturnUrls("INV-2027_0042.a~b")
        assertEquals(CheckoutReturn("INV-2027_0042.a~b", finished = true), read(success))
        assertEquals(CheckoutReturn("Ünïcode", finished = true), read(checkoutReturnUrls("Ünïcode").first))
    }

    @Test
    fun theAppsOwnSchemeReadsTheSameWay() {
        assertEquals(CheckoutReturn("inv-1", finished = true), read("mytribe://invoices/inv-1?checkout=done"))
        assertEquals(CheckoutReturn("inv-1", finished = false), read("mytribe://invoices/inv-1"))
    }

    @Test
    fun otherQueryKeysChangeNothingAndOnlyCheckoutDoneIsAFinishedCheckout() {
        assertEquals(
            CheckoutReturn("inv-1", finished = true),
            read("https://kinfolk.tribetails.com/app/invoices/inv-1?utm_source=x&checkout=done"),
        )
        assertEquals(
            CheckoutReturn("inv-1", finished = false),
            read("https://kinfolk.tribetails.com/app/invoices/inv-1?checkout=cancelled"),
        )
        assertEquals(
            CheckoutReturn("inv-1", finished = false),
            read("https://kinfolk.tribetails.com/app/invoices/inv-1?paid=done"),
        )
    }

    @Test
    fun anEncodedSlashOrSpaceInTheIdIsRefusedNotOpened() {
        assertNull(read("https://kinfolk.tribetails.com/app/invoices/a%2Fb?checkout=done"))
        assertNull(read("https://kinfolk.tribetails.com/app/invoices/a%20b?checkout=done"))
        assertNull(read("mytribe://invoices/a%2Fb?checkout=done"))
        // What the app builds for such an id never comes back as a return.
        assertNull(read(checkoutReturnUrls("INV 2027/1").first))
    }

    @Test
    fun linksThatAreNotACheckoutReturnAreLeftToTheOtherReaders() {
        assertNull(read("https://kinfolk.tribetails.com/invoices/inv-1?checkout=done"))
        assertNull(read("https://kinfolk.tribetails.com/app/invoices/"))
        assertNull(read("https://kinfolk.tribetails.com/app/invoices/inv-1/extra"))
        assertNull(read("https://kinfolk.tribetails.com/claim/inv-1"))
        assertNull(read("https://kinfolk.tribetails.com/share/tok"))
        assertNull(read("http://kinfolk.tribetails.com/app/invoices/inv-1?checkout=done"))
        assertNull(read("https://evil.example/app/invoices/inv-1?checkout=done"))
        assertNull(read("https://kinfolk.tribetails.com@evil.example/app/invoices/inv-1?checkout=done"))
        assertNull(read("mytribe://claim/inv-1"))
        assertNull(read("mytribe://share/tok"))
    }

    @Test
    fun aLinkWithNoDoubleSlashOrNoneAtAllIsRefusedWithoutThrowing() {
        assertNull(read("mytribe:invoices/inv-1?checkout=done"))
        assertNull(read("mailto:catch@hanasamku.com"))
        assertNull(checkoutReturnOf(null))
    }

    /**
     * The claim, share and email links are kept for the life of the process
     * and win over the signed-in shell in every new copy of the app's screen.
     * A return link has to clear them, or a household who opened a shared
     * KinTale earlier would come back from paying to that KinTale.
     */
    @Test
    fun aReturnLinkReplacesTheLaunchLinksFromEarlierInTheRun() {
        androidInitialClaimInviteId = "invite-1"
        androidInitialShareToken = "share-1"
        androidInitialSecureResetParams = SecureResetParams(oobCode = "code-1")
        try {
            forgetEarlierLaunchLinks()
            assertNull(readInitialClaimInviteId())
            assertNull(readInitialShareToken())
            assertNull(readInitialSecureResetParams())
        } finally {
            androidInitialClaimInviteId = null
            androidInitialShareToken = null
            androidInitialSecureResetParams = null
        }
    }
}
