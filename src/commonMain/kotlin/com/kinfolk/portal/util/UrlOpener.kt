package com.kinfolk.portal.util

/**
 * Opens an external URL in the platform's default browser.
 * Used for Stripe Checkout, share links, etc.
 */
expect fun openExternalUrl(url: String)
