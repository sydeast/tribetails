package com.kinfolk.portal.attestation

/**
 * What happened when this process tried to attest itself.
 *
 * - [INACTIVE] nothing has been attempted.
 * - [PENDING]  a provider is installed, the first token has not come back.
 * - [ACTIVE]   a real App Check token was minted in this process.
 * - [FAILED]   installation threw, or the first token never arrived.
 *
 * [FAILED] exists as its own state, separate from [INACTIVE], for the reason
 * issue #556 exists: the web portal had no way to distinguish an attestation
 * that broke from one that was never attempted, and so nobody noticed that in
 * a year of shipping it had never been attempted at all.
 */
enum class AppCheckStatus { INACTIVE, PENDING, ACTIVE, FAILED }

/**
 * The platform-independent half of App Check: what state we are in, who gets
 * told when it goes wrong, and the once-only rule.
 *
 * Kept out of `androidMain` so it can be tested without an Android runtime, and
 * so the Android client and the React portal (web/src/lib/firebase.ts) describe
 * themselves with the same five words. The platform half — Play Integrity on
 * Android, reCAPTCHA Enterprise on the web — is the part that cannot be shared.
 *
 * [report] is where a failure has to become visible. A silent unattested client
 * is the defect, not the fallback.
 */
class AppCheckState(private val report: (String, Throwable?) -> Unit = { _, _ -> }) {

    var status: AppCheckStatus = AppCheckStatus.INACTIVE
        private set

    /** True on the first call only, so a provider is installed exactly once. */
    fun beginActivation(): Boolean {
        if (status != AppCheckStatus.INACTIVE) return false
        status = AppCheckStatus.PENDING
        return true
    }

    /** A token came back. Activation means this, not "the install call returned". */
    fun attested() {
        status = AppCheckStatus.ACTIVE
    }

    /** Installation threw, or a token never arrived. Always reported, never swallowed. */
    fun failed(reason: String, error: Throwable? = null) {
        status = AppCheckStatus.FAILED
        report(reason, error)
    }

    /** True only once a real token exists. */
    val attested: Boolean get() = status == AppCheckStatus.ACTIVE
}
