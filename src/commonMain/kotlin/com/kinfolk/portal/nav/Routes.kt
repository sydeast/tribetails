package com.kinfolk.portal.nav

import kotlinx.serialization.Serializable

/**
 * Type-safe route graph for the AndroidX Compose Navigation NavHost.
 *
 * Every route type lives in commonMain so the same graph compiles on jvm,
 * android, and js. Args are typed scalars (no lists) to keep URLs clean and
 * give compile-checked navigation via `composable<T>` / `toRoute<T>()`.
 *
 * Domain glossary: Kin = pet, Kinfolk = client, Auntie = sitter,
 * KinCare = one visit, Booking (envelope) = a batch of visits.
 */

// ---- Pre-shell (launch funnel) destinations ----
@Serializable data object SignInRoute
@Serializable data object NoTribesRoute
@Serializable data class TribePickerRoute(val isOperator: Boolean)
@Serializable data class LaunchErrorRoute(val message: String)

// ---- Unauth terminal deep-link destinations ----
@Serializable data class SecureResetRoute(val oobCode: String, val email: String)
@Serializable data class ShareRoute(val shareId: String)
@Serializable data class ClaimRoute(val inviteId: String)

// ---- Signed-in shell graph root (nested graph hosting tabs + drawer + details) ----
@Serializable data class ShellGraph(val kinfolkId: String, val cameFromPicker: Boolean = false)

// ---- Tab destinations (bottom nav) ----
@Serializable data object HomeRoute
@Serializable data object ScheduleRoute
@Serializable data object KinTalesRoute
@Serializable data object KinRoute
@Serializable data object InvoicesRoute

// ---- Drawer destinations ----
@Serializable data object TribeRoute
@Serializable data object TribeEditRoute
@Serializable data object AccountRoute
@Serializable data object NotificationsRoute

// ---- Detail destinations (lifted out of per-screen state) ----
@Serializable data class KinDetailRoute(val kinId: String)
@Serializable data class KinAddEditRoute(val kinId: String? = null) // null = add new
@Serializable data class InvoiceDetailRoute(val invoiceId: String)
@Serializable data class KinCareDetailRoute(val batchId: String? = null, val visitId: String)
@Serializable data class BookingEnvelopeRoute(val batchId: String)
// startWeekly pre-selects the wizard's Weekly (recurring) pattern; the Schedule
// "Set up a recurring visit" CTA passes true, "Request a Booking" passes false.
@Serializable data class BookingWizardRoute(val startWeekly: Boolean = false)

// Message Auntie (16.4): two-way conversation thread. Reached from the Schedule
// CTA and the ScreenHeader "Message Auntie" chip; kinfolkId comes from the shell.
@Serializable data object MessageAuntieRoute
