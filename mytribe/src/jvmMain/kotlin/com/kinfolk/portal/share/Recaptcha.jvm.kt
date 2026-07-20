package com.kinfolk.portal.share

/** Desktop never renders the unauth share viewer's comment form. */
actual suspend fun executeRecaptcha(action: String): String? =
    throw RecaptchaUnavailableException("reCAPTCHA unavailable on desktop — share viewer is web-only.")
