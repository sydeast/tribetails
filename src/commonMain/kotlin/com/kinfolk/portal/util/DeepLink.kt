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
 * Parameters extracted from the `/account/secure-reset` launch URL.
 *
 * @property oobCode  Firebase oobCode from the password-reset link query param.
 * @property email    Pre-filled kinfolk email from the `email=` query param.
 */
data class SecureResetParams(val oobCode: String, val email: String)

/**
 * Returns [SecureResetParams] when the launch URL is `/account/secure-reset`
 * with both `oobCode` and `email` query params present; null otherwise.
 *
 * Web: parsed from `window.location.search`.
 * Android: set via deep-link intent extras (MainActivity wires).
 * Desktop: set via `--secure-reset-oob=<code> --secure-reset-email=<email>` JVM args.
 */
expect fun readInitialSecureResetParams(): SecureResetParams?
