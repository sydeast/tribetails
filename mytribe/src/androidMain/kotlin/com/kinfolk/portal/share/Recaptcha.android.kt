package com.kinfolk.portal.share

/** Android never renders the unauth share viewer's comment form. */
actual suspend fun executeRecaptcha(action: String): String? =
    throw RecaptchaUnavailableException("reCAPTCHA unavailable on Android — share viewer is web-only.")
