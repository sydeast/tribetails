package com.kinfolk.portal.share

/**
 * reCAPTCHA Enterprise site key (public). Verification happens server-side
 * in [com.kinfolk.portal.functions/addGuestKinTaleComment] via the Cloud
 * reCAPTCHA Enterprise REST API — the public key alone is not exploitable.
 */
const val RECAPTCHA_SITE_KEY = "6Leix-ksAAAAAFwAl_Ua0n6ZFyPR8PQCZxc2VRIg"

/**
 * Executes reCAPTCHA Enterprise for the given action, returns the assessment
 * token to send to the backend.
 *
 * Platforms without an embedded reCAPTCHA widget (Android/JVM) return null
 * — those targets never render the share viewer's comment form anyway.
 *
 * Per `feedback_fail_loud_policy.md`: if the script failed to load, the
 * actual throws [RecaptchaUnavailableException] so the form can show a
 * banner instead of silently submitting unsigned.
 */
expect suspend fun executeRecaptcha(action: String): String?

class RecaptchaUnavailableException(message: String) : RuntimeException(message)
