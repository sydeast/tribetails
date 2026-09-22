package com.kinfolk.portal.util

/**
 * Desktop reads from `--claim=<id>` JVM arg captured by Main.
 * Set externally before Compose mounts.
 */
@Volatile
internal var jvmInitialClaimInviteId: String? = null

@Volatile
internal var jvmInitialShareToken: String? = null

/**
 * #905: the Firebase email action link this session was started with, set from
 * `--email-link=<url>` or the older `--secure-reset-oob=<code>`. See
 * `Main.emailActionArg`.
 */
@Volatile
internal var jvmInitialSecureResetParams: SecureResetParams? = null

actual fun readInitialClaimInviteId(): String? = jvmInitialClaimInviteId
actual fun readInitialShareToken(): String? = jvmInitialShareToken
actual fun readInitialSecureResetParams(): SecureResetParams? = jvmInitialSecureResetParams
