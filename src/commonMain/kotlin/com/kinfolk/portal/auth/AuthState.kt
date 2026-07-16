package com.kinfolk.portal.auth

sealed interface AuthState {
    data object Loading : AuthState
    data object SignedOut : AuthState
    data class SignedIn(val uid: String, val email: String?, val displayName: String?) : AuthState
}
