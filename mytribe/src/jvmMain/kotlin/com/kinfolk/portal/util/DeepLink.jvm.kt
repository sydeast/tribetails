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
 * Desktop secure-reset params set from JVM args:
 *   `--secure-reset-oob=<code>  --secure-reset-email=<email>`
 */
@Volatile
internal var jvmInitialSecureResetParams: SecureResetParams? = null

actual fun readInitialClaimInviteId(): String? = jvmInitialClaimInviteId
actual fun readInitialShareToken(): String? = jvmInitialShareToken
actual fun readInitialSecureResetParams(): SecureResetParams? = jvmInitialSecureResetParams
