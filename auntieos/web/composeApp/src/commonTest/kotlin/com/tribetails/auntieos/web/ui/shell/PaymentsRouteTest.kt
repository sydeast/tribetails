package com.tribetails.auntieos.web.ui.shell

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

/**
 * #11: the standalone Payments screen was removed (payment info now lives on the paid
 * invoice's detail). Pin that the old `#/payments` deep link no longer resolves to a
 * screen, falls back to Home with a fail-loud route warning, and that no Payments
 * destination lingers in the nav enum.
 */
class PaymentsRouteTest {

    @Test
    fun paymentsSlugNoLongerResolves_fallsBackToHome() {
        assertEquals(Destination.Home, parseHash("#/payments").dest)
        // The dead link is surfaced (fail loud), not silently swallowed.
        assertNotNull(routeWarning("#/payments"))
    }

    @Test
    fun noPaymentsDestinationInNav() {
        assertEquals(emptyList(), Destination.entries.filter { it.name == "Payments" })
    }
}
