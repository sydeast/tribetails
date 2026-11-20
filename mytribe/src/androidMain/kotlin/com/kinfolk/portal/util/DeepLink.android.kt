package com.kinfolk.portal.util

import android.net.Uri
import com.kinfolk.portal.screens.invoices.CHECKOUT_RETURN_PARAM
import com.kinfolk.portal.screens.invoices.CheckoutReturn
import com.kinfolk.portal.screens.invoices.checkoutReturnFromLink

/**
 * Android stores the latest deep-link invite id in this property.
 * MainActivity sets it from `intent.data` on create + new intent.
 */
@Volatile
internal var androidInitialClaimInviteId: String? = null

@Volatile
internal var androidInitialShareToken: String? = null

/**
 * #905: the Firebase email action link MainActivity was opened with
 * (`/account/secure-reset` or `/account/action` on kinfolk.tribetails.com), parsed by
 * [com.kinfolk.portal.auth.parseEmailActionUrl]. No `email` param is needed.
 */
@Volatile
internal var androidInitialSecureResetParams: SecureResetParams? = null

/** #1293: the launch link matched the manifest but named nothing the app can open. */
@Volatile
internal var androidInitialUnknownLink: Boolean = false
/**
 * #2401: a launch URI read as the address Stripe returns a card payment to, or
 * null when it is not one. The rules are [checkoutReturnFromLink]'s; this only
 * takes the URI apart. An opaque URI (`mytribe:invoices/x`, no `//`) has no
 * path parts and throws on a query read, so it is refused before either.
 */
internal fun checkoutReturnOf(uri: Uri?): CheckoutReturn? {
    if (uri == null || !uri.isHierarchical) return null
    return checkoutReturnFromLink(
        scheme = uri.scheme,
        host = uri.host,
        pathSegments = uri.pathSegments.orEmpty(),
        checkout = uri.getQueryParameter(CHECKOUT_RETURN_PARAM),
    )
}
actual fun readInitialClaimInviteId(): String? = androidInitialClaimInviteId
actual fun readInitialShareToken(): String? = androidInitialShareToken
actual fun readInitialSecureResetParams(): SecureResetParams? = androidInitialSecureResetParams
actual fun readInitialUnknownLink(): Boolean = androidInitialUnknownLink
