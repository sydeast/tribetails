package com.kinfolk.portal.auth

sealed interface AuthState {
    data object Loading : AuthState
    data object SignedOut : AuthState
    /**
     * We could not tell (#494).
     *
     * There was no answer from the sign-in service, so nothing here says the
     * kinfolk signed out. Before this case existed, [AuthRepository.refresh]
     * caught every throwable and answered [SignedOut], which turned a few
     * seconds of bad signal into a sign-in screen for somebody who never signed
     * out. The 2026-08-17 walk logged 16 failed requests over 22 hours, in
     * bursts of a few seconds, every one recovering; on this surface each burst
     * was a spurious sign-out.
     *
     * [reason] is for the log and for whoever is debugging, never for the
     * screen. What reaches a kinfolk is the retryable launch error.
     */
    data class Unreachable(val reason: String?) : AuthState
    data class SignedIn(val uid: String, val email: String?, val displayName: String?) : AuthState
}
