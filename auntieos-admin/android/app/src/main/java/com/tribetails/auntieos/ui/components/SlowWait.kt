package com.tribetails.auntieos.ui.components

import android.animation.ValueAnimator
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlinx.coroutines.delay

/**
 * When a wait has gone on long enough to stop being a wait and start being a
 * question. The admin Android app's half of the 2026-09-12 ruling:
 *
 *   "nah wait for servers or a tap to sync option if server access is taking
 *    too long and any waits/delays/etc need to have some sort of loading icon"
 *
 * One rule, four clients. This is a line-for-line port of
 * `auntieos-admin/src/lib/slowWait.ts`; `mytribe/web/src/lib/slowWait.ts` and
 * `mytribe/src/commonMain/.../components/SlowWait.kt` are the same again. They
 * are duplicated rather than shared because the four trees ship separately and
 * each app's loading vocabulary is its own. What must never drift is the
 * threshold and the offline rule, so both are restated here in full.
 *
 * WHERE 10 SECONDS COMES FROM. Two measurements on this project, not taste:
 *
 *   7.9s - 9.4s   the measured cold start of a callable here -- the number
 *                 issue #714 was filed about. A wait shorter than this is a
 *                 NORMAL cold start; escalating at 5s would fire on almost
 *                 every first call of a session and train the operator to tap
 *                 through a healthy wait.
 *   20_000ms      `auntieos-admin/src/lib/fns.ts#CALLABLE_TIMEOUT_MS`, the hard
 *                 client budget. Past it a callable rejects and the error path
 *                 takes over, so a later escalation would never be seen.
 *
 * 10s clears the worst measured healthy cold start with margin and leaves the
 * other half of the budget for the operator to read the offer and use it.
 *
 * A FIRESTORE LISTEN HAS NO BUDGET AT ALL, which is the case this is most for:
 * a subscription that never delivers a first snapshot spins forever with no
 * error to render. That is the "indefinite spinner with no way forward" the
 * ruling refuses.
 *
 * OFFLINE IS NOT A SLOW SERVER. A device with no signal reaching 10s is not
 * waiting on a slow backend and must not be handed a Sync button that fails the
 * moment it is pressed. [waitPhase] refuses to escalate while [online] is false.
 */
const val SLOW_WAIT_MS: Long = 10_000L

/** What a waiting region should show. Exactly one at a time. */
enum class WaitPhase { Idle, Waiting, Slow }

/**
 * The whole decision, as a pure function of four values.
 *
 * Pure and clock-injected on purpose. This app's Compose tests cannot drive an
 * infinite transition to a ten-second deadline comfortably, so the threshold is
 * carried by a plain JVM unit test against this function -- which is also the
 * spec that proves the Kotlin agrees with the TypeScript.
 */
fun waitPhase(
    startedAtMs: Long?,
    nowMs: Long,
    online: Boolean,
    thresholdMs: Long = SLOW_WAIT_MS,
): WaitPhase {
    if (startedAtMs == null) return WaitPhase.Idle
    if (!online) return WaitPhase.Waiting
    return if (nowMs - startedAtMs >= thresholdMs) WaitPhase.Slow else WaitPhase.Waiting
}

/**
 * Whether this device wants animation at all.
 *
 * Android's answer to `prefers-reduced-motion`: false when Animator duration
 * scale is off in Developer options, or "Remove animations" is on in
 * accessibility. Callers SLOW the spinner rather than stopping it -- a frozen
 * ring is not a loading indicator, it is a picture of a hang, which is the
 * exact reading the ruling exists to prevent. The setting asks for no large,
 * vestibular or distracting motion, which a slow ring is not.
 */
fun animationsEnabled(): Boolean = ValueAnimator.areAnimatorsEnabled()

data class SlowWaitState(
    val phase: WaitPhase,
    val attempt: Int,
    val canSync: Boolean,
    val sync: () -> Unit,
)

/**
 * Track one in-flight wait across recompositions and escalate it at the
 * threshold.
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

    LaunchedEffect(active, restarts, thresholdMs) {
        elapsed = false
        if (!active) {
            attempt = 0
            return@LaunchedEffect
        }
        delay(thresholdMs)
        elapsed = true
    }

    val phase = when {
        !active -> WaitPhase.Idle
        !online -> WaitPhase.Waiting
        elapsed -> WaitPhase.Slow
        else -> WaitPhase.Waiting
    }

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

/**
 * The admin Android app's in-flight block: the ring, the sentence saying what is
 * being waited on, and a way forward once the wait runs long.
 *
 * Replaces `LoadingScreen`/`LoadingCard` at any site that should escalate.
 * Those draw a ring and stop; this one also answers the operator's second
 * question, which is what to do when the ring has been going for ten seconds.
 *
 * IDEMPOTENCY IS THE CALLER'S PROBLEM. [onSync] is safe to point at any READ.
 * Pointing it at a WRITE is only safe when re-issuing is a no-op -- the visit
 * clock qualifies, because `patchVisitLifecycle` re-reads the row's status and
 * returns `changed: false` rather than writing twice, the same guard that stops
 * a double clock-in from moving the arrival time. A write that CREATES does
 * not qualify; point those at a re-read of what the write would have produced.
 */
@Composable
fun AuntieLoading(
    text: String,
    modifier: Modifier = Modifier,
    online: Boolean = true,
    onSync: (() -> Unit)? = null,
) {
    val c = AuntieTheme.colors
    val t = AuntieTheme.typography
    val wait = rememberSlowWait(active = true, online = online, retry = onSync)

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(16.dp)
            // One live region for the block, so the sentence and then the
            // escalation are announced by the same region rather than two.
            .semantics {
                liveRegion = LiveRegionMode.Polite
                contentDescription = text
            },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        AuntieSpinner(modifier = Modifier.size(28.dp))
        Text(text = text, style = t.bodySmall, color = c.textDim, textAlign = TextAlign.Center)

        if (wait.phase == WaitPhase.Slow) {
            Text(
                text = if (wait.attempt > 0) {
                    "Asked again. Still waiting on the server."
                } else {
                    "The server has not answered yet."
                },
                style = t.bodySmall,
                color = c.textDim,
                textAlign = TextAlign.Center,
            )
            if (wait.canSync) {
                Row(
                    modifier = Modifier
                        .clip(AuntieTheme.shapes.pill)
                        .background(c.surface2)
                        .border(AuntieTheme.dims.borderHairline, c.border, AuntieTheme.shapes.pill)
                        .clickable { wait.sync() }
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // "Sync now", not the ruling's literal "tap to sync": this
                    // admin is driven with a cursor as often as a finger, so
                    // "tap" would be wrong half the times it was read. The
                    // portal, only ever held in a hand, does say "Tap to sync".
                    Text(
                        text = if (wait.attempt > 0) "Ask again" else "Sync now",
                        style = t.labelMedium,
                        color = c.textPrimary,
                    )
                }
            }
        }
    }
}
