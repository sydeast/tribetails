package com.tribetails.auntieos.ui.components

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier

/**
 * #1009: a confirmation raised by a save that another screen navigates away
 * from in the SAME step. `EditKinfolkScreen`'s `LaunchedEffect(state.isSuccess)
 * { onBack() }`, and the same shape on its Kin/AddKin/AddKinfolk siblings and
 * `KinTaleReportScreen`'s send, never had a message to lose to that
 * navigation - there was no confirmation at all on Android, unlike admin web
 * (`ToastProvider`, mounted once above the router) and now desktop (#1007,
 * `RouteToastHost`).
 *
 * This is the same fix as #1007's, adapted to Navigation Compose: a state
 * object held ONE level up, in `AuthenticatedNavHost`, above the `NavHost` a
 * save pops, reached from any screen via [LocalSaveConfirmation] rather than
 * threaded through every screen's parameter list.
 *
 * [show] is a plain, synchronous call - not `suspend`, unlike Material3's
 * `SnackbarHostState.showSnackbar`. A screen's own
 * `LaunchedEffect(state.successMessage) { confirmation.show(it); onBack() }`
 * calls it and pops in the same breath; the message has already landed on
 * this object before `onBack()` runs, so it survives even though the
 * `LaunchedEffect`'s own coroutine is cancelled a frame later when the nav
 * pop disposes the screen that launched it. [SaveConfirmationHost] owns the
 * countdown that clears it, and that composable lives above the `NavHost`,
 * so it is never disposed by a pop either.
 */
@Stable
class SaveConfirmationHostState {
    var message by mutableStateOf<String?>(null)
        private set

    var kind by mutableStateOf(ToastKind.Success)
        private set

    // A counter, not the message text: two saves that both land on the exact
    // same wording (two kinfolk both named "the same" is not a corner case -
    // "Saved." would collide constantly if it weren't for the name; "is
    // archived." collides on a common name) must each still start their own
    // full dismiss window, never be read as a no-op repeat of the one still
    // counting down. Read by [StatusToast]'s `resetKey`.
    var token by mutableIntStateOf(0)
        private set

    fun show(message: String, kind: ToastKind = ToastKind.Success) {
        val trimmed = message.trim()
        // An empty confirmation is a bug at the call site, not something to
        // render blank - matches admin web's ToastProvider.
        if (trimmed.isEmpty()) return
        this.message = trimmed
        this.kind = kind
        token++
    }

    fun dismiss() {
        message = null
    }
}

/**
 * Defaults to an owned, unrendered [SaveConfirmationHostState] rather than
 * throwing outside a provider - matching this file's neighbor
 * `LocalFeatureFlags` (`config/LocalFeatureFlags.kt`), not admin web's
 * `useToast()`, which throws. Android's own screens are routinely composed
 * standalone in Robolectric tests, with no `AuthenticatedNavHost` above them
 * (`AddKinfolkPendingPromptUiTest` and its siblings render `AddKinfolkScreen`
 * directly); a throwing default would fail every one of those on this
 * unrelated change rather than only where a confirmation is genuinely lost.
 * In real use this is provided once, in `AuthenticatedNavHost`, before any
 * screen mounts, so the default is never the ACTIVE one in production - only
 * in a test or preview that renders a screen on its own.
 */
val LocalSaveConfirmation = staticCompositionLocalOf { SaveConfirmationHostState() }

/**
 * Renders [state]'s current message, if any, as a [StatusToast]. Placed once,
 * in `AuthenticatedNavHost`'s shell column, ABOVE the `NavHost` - the same
 * position `TestModeBanner`/`VoiceRegistrationBanner`/`SessionHealthBanner`
 * already hold there, for the same reason: this is true of the whole nav
 * host, not of one screen underneath it, so it renders alongside them rather
 * than being reached for again inside a screen this is not about.
 *
 * `lastShown` holds the most recent non-null message and kind across the
 * fade-out: `state.message` itself goes to null the instant [dismiss] fires
 * (auto-dismiss or the toast's own close), and without this the outgoing
 * text would blank out mid-animation instead of fading away intact.
 */
@Composable
fun SaveConfirmationHost(
    state: SaveConfirmationHostState,
    modifier: Modifier = Modifier,
) {
    var lastShown by remember { mutableStateOf("" to ToastKind.Success) }
    state.message?.let { lastShown = it to state.kind }

    StatusToast(
        visible = state.message != null,
        message = lastShown.first,
        kind = lastShown.second,
        onDismiss = state::dismiss,
        resetKey = state.token,
        modifier = modifier,
    )
}
