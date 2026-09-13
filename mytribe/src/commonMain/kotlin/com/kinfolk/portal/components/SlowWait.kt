package com.kinfolk.portal.components

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlinx.coroutines.delay

/**
 * When a wait has gone on long enough to stop being a wait and start being a
 * question. The portal Android app's half of the 2026-09-12 ruling:
 *
 *   "nah wait for servers or a tap to sync option if server access is taking
 *    too long and any waits/delays/etc need to have some sort of loading icon"
 *
 * This is a line-for-line port of `mytribe/web/src/lib/slowWait.ts`, and the
 * admin's `auntieos-admin/src/lib/slowWait.ts` is the same rule again. Four
 * clients, one number, one offline rule. They are duplicated rather than shared
 * because the trees ship separately and each app's loading vocabulary is its
 * own; what must never drift is the threshold and the offline guard, so both
 * are restated in full here rather than referred to.
 *
 * WHERE 10 SECONDS COMES FROM. Two measurements on this project, not taste:
 *
 *   7.9s - 9.4s   the measured cold start of a callable here. A wait shorter
 *                 than this is a NORMAL cold start, and offering a sync at 5s
 *                 would fire on nearly every first read of a session -- which
 *                 teaches a household to tap through a wait that was always
 *                 going to land on its own.
 *   20_000ms      `auntieos-admin/src/lib/fns.ts#CALLABLE_TIMEOUT_MS`, the hard
 *                 client budget on the shared callables. Past it the call
 *                 rejects and the error path takes over, so an escalation
 *                 offered later than that would never be seen.
 *
 * 10s clears the worst measured healthy cold start with margin and still leaves
 * half the budget for somebody to read the offer and use it. A Firestore listen
 * has no budget at all, which is the indefinite-spinner case this is most for.
 *
 * OFFLINE IS NOT A SLOW SERVER. A phone with no bars reaching 10s is not
 * waiting on a slow backend and must not be handed a Sync button that fails the
 * moment it is pressed; that case keeps whatever offline treatment its screen
 * already has. [waitPhase] refuses to escalate while [online] is false.
 */
const val SLOW_WAIT_MS: Long = 10_000L

/**
 * What a waiting region should show. Exactly one at a time.
 *
 * No Offline member on purpose: that is not this file's decision to make. A
 * screen that knows it is offline already has a state for it, and the only
 * thing this owes that screen is a promise never to escalate underneath it.
 */
enum class WaitPhase {
    /** Nothing in flight. */
    Idle,

    /** In flight, and not yet long enough to be worth remarking on. */
    Waiting,

    /** In flight past [SLOW_WAIT_MS] on a device with signal. Offer the sync. */
    Slow,
}

/**
 * The whole decision, as a pure function of four values.
 *
 * Pure and clock-injected on purpose: this is the rule the operator's ruling
 * turns into, and a rule that can only be exercised by launching a Compose host
 * and advancing a virtual clock is a rule that gets tested once and then
 * trusted. This one is exercised from `commonTest`, on every platform, with no
 * UI at all -- which is also what carries the threshold on the admin Android
 * app, whose Compose tests cannot drive an infinite transition.
 */
fun waitPhase(
    startedAtMs: Long?,
    nowMs: Long,
    online: Boolean,
    thresholdMs: Long = SLOW_WAIT_MS,
): WaitPhase {
    if (startedAtMs == null) return WaitPhase.Idle
    // Offline never escalates; see the header.
    if (!online) return WaitPhase.Waiting
    return if (nowMs - startedAtMs >= thresholdMs) WaitPhase.Slow else WaitPhase.Waiting
}

/**
 * One in-flight wait, tracked and escalated.
 *
 * @property phase   what to draw.
 * @property attempt how many times Sync has been pressed during THIS wait. 0
 *                   while the app is still on its own first try. The copy
 *                   changes at 1, because a tap that produces no visible
 *                   difference reads as a dead button -- the failure the
 *                   affordance exists to cure.
 * @property sync    ask again: re-runs the caller's retry and restarts the clock.
 * @property canSync true when a retry was supplied, i.e. the offer can be made.
 */
data class SlowWaitState(
    val phase: WaitPhase,
    val attempt: Int,
    val canSync: Boolean,
    val sync: () -> Unit,
)

/**
 * Track a wait across recompositions and escalate it at the threshold.
 *
 * @param active true while the read is in flight. Going false ends the wait and
 *               resets; going true again starts a fresh one.
 * @param online pass the screen's own connectivity signal where it has one.
 *               Defaults to true, which only ever makes the escalation MORE
 *               likely, never less -- a wait that offers a sync it cannot
 *               honour is a smaller failure than one that offers nothing.
 * @param retry  what Sync does. Safe for any READ. Before pointing it at a
 *               write, see the idempotency note on [KinLoading].
 *
 * A single [delay] rather than a ticking loop: nothing on screen changes
 * between "started" and "slow", so there is nothing to recompose for.
 */
@Composable
fun rememberSlowWait(
    active: Boolean,
    online: Boolean = true,
    thresholdMs: Long = SLOW_WAIT_MS,
    retry: (() -> Unit)? = null,
): SlowWaitState {
    var attempt by remember { mutableIntStateOf(0) }
    var restarts by remember { mutableIntStateOf(0) }
    var elapsed by remember { mutableStateOf(false) }

    // Keyed on `active` and the restart counter, so pressing Sync re-arms the
    // timer without the caller having to change `active`.
    LaunchedEffect(active, restarts, thresholdMs) {
        elapsed = false
        if (!active) {
            attempt = 0
            return@LaunchedEffect
        }
        delay(thresholdMs)
        elapsed = true
    }

    // Delegates to the pure rule rather than restating it. An earlier version
    // re-implemented the offline branch here, which meant a broken `waitPhase`
    // could still pass this composable's tests: the mutation check caught
    // exactly that. `startedAtMs` is 0/null rather than a real clock because
    // the deadline is owned by the `delay` above; `waitPhase` is consulted for
    // the DECISION, not the timing.
    val phase = waitPhase(
        startedAtMs = if (active) 0L else null,
        nowMs = if (elapsed) thresholdMs else 0L,
        online = online,
        thresholdMs = thresholdMs,
    )

    return SlowWaitState(
        phase = phase,
        attempt = attempt,
        canSync = retry != null,
        sync = {
            attempt += 1
            restarts += 1
            retry?.invoke()
        },
    )
}
