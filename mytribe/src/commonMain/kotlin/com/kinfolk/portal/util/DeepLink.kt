package com.kinfolk.portal.util

/** Returns the invite id parsed from the platform's launch URL, or null. */
expect fun readInitialClaimInviteId(): String?

/**
 * Returns the share token parsed from the platform's launch URL, or null.
 *
 * Web hash forms: `#/share/<token>` or path `/share/<token>`.
 * Android: set via deep-link intent (MainActivity wires).
 * Desktop: set via `--share=<token>` JVM arg.
 */
expect fun readInitialShareToken(): String?

/**
 * A Firebase email action link the app was opened with (#905).
 *
 * Parsed by [com.kinfolk.portal.auth.parseEmailActionUrl] from
 * `https://kinfolk.tribetails.com/account/secure-reset` or `/account/action`.
 *
 * @property oobCode     The code from the link. Blank when the link had none,
 *                       which the screen reports as "This link is incomplete."
 * @property email       NOT READ by the screen. The account always comes from
 *                       the verified code. Kept only so the desktop entry point
 *                       (`jvmMain/Main.kt`, owned by PR #904) still compiles;
 *                       remove it once that lands.
 * @property mode        The link's `mode`, `resetPassword` when absent.
 * @property continueUrl An allowlisted continue target, or null.
 */
data class SecureResetParams(
    val oobCode: String,
    val email: String? = null,
    val mode: String = "resetPassword",
    val continueUrl: String? = null,
)
/**
 * Returns the email action link the app was launched with, or null.
 *
 * Android: set by MainActivity from the App Link's `intent.data`.
 * Web (Kotlin/JS): parsed from `window.location.href`.
 * Desktop: set from the legacy `--secure-reset-oob=` JVM arg. Desktop has no
 * link handler, and its auth backend cannot check a code, so the screen tells
 * the reader to open the link in a browser and files nothing.
 */
expect fun readInitialSecureResetParams(): SecureResetParams?
