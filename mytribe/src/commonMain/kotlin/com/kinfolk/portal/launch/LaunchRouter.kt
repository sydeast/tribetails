package com.kinfolk.portal.launch

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.kinfolk.portal.auth.AuthRepository
import com.kinfolk.portal.auth.AuthState
import com.kinfolk.portal.portal.MyAccessResult
import com.kinfolk.portal.portal.PortalApi

sealed interface LaunchDestination {
    data object SignIn : LaunchDestination
    data object NoTribes : LaunchDestination
    data class Home(val kinfolkId: String) : LaunchDestination
    data class Pick(val kinfolkIds: List<String>, val isOperator: Boolean = false) : LaunchDestination
    data class Error(val message: String) : LaunchDestination
}

/**
 * Pure destination resolver — exported so tests can hit every branch without a
 * Compose runtime. Composable wrapper below feeds AuthState + the latest
 * `getMyAccess` result (or thrown error message).
 *
 * - SignedIn but `access == null` and `error == null` → null (loading)
 * - SignedIn + error                                  → Error(error)
 * - empty kinfolkIds (operator OR not)               → NoTribes
 * - operator                                          → Pick(isOperator=true)
 * - exactly one kinfolk, non-operator                → Home
 * - 2+ kinfolks, non-operator                         → Error (see below)
 *
 * Operator ruling 2026-08-06, "one kinfolk, one tribe": a non-operator can
 * only ever belong to exactly one household, so the 2+/non-operator branch
 * used to reach Pick(isOperator=false) is withdrawn. Under the ruling that
 * combination can't happen legitimately — it's a data defect, not a routing
 * case — so it fails loud as Error rather than auto-picking a household at
 * random or resurrecting the picker for a non-operator.
 */
/**
 * What a kinfolk reads when the sign-in check could not complete (#494). It
 * says what happened, says what it is not (a sign-out), and leaves them
 * something to do. The throwable's own message stays in the log, where it is
 * useful, rather than on a screen where it is not.
 */
const val COULD_NOT_CHECK_SIGN_IN =
    "Couldn't reach Tribe Tails to check your sign-in. Your account is fine. Retry when you're back online."
fun resolveLaunchDestination(
    authState: AuthState,
    access: MyAccessResult?,
    error: String?,
): LaunchDestination? = when (authState) {
    is AuthState.Loading -> null
    is AuthState.SignedOut -> LaunchDestination.SignIn
    // #494: we could not check, so we do not send anyone to the sign-in screen.
    // Error is the honest destination and already the retryable one: its screen
    // offers Retry, which re-runs refresh(), and Sign out for anybody who did
    // mean to leave.
    is AuthState.Unreachable -> LaunchDestination.Error(COULD_NOT_CHECK_SIGN_IN)
    is AuthState.SignedIn -> when {
        error != null -> LaunchDestination.Error(error)
        access == null -> null
        access.kinfolkIds.isEmpty() -> LaunchDestination.NoTribes
        access.isOperator -> LaunchDestination.Pick(access.kinfolkIds, isOperator = true)
        access.kinfolkIds.size == 1 -> LaunchDestination.Home(access.kinfolkIds[0])
        else -> LaunchDestination.Error(
            "Account has ${access.kinfolkIds.size} tribes; expected exactly 1. This account needs attention.",
        )
    }
}

/**
 * Composable that owns the auth-state subscription + the `getMyAccess` call.
 * Returns the resolved LaunchDestination as a Compose State.
 */
@Composable
fun rememberLaunchDestination(
    repo: AuthRepository,
    portalApi: PortalApi,
): State<LaunchDestination?> {
    val state by repo.state.collectAsState()
    var access by remember { mutableStateOf<MyAccessResult?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(state) {
        println("[Launch] LaunchedEffect fired, state=${state::class.simpleName}" +
            (if (state is AuthState.SignedIn) " uid=${(state as AuthState.SignedIn).uid}" else ""))
        if (state is AuthState.SignedIn) {
            access = null
            error = null
            println("[Launch] calling portalApi.getMyAccess()")
            try {
                val result = portalApi.getMyAccess()
                access = result
                println("[Launch] getMyAccess OK kinfolkIds=${result.kinfolkIds.size} isOperator=${result.isOperator}")
            } catch (t: Throwable) {
                val msg = t.message ?: "Could not load access. Tap retry or sign out."
                error = msg
                println("[Launch] getMyAccess THREW: ${t::class.simpleName} msg=$msg")
            }
        } else {
            access = null
            error = null
        }
    }
    val dest = remember { mutableStateOf<LaunchDestination?>(null) }
    val resolved = resolveLaunchDestination(state, access, error)
    if (dest.value != resolved) {
        println("[Launch] dest=${resolved?.let { it::class.simpleName } ?: "null"} (state=${state::class.simpleName} access=${access != null} error=${error != null})")
    }
    dest.value = resolved
    return dest
}
