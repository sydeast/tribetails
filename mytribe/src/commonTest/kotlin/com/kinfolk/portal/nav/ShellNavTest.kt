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

    /** #1435: the same six links, in the same order, as web's desktop NAV_LINKS. */
    @Test
    fun wideLinks_areHomeTribeScheduleKinTalesInvoicesMessages_inOrder() {
        assertEquals(
            listOf("Home", "Tribe", "Schedule", "KinTales", "Invoices", "Messages"),
            ShellNav.wideLinks.map { it.label },
        )
    }

    /** #1005: no Invoices link for a member without billing access; the rest unchanged. */
    @Test
    fun wideLinksFor_dropsInvoicesOnlyWithoutBillingAccess() {
        assertEquals(ShellNav.wideLinks, ShellNav.wideLinksFor(billingAccess = true))
        assertEquals(
            listOf(
                ShellDestination.Home,
                ShellDestination.Tribe,
                ShellDestination.Schedule,
                ShellDestination.KinTales,
                ShellDestination.Messages,
            ),
            ShellNav.wideLinksFor(billingAccess = false),
        )
        assertFalse(ShellDestination.Invoices in ShellNav.narrowTabs, "Invoices is not a narrow tab to hide")
    }

    @Test
    fun wideLinks_excludeKinAccountNotifications() {
        assertFalse(ShellDestination.Kin in ShellNav.wideLinks, "Kin is reached from Tribe, not a wide link")
        assertFalse(ShellDestination.Account in ShellNav.wideLinks)
        assertFalse(ShellDestination.Notifications in ShellNav.wideLinks)
    }

    /** #1413 (operator ruling on #1295): Messages takes Account's slot, Tales joins the bar. */
    @Test
    fun narrowTabs_areHomeTribeScheduleTalesMessages_inOrder() {
        assertEquals(
            listOf(
                ShellDestination.Home,
                ShellDestination.Tribe,
                ShellDestination.Schedule,
                ShellDestination.KinTales,
                ShellDestination.Messages,
            ),
            ShellNav.narrowTabs,
        )
    }

    @Test
    fun narrowTabs_useShortTabLabels_matchingTheWebTabBar() {
        // The same five labels as PortalNav.tsx TAB_ITEMS, so mobile web and
        // Android read alike.
        assertEquals(
            listOf("Home", "Tribe", "Schedule", "Tales", "Messages"),
            ShellNav.narrowTabs.map { it.tabLabel },
        )
    }

    @Test
    fun narrowTabs_excludeAccount_whichLivesInTheAvatarMenu() {
        assertFalse(ShellDestination.Account in ShellNav.narrowTabs, "Account is reached from the avatar menu, not a narrow tab (#1413)")
        assertTrue(
            ShellNav.accountMenu(isOperator = false, billingAccess = false).any { it is AccountMenuItem.Open && it.destination == ShellDestination.Account },
            "Account must still be reachable from the avatar menu",
        )
    }

    @Test
    fun messagesDestination_routesToMessageAuntie() {
        assertEquals(MessageAuntieRoute, ShellDestination.Messages.route)
        assertEquals(MessageAuntieRoute::class, ShellDestination.Messages.routeClass)
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

    /** #1420: the Messages route lights up its wide link, and the avatar menu does not repeat it. */
    @Test
    fun resolveActive_wide_picksMessagesOnMessageAuntieRoute() {
        assertEquals(ShellDestination.Messages, resolveActiveDestination(ShellNav.wideLinks) { it == MessageAuntieRoute::class })
        assertEquals(
            ShellDestination.Messages,
            resolveActiveDestination(ShellNav.wideLinksFor(billingAccess = false)) { it == MessageAuntieRoute::class },
        )
        assertFalse(
            ShellNav.accountMenu(isOperator = true, billingAccess = true).any { it is AccountMenuItem.Open && it.destination == ShellDestination.Messages },
            "Messages is a wide link, not a menu item",
        )
    }

    /**
     * #1435: the tales list and an open tale (KinTalesRoute with a taleId) share
     * one route class, so both light up the KinTales link, with or without
     * billing access.
     */
    @Test
    fun resolveActive_wide_picksKinTalesOnATaleRoute() {
        assertTrue(KinTalesRoute::class.isInstance(KinTalesRoute(taleId = "tale-1")))
        assertEquals(ShellDestination.KinTales, resolveActiveDestination(ShellNav.wideLinks) { it == KinTalesRoute::class })
        assertEquals(
            ShellDestination.KinTales,
            resolveActiveDestination(ShellNav.wideLinksFor(billingAccess = false)) { it == KinTalesRoute::class },
        )
    }

    @Test
    fun resolveActive_isNullOnDetailDestinations() {
        val active = resolveActiveDestination(ShellNav.wideLinks) { it == KinDetailRoute::class }
        assertNull(active, "detail routes light up no primary link")
    }

    /** #1413: Account is no longer a tab, so the Account screen lights up no tab. */
    @Test
    fun resolveActive_narrow_hasNoActiveTabOnAccountRoute() {
        val active = resolveActiveDestination(ShellNav.narrowTabs) { it == AccountRoute::class }
        assertNull(active, "Account is a menu screen now, so nothing is active in the tab bar")
    }

    @Test
    fun resolveActive_narrowMessagesTab_lightsUpOnMessageAuntieRoute() {
        val active = resolveActiveDestination(ShellNav.narrowTabs) { it == MessageAuntieRoute::class }
        assertEquals(ShellDestination.Messages, active)
    }

    @Test
    fun resolveActive_narrowTalesTab_lightsUpOnKinTalesRoute() {
        val active = resolveActiveDestination(ShellNav.narrowTabs) { it == KinTalesRoute::class }
        assertEquals(ShellDestination.KinTales, active)
    }

    @Test
    fun resolveActive_narrow_isNullOnDetailDestinations() {
        // The tab bar reads the back-stack hierarchy, so a leaf under no tab
        // route (KinDetail, the booking wizard) selects nothing.
        assertNull(resolveActiveDestination(ShellNav.narrowTabs) { it == KinDetailRoute::class })
        assertNull(resolveActiveDestination(ShellNav.narrowTabs) { it == BookingWizardRoute::class })
    }

    @Test
    fun resolveActive_wide_hasNoActiveLinkOnAccountRoute() {
        val active = resolveActiveDestination(ShellNav.wideLinks) { it == AccountRoute::class }
        assertNull(active, "Account is not a wide link, so nothing is active")
    }

    // ---- account menu ----

    /** #1458: KinTales and The Kin left the menu. #1411 added About. #1457: no Invoices without billing access. */
    @Test
    fun accountMenu_nonOperator_withoutBillingAccess_hasAccountTribeEditNotificationsAboutSignOut() {
        val menu = ShellNav.accountMenu(isOperator = false, billingAccess = false)
        assertEquals(
            listOf("Account", "Edit Tribe Profile", "Notification settings", "About your Auntie", "Sign out"),
            menu.map { it.label },
        )
        assertFalse(menu.any { it is AccountMenuItem.BackToDirectory })
        assertFalse(menu.any { it is AccountMenuItem.Open && it.destination == ShellDestination.Invoices })
    }

    /** #1457 (#1295 mobile map): Invoices between Account and Edit Tribe Profile for billing access. */
    @Test
    fun accountMenu_nonOperator_withBillingAccess_putsInvoicesAfterAccount() {
        val menu = ShellNav.accountMenu(isOperator = false, billingAccess = true)
        assertEquals(
            listOf("Account", "Invoices", "Edit Tribe Profile", "Notification settings", "About your Auntie", "Sign out"),
            menu.map { it.label },
        )
        val invoices = menu[1]
        assertTrue(invoices is AccountMenuItem.Open && invoices.destination == ShellDestination.Invoices)
        assertEquals(InvoicesRoute, ShellDestination.Invoices.route)
    }

    /** #1457: the menu item follows the same billing flag as the wide link, for kinfolk and operators. */
    @Test
    fun accountMenu_invoicesFollowsBillingAccess_likeTheWideLink() {
        listOf(false, true).forEach { operator ->
            listOf(false, true).forEach { billing ->
                val inMenu = ShellNav.accountMenu(isOperator = operator, billingAccess = billing)
                    .any { it is AccountMenuItem.Open && it.destination == ShellDestination.Invoices }
                assertEquals(billing, inMenu, "operator=$operator billing=$billing")
                assertEquals(ShellDestination.Invoices in ShellNav.wideLinksFor(billing), inMenu)
            }
        }
    }

    /** #1490: About reads "About {business name}", and "About your Auntie" when none is cached, as web does. */
    @Test
    fun accountMenu_aboutLabel_carriesTheBusinessNameOrFallsBack() {
        fun aboutLabel(name: String) = ShellNav.accountMenu(isOperator = false, billingAccess = true, businessName = name)
            .first { it is AccountMenuItem.Open && it.destination == ShellDestination.About }.label
        assertEquals("About Sunny Paws", aboutLabel("Sunny Paws"))
        assertEquals("About Sunny Paws", aboutLabel("  Sunny Paws  "))
        assertEquals("About your Auntie", aboutLabel(""))
        assertEquals("About your Auntie", aboutLabel("   "))
    }
    /** #1490: the narrow bar keeps its short word; only the menu and wide label say "Notification settings". */
    @Test
    fun notifications_menuLabelIsLong_barTabLabelStaysShort() {
        assertEquals("Notification settings", ShellDestination.Notifications.label)
        assertEquals("Notifications", ShellDestination.Notifications.tabLabel)
    }
    /** #1411: About is reached from the avatar menu on both platforms, and nowhere in the bars. */
    @Test
    fun accountMenu_includesAbout_whichIsNeitherATabNorAWideLink() {
        val menu = ShellNav.accountMenu(isOperator = false, billingAccess = true)
        assertTrue(menu.any { it is AccountMenuItem.Open && it.destination == ShellDestination.About })
        assertFalse(ShellDestination.About in ShellNav.narrowTabs)
        assertFalse(ShellDestination.About in ShellNav.wideLinks)
        assertEquals(AboutRoute, ShellDestination.About.route)
    }

    /**
     * #1458 (#1295 mobile map): Tales is a bar tab and a wide link, the kin
     * roster lives on Tribe, so neither repeats in the menu. Both destinations
     * still exist and still count as chrome.
     */
    @Test
    fun accountMenu_dropsKinTalesAndTheKin_butTheDestinationsStay() {
        listOf(false, true).forEach { operator ->
            listOf(false, true).forEach { billing ->
                val opens = ShellNav.accountMenu(isOperator = operator, billingAccess = billing)
                    .filterIsInstance<AccountMenuItem.Open>()
                    .map { it.destination }
                assertFalse(ShellDestination.KinTales in opens, "KinTales is a tab, not a menu item (operator=$operator)")
                assertFalse(ShellDestination.Kin in opens, "The Kin is reached from Tribe, not the menu (operator=$operator)")
            }
        }
        assertTrue(ShellDestination.KinTales in ShellNav.narrowTabs)
        assertTrue(ShellDestination.KinTales in ShellNav.wideLinks)
        assertEquals(KinRoute, ShellDestination.Kin.route)
        assertTrue(isShellChromeDestination { it == KinRoute::class })
        assertTrue(isShellChromeDestination { it == KinTalesRoute::class })
    }

    @Test
    fun accountMenu_operator_includesBackToDirectoryBeforeSignOut() {
        assertEquals(
            listOf("Account", "Invoices", "Edit Tribe Profile", "Notification settings", "About your Auntie", "Back to Directory", "Sign out"),
            ShellNav.accountMenu(isOperator = true, billingAccess = true).map { it.label },
        )
        assertEquals(
            listOf("Account", "Edit Tribe Profile", "Notification settings", "About your Auntie", "Back to Directory", "Sign out"),
            ShellNav.accountMenu(isOperator = true, billingAccess = false).map { it.label },
        )
    }

    /**
     * #1459: the full #1295 map order for an operator with billing access, the
     * same order web's AvatarMenu draws (AvatarMenu.test.tsx "lists the full
     * map order"): Account, Invoices, Edit Tribe Profile, Notification
     * settings, About, Back to Directory, Sign out.
     */
    @Test
    fun accountMenu_fullMapOrder() {
        assertEquals(
            listOf(
                AccountMenuItem.Open(ShellDestination.Account),
                AccountMenuItem.Open(ShellDestination.Invoices),
                AccountMenuItem.Open(ShellDestination.TribeEdit),
                AccountMenuItem.Open(ShellDestination.Notifications),
                AccountMenuItem.Open(ShellDestination.About, labelOverride = "About your Auntie"),
                AccountMenuItem.BackToDirectory,
                AccountMenuItem.SignOut,
            ),
            ShellNav.accountMenu(isOperator = true, billingAccess = true),
        )
    }

    @Test
    fun accountMenu_openEntries_targetTheRightDestinations() {
        val opens = ShellNav.accountMenu(isOperator = false, billingAccess = true).filterIsInstance<AccountMenuItem.Open>()
        assertEquals(
            listOf(
                ShellDestination.Account,
                ShellDestination.Invoices,
                ShellDestination.TribeEdit,
                ShellDestination.Notifications,
                ShellDestination.About,
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
        // #1413: Messages is a tab, so leaving it saves/restores like any tab.
        // Every entry point must navigate to it the tab way (AppNavHost
        // openMessages) for that to be safe.
        assertTrue(isShellChromeDestination { it == MessageAuntieRoute::class })
    }

    @Test
    fun chromeGuard_trueOnAvatarMenuDestinations() {
        assertTrue(isShellChromeDestination { it == AccountRoute::class })
        assertTrue(isShellChromeDestination { it == NotificationsRoute::class })
        assertTrue(isShellChromeDestination { it == TribeEditRoute::class })
        assertTrue(isShellChromeDestination { it == KinTalesRoute::class })
        // #1411: About is opened by the menu's save/restore navigation, so it
        // must count as chrome or leaving it would save a corrupt stack.
        assertTrue(isShellChromeDestination { it == AboutRoute::class })
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
        assertFalse(isShellChromeDestination { it == GalleryRoute::class })
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

    @Test
    fun shellPersonName_prefersTheSavedName_thenEmail_thenHousehold() {
        assertEquals("Casey QA", resolveShellPersonName("Casey QA", "casey@x.com", "TEST SANDBOX"))
        assertEquals("casey@x.com", resolveShellPersonName("", "casey@x.com", "TEST SANDBOX"))
        assertEquals("casey@x.com", resolveShellPersonName(null, "casey@x.com", "TEST SANDBOX"))
        assertEquals("casey@x.com", resolveShellPersonName("Casey@X.com", "casey@x.com", "TEST SANDBOX"))
        assertEquals("TEST SANDBOX", resolveShellPersonName(null, null, "TEST SANDBOX"))
    }
    @Test
    fun shellPersonName_givesTheSameAvatarLetterAsTheWeb() {
        assertEquals("C", avatarInitial(resolveShellPersonName("Casey QA", "jordan@x.com", "TEST SANDBOX")))
        assertEquals("J", avatarInitial(resolveShellPersonName("", "jordan@x.com", "TEST SANDBOX")))
    }
}
