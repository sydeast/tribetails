package com.kinfolk.portal.nav

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Pure model tests for the responsive shell chrome (TabRoute.kt). No Compose
 * runtime: destination sets, breakpoint, active-state resolution, account-menu
 * contents (incl. operator gating), and the avatar-initial fallback.
 */
class ShellNavTest {

    // ---- breakpoint ----

    @Test
    fun breakpoint_880dpAndUp_isWide() {
        assertTrue(isWideShell(880f))
        assertTrue(isWideShell(1440f))
    }

    @Test
    fun breakpoint_below880dp_isNarrow() {
        assertFalse(isWideShell(879.9f))
        assertFalse(isWideShell(360f))
    }

    // ---- destination sets ----

    @Test
    fun wideLinks_areHomeTribeScheduleInvoices_inOrder() {
        // KinTales was removed from the top nav; it now lives in the avatar menu
        // and the Tribe hub.
        assertEquals(
            listOf("Home", "Tribe", "Schedule", "Invoices"),
            ShellNav.wideLinks.map { it.label },
        )
    }

    @Test
    fun wideLinks_excludeKinTalesKinAccountNotifications() {
        assertFalse(ShellDestination.KinTales in ShellNav.wideLinks, "KinTales reachable via avatar menu / Tribe hub, not a wide link")
        assertFalse(ShellDestination.Kin in ShellNav.wideLinks, "Kin reachable via avatar menu, not a wide link")
        assertFalse(ShellDestination.Account in ShellNav.wideLinks)
        assertFalse(ShellDestination.Notifications in ShellNav.wideLinks)
    }

    @Test
    fun narrowTabs_areHomeTribeScheduleAccount_inOrder() {
        assertEquals(
            listOf(
                ShellDestination.Home,
                ShellDestination.Tribe,
                ShellDestination.Schedule,
                ShellDestination.Account,
            ),
            ShellNav.narrowTabs,
        )
    }

    @Test
    fun narrowTabs_useShortTabLabels() {
        // KinTales was removed from the narrow tab bar (lives in the avatar menu).
        assertEquals(
            listOf("Home", "Tribe", "Schedule", "Account"),
            ShellNav.narrowTabs.map { it.tabLabel },
        )
    }

    @Test
    fun narrowTabs_excludeKinTales() {
        assertFalse(ShellDestination.KinTales in ShellNav.narrowTabs, "KinTales reachable via avatar menu / Tribe hub, not a narrow tab")
    }

    @Test
    fun destinations_carryMatchingRouteInstancesAndClasses() {
        ShellDestination.entries.forEach { d ->
            assertTrue(
                d.routeClass.isInstance(d.route),
                "${d.name}: route instance should match its routeClass",
            )
        }
    }

    // ---- active-state resolution ----

    @Test
    fun resolveActive_picksTheMatchingDestination() {
        val active = resolveActiveDestination(ShellNav.wideLinks) { it == ScheduleRoute::class }
        assertEquals(ShellDestination.Schedule, active)
    }

    @Test
    fun resolveActive_wide_hasNoActiveLinkOnKinTalesRoute() {
        // KinTales is no longer a wide link, so it lights up nothing in the top nav.
        val active = resolveActiveDestination(ShellNav.wideLinks) { it == KinTalesRoute::class }
        assertNull(active, "KinTales is not a wide link, so nothing is active")
    }

    @Test
    fun resolveActive_isNullOnDetailDestinations() {
        val active = resolveActiveDestination(ShellNav.wideLinks) { it == KinDetailRoute::class }
        assertNull(active, "detail routes light up no primary link")
    }

    @Test
    fun resolveActive_narrowAccountTab_lightsUpOnAccountRoute() {
        val active = resolveActiveDestination(ShellNav.narrowTabs) { it == AccountRoute::class }
        assertEquals(ShellDestination.Account, active)
    }

    @Test
    fun resolveActive_wide_hasNoActiveLinkOnAccountRoute() {
        val active = resolveActiveDestination(ShellNav.wideLinks) { it == AccountRoute::class }
        assertNull(active, "Account is not a wide link, so nothing is active")
    }

    // ---- account menu ----

