package com.kinfolk.portal.nav

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoStories
import androidx.compose.material.icons.filled.CalendarToday
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.CreditCard
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.PersonOutline
import androidx.compose.material.icons.filled.Pets
import androidx.compose.ui.graphics.vector.ImageVector
import kotlin.reflect.KClass

/**
 * Responsive shell nav model. Pure data + pure functions so the wide/narrow
 * destination sets, active-state resolution, and account-menu contents are
 * unit-testable without a Compose runtime; TabShell renders from these.
 */

/** Width at/above which the shell uses the wide top-nav chrome. */
const val SHELL_WIDE_BREAKPOINT_DP = 880

/** True = sticky top-nav with link pills; false = slim top bar + bottom tabs. */
fun isWideShell(widthDp: Float): Boolean = widthDp >= SHELL_WIDE_BREAKPOINT_DP

/**
 * Every chrome-reachable destination. Each carries the label used in the wide
 * link row / account menu, the short label + icon for the narrow tab bar, the
 * type-safe route instance, and the route class used to compute "selected"
 * from the live back-stack entry.
 */
enum class ShellDestination(
    val label: String,
    val tabLabel: String,
    val icon: ImageVector,
    val route: Any,
    val routeClass: KClass<*>,
) {
    Home("Home", "Home", Icons.Filled.Home, HomeRoute, HomeRoute::class),
    Tribe("Tribe", "Tribe", Icons.Filled.Groups, TribeRoute, TribeRoute::class),
    Schedule("Schedule", "Schedule", Icons.Filled.CalendarToday, ScheduleRoute, ScheduleRoute::class),
    KinTales("KinTales", "Tales", Icons.Filled.AutoStories, KinTalesRoute(), KinTalesRoute::class),
    Invoices("Invoices", "Invoices", Icons.Filled.CreditCard, InvoicesRoute, InvoicesRoute::class),
    Kin("The Kin", "Kin", Icons.Filled.Pets, KinRoute, KinRoute::class),
    Account("Account", "Account", Icons.Filled.PersonOutline, AccountRoute, AccountRoute::class),
    Notifications("Notifications", "Notifications", Icons.Filled.Notifications, NotificationsRoute, NotificationsRoute::class),
    TribeEdit("Edit Tribe Profile", "Edit", Icons.Filled.Edit, TribeEditRoute, TribeEditRoute::class),

    /**
     * #1413: the direct line to the auntie is a narrow tab, so it is a chrome
     * destination like Account, not a detail leaf. Every entry point (tab tap,
     * Home quick-start, Schedule CTA) must therefore navigate to it the tab way
     * (pop to Home, save/restore), see AppNavHost's openMessages.
     */
    Messages("Messages", "Messages", Icons.Filled.ChatBubble, MessageAuntieRoute, MessageAuntieRoute::class),
}

/** One entry in the avatar dropdown. */
sealed interface AccountMenuItem {
    val label: String

    /** Navigates to a shell destination. */
    data class Open(val destination: ShellDestination) : AccountMenuItem {
        override val label: String get() = destination.label
    }

    /** Operator-only: leaves the shell back to the tribe directory. */
    data object BackToDirectory : AccountMenuItem {
        override val label: String = "Back to Directory"
    }

    data object SignOut : AccountMenuItem {
        override val label: String = "Sign Out"
    }
}

object ShellNav {
    /** Wide (>= 880dp) primary link pills (#1420: Messages after Invoices, as web's desktop nav). Kin/Account/Notifications live in the avatar menu. */
    val wideLinks: List<ShellDestination> = listOf(
        ShellDestination.Home,
        ShellDestination.Tribe,
        ShellDestination.Schedule,
        ShellDestination.Invoices,
        ShellDestination.Messages,
    )

    /**
     * #1005: the wide links for a member with or without billing access.
     * Without it, Invoices is not drawn at all.
     */
    fun wideLinksFor(billingAccess: Boolean): List<ShellDestination> =
        if (billingAccess) wideLinks else wideLinks.filter { it != ShellDestination.Invoices }

    /**
     * Narrow (< 880dp) bottom tab bar, the same five as the web portal's
     * PortalNav TAB_ITEMS. #1413 (operator ruling on #1295): Messages takes the
     * slot Account held and Tales joins the bar; Account is reached from the
     * avatar menu, Invoices stays one tap deeper (Home/Tribe/Account) until the
     * operator rules otherwise.
     */
    val narrowTabs: List<ShellDestination> = listOf(
        ShellDestination.Home,
        ShellDestination.Tribe,
        ShellDestination.Schedule,
        ShellDestination.KinTales,
        ShellDestination.Messages,
    )

    /** Avatar dropdown entries; "Back to Directory" only for operators. */
    fun accountMenu(isOperator: Boolean): List<AccountMenuItem> = buildList {
        add(AccountMenuItem.Open(ShellDestination.Account))
        add(AccountMenuItem.Open(ShellDestination.TribeEdit))
        add(AccountMenuItem.Open(ShellDestination.KinTales))
        add(AccountMenuItem.Open(ShellDestination.Notifications))
        add(AccountMenuItem.Open(ShellDestination.Kin))
        if (isOperator) add(AccountMenuItem.BackToDirectory)
        add(AccountMenuItem.SignOut)
    }
}

/**
 * First destination whose route class matches the live back-stack hierarchy
 * (per [isOn]); null when none is active (e.g. a detail destination).
 */
fun resolveActiveDestination(
    candidates: List<ShellDestination>,
    isOn: (KClass<*>) -> Boolean,
): ShellDestination? = candidates.firstOrNull { isOn(it.routeClass) }

/**
 * True when the live back stack currently sits on a chrome-level shell
 * destination (a tab or avatar-menu screen) rather than a detail/wizard leaf
 * (KinDetail, BookingWizard, KinCareDetail, ...). Tab taps may save/restore
 * per-tab stacks only from these destinations: a stack saved while on a detail
 * leaf restores corrupt and — combined with the browser-history binding on web
 * — silently wedges every later navigate/pop until reload.
 */
fun isShellChromeDestination(isOn: (KClass<*>) -> Boolean): Boolean =
    resolveActiveDestination(ShellDestination.entries, isOn) != null

/**
 * Avatar letter for the gradient circle. Skips leading whitespace/punctuation
 * and falls back to "T" (Tribe) when the display name is missing or has no
 * usable character — never crashes on null/blank.
 */
fun avatarInitial(displayName: String?): String =
    displayName?.firstOrNull { it.isLetterOrDigit() }?.uppercase() ?: "T"
/**
 * The name the header avatar is drawn from (#1290): the person's own saved
 * display name, else the address they sign in with, else the household's name.
 * Older accounts were seeded with displayName = email, which is not a name.
 * The web portal's `lib/identity.ts` gives the same answer.
 */
fun resolveShellPersonName(displayName: String?, email: String?, householdName: String): String {
    val mail = email?.trim().orEmpty()
    val saved = displayName?.trim().orEmpty()
    return when {
        saved.isNotEmpty() && !saved.equals(mail, ignoreCase = true) -> saved
        mail.isNotEmpty() -> mail
        else -> householdName
    }
}
