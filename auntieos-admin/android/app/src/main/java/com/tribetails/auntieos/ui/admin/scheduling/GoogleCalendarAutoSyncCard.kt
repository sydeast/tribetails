package com.tribetails.auntieos.ui.admin.scheduling

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * What automatic calendar sync last did, and the way to retry it when it failed
 * (issue #397).
 *
 * ── WHY THIS IS A CARD AND NOT A TOGGLE ──────────────────────────────────
 *
 * There is no on/off switch here, deliberately. Automatic sync is live exactly
 * when a calendar has been chosen, because choosing one is already the
 * deliberate act that means "put our visits here". A second switch would allow
 * a state where a calendar is selected and visits silently never reach it,
 * which is the exact complaint this feature exists to fix. Disconnecting is the
 * off switch. `autoSyncIsArmed` states the same rule in one place for both
 * clients.
 *
 * ── WHY A FAILED SYNC NEEDS A BUTTON ─────────────────────────────────────
 *
 * The `onKinCareSessionCalendarSync` trigger deliberately does not rethrow:
 * Firestore would retry it, and retrying a calendar write whose first attempt
 * may already have created an event is how one visit becomes four. Recovery is
 * therefore a human act, and this is where it lives.
 *
 * STATELESS, the same posture as [GoogleCalendarConnectCard] and
 * [GoogleCalendarSyncCard], so every state is unit-testable under Robolectric
 * without standing up the ViewModel.
 */
@Composable
internal fun GoogleCalendarAutoSyncCard(
    state: GoogleCalendarUiState,
    onRetryVisit: (sessionId: String) -> Unit,
    onDismissNote: () -> Unit,
) {
    val connection = state.connection

    Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Automatic sync", style = AuntieTheme.typography.titleMedium)

        if (connection == null || !autoSyncIsArmed(connection)) {
            Text(
                "Once a calendar is chosen above, confirming a visit puts it on that calendar, " +
                    "moving a visit moves it, and cancelling one takes it off. No pushing required.",
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.textDim,
            )
            return@Column
        }

        Text(
            "Confirming a visit puts it on this calendar, moving a visit moves it, and " +
                "cancelling one takes it off.",
            style = AuntieTheme.typography.bodySmall,
            color = AuntieTheme.colors.textDim,
        )

        val label = googleCalendarAutoSyncLabel(connection)
        val failed = connection.calendarAutoSyncLastRunAt.isNotBlank() &&
            connection.calendarAutoSyncLastStatus != "ok"

        // The receipt comes from the SERVER's own stamp, so a sync that failed
        // yesterday still says so rather than looking like one that was never
        // attempted. "Never run" and "ran and did nothing" are different facts.
        Text(
            label ?: "No visit has changed since this calendar was chosen, so automatic sync has " +
                "not needed to run yet.",
            style = AuntieTheme.typography.bodySmall,
            color = if (failed) AuntieTheme.colors.error else AuntieTheme.colors.textDim,
        )

        if (failed && connection.calendarAutoSyncLastError.isNotBlank()) {
            Text(
                connection.calendarAutoSyncLastError,
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.error,
            )
        }

        state.visitSyncNote?.let { note ->
            Text(note, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
            GhostButton(label = "Dismiss", onClick = onDismissNote)
        }

        val retryId = retryableAutoSyncSessionId(connection)
        if (retryId != null) {
            GhostButton(
                label = if (state.retryingVisitSync) "Retrying..." else "Retry that visit",
                onClick = { onRetryVisit(retryId) },
                enabled = !state.retryingVisitSync,
            )
            Text(
                "Visit $retryId",
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.textDim,
            )
        } else if (failed) {
            Text(
                "That failure was about the connection rather than one visit, so there is nothing " +
                    "to retry on its own. Fix the problem above, then use Push to catch the " +
                    "calendar up.",
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.textDim,
            )
        }
    }
}
