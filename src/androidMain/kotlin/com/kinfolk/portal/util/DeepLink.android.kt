package com.kinfolk.portal.util

/**
 * Android stores the latest deep-link invite id in this property.
 * MainActivity sets it from `intent.data` on create + new intent.
 */
@Volatile
internal var androidInitialClaimInviteId: String? = null

@Volatile
internal var androidInitialShareToken: String? = null

/**
 * Secure-reset params set by MainActivity when the deep-link path is
 * `/account/secure-reset` with both `oobCode` and `email` query params.
 */
@Volatile
internal var androidInitialSecureResetParams: SecureResetParams? = null

actual fun readInitialClaimInviteId(): String? = androidInitialClaimInviteId
actual fun readInitialShareToken(): String? = androidInitialShareToken
actual fun readInitialSecureResetParams(): SecureResetParams? = androidInitialSecureResetParams