    @Test
    fun accountMenu_nonOperator_hasAccountTribeEditKinTalesNotificationsKinSignOut() {
        // TribeEdit and KinTales now live in the avatar menu (KinTales was pulled
        // out of the top nav into here + the Tribe hub).
        val menu = ShellNav.accountMenu(isOperator = false)
        assertEquals(
            listOf("Account", "Edit Tribe Profile", "KinTales", "Notifications", "The Kin", "Sign Out"),
            menu.map { it.label },
        )
        assertFalse(menu.any { it is AccountMenuItem.BackToDirectory })
    }

    @Test
    fun accountMenu_includesKinTales() {
        val menu = ShellNav.accountMenu(isOperator = false)
        assertTrue(
            menu.any { it is AccountMenuItem.Open && it.destination == ShellDestination.KinTales },
            "KinTales now lives in the avatar menu",
        )
    }

    @Test
    fun accountMenu_operator_includesBackToDirectoryBeforeSignOut() {
        val menu = ShellNav.accountMenu(isOperator = true)
        assertEquals(
            listOf("Account", "Edit Tribe Profile", "KinTales", "Notifications", "The Kin", "Back to Directory", "Sign Out"),
            menu.map { it.label },
        )
    }

    @Test
    fun accountMenu_openEntries_targetTheRightDestinations() {
        val opens = ShellNav.accountMenu(isOperator = false).filterIsInstance<AccountMenuItem.Open>()
        assertEquals(
            listOf(
                ShellDestination.Account,
                ShellDestination.TribeEdit,
                ShellDestination.KinTales,
                ShellDestination.Notifications,
                ShellDestination.Kin,
            ),
            opens.map { it.destination },
        )
    }

    // ---- chrome-destination guard (tab-switch save/restore gate) ----

    @Test
    fun chromeGuard_trueOnTabDestinations() {
        assertTrue(isShellChromeDestination { it == HomeRoute::class })
        assertTrue(isShellChromeDestination { it == ScheduleRoute::class })
        assertTrue(isShellChromeDestination { it == InvoicesRoute::class })
    }

    @Test
    fun chromeGuard_trueOnAvatarMenuDestinations() {
        assertTrue(isShellChromeDestination { it == AccountRoute::class })
        assertTrue(isShellChromeDestination { it == NotificationsRoute::class })
        assertTrue(isShellChromeDestination { it == TribeEditRoute::class })
        assertTrue(isShellChromeDestination { it == KinTalesRoute::class })
    }

    @Test
    fun chromeGuard_falseOnDetailAndWizardLeaves() {
        // Saving tab state from these routes corrupts the back stack (the
        // pill-tap navigation wedge) — the guard must pop clean instead.
        assertFalse(isShellChromeDestination { it == KinDetailRoute::class })
        assertFalse(isShellChromeDestination { it == KinAddEditRoute::class })
        assertFalse(isShellChromeDestination { it == InvoiceDetailRoute::class })
        assertFalse(isShellChromeDestination { it == KinCareDetailRoute::class })
        assertFalse(isShellChromeDestination { it == BookingEnvelopeRoute::class })
        assertFalse(isShellChromeDestination { it == BookingWizardRoute::class })
        assertFalse(isShellChromeDestination { it == MessageAuntieRoute::class })
    }

    @Test
    fun chromeGuard_falseWhenNothingMatches() {
        assertFalse(isShellChromeDestination { false })
    }

    // ---- avatar initial fallback ----

    @Test
    fun avatarInitial_usesFirstLetterUppercased() {
        assertEquals("J", avatarInitial("jordan"))
        assertEquals("T", avatarInitial("The Foster"))
    }

    @Test
    fun avatarInitial_skipsLeadingWhitespaceAndPunctuation() {
        assertEquals("F", avatarInitial("  'foster"))
        assertEquals("9", avatarInitial(" 9 Lives Tribe"))
    }

    @Test
    fun avatarInitial_fallsBackOnMissingName() {
        assertEquals("T", avatarInitial(null))
        assertEquals("T", avatarInitial(""))
        assertEquals("T", avatarInitial("   "))
        assertEquals("T", avatarInitial("!!!"))
    }
}
