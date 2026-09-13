package com.kinfolk.portal.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.theme.KinfolkShapes
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.KinfolkTheme
import com.kinfolk.portal.theme.LocalKinfolkTypography

/**
 * The portal Android app's in-flight block: the ring, the sentence saying what
 * is being waited on, and a way forward once the wait runs long.
 *
 * WHY THE SENTENCE IS NOT OPTIONAL. Before this, every waiting section on Home
 * and Schedule drew a bare `KinSpinner()` centred in a Box with no words at
 * all. Four of them on Home alone, which meant four identical rings and no way
 * to tell which section was still coming. The web twin keeps the sentence each
 * site already had for the same reason; here there was none to keep, so the
 * caller supplies one.
 *
 * WHAT IT DOES AT 10 SECONDS (see SlowWait.kt for where the number comes from):
 * it offers [onSync]. The spinner keeps running underneath, because the read
 * has not ended -- the ruling is explicit that we wait for the server, and
 * swapping the cue for a button would claim the attempt had been abandoned.
 * Nothing here paints a result optimistically; it only asks again.
 *
 * IDEMPOTENCY IS THE CALLER'S PROBLEM. [onSync] is safe to point at any READ,
 * and the reload-key bump that HomeScreen already uses for KinTales is the
 * idiom: null the data, bump the key, let the LaunchedEffect re-run. Pointing
 * it at a WRITE is only safe when re-issuing is a no-op; a create (a booking,
 * an invoice payment) can land twice, because nothing client-side can abort the
 * first request once it is away.
 */
@Composable
fun KinLoading(
    text: String,
    modifier: Modifier = Modifier,
    online: Boolean = true,
    onSync: (() -> Unit)? = null,
) {
    val c = KinfolkTheme.colors
    val type = LocalKinfolkTypography.current
    val wait = rememberSlowWait(active = true, online = online, retry = onSync)

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(KinfolkSpacing.m)
            // One live region for the whole block, so the sentence and then the
            // escalation are announced by the same region rather than two. A
            // bare ring announced nothing at all, which is what this fixes for
            // anybody using TalkBack.
            .semantics {
                liveRegion = LiveRegionMode.Polite
                contentDescription = text
            },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
    ) {
        KinSpinner()
        Text(
            text = text,
            style = type.sansMeta,
            color = c.navyMuted,
            textAlign = TextAlign.Center,
        )
        if (wait.phase == WaitPhase.Slow) {
            SlowWaitNotice(attempt = wait.attempt, canSync = wait.canSync, onSync = wait.sync)
        }
    }
}

/**
 * What a wait offers once it has passed [SLOW_WAIT_MS].
 *
 * Quieter than an error card on purpose: nothing has failed, so this is dim
 * text and an outlined pill rather than a filled banner or an alert. It says
 * "Tap to sync", the ruling's own words, because this app is only ever held in
 * a hand; the admin's twin says "Sync now", since that screen is driven with a
 * cursor as often as a finger.
 *
 * With no [canSync] there is no button, only the sentence. That is the one case
 * where a wait has no action attached, and it exists because Android has no
 * equivalent of the web's page reload to fall back on -- so the fix is to give
 * every call site a real retry, not to draw a button that does nothing. Callers
 * should pass [onSync].
 */
@Composable
private fun SlowWaitNotice(attempt: Int, canSync: Boolean, onSync: () -> Unit) {
    val c = KinfolkTheme.colors
    val type = LocalKinfolkTypography.current
    val asked = attempt > 0

    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs),
    ) {
        Text(
            text = if (asked) {
                "Asked again. Still waiting on Tribe Tails."
            } else {
                "Tribe Tails has not answered yet."
            },
            style = type.sansMeta,
            color = c.navyMuted,
            textAlign = TextAlign.Center,
        )
        if (canSync) {
            Row(
                modifier = Modifier
                    .clip(KinfolkShapes.pill)
                    .background(c.glassSurface)
                    .border(1.dp, c.navyHairline, KinfolkShapes.pill)
                    .clickable { onSync() }
                    .padding(PaddingValues(horizontal = KinfolkSpacing.m, vertical = KinfolkSpacing.xs)),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = if (asked) "Ask again" else "Tap to sync",
                    style = type.sansButton,
                    color = c.primary,
                )
            }
        }
    }
}
