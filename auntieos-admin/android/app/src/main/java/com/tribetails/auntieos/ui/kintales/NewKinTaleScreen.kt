package com.tribetails.auntieos.ui.kintales

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.composables.icons.lucide.ChevronRight
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.FileText
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.domain.freeTextDateLabel
import com.tribetails.auntieos.ui.components.AuntieEmptyState
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieSpinner
import com.tribetails.auntieos.ui.components.AuntieTextBtn
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * Pick the visit a new KinTale is about, then hand off to the composer.
 *
 * This screen writes nothing. It exists because [KinTaleReportViewModel] is keyed
 * by a session and the household profile's "New KinTale" does not have one; see
 * [NewKinTaleViewModel]'s header for why that is the whole of the gap.
 *
 * [onPickSession] navigates to the existing `kintale/{sessionId}` composer, so
 * everything a KinTale is - template, headline, body, kin moods, photos, the AI
 * draft, autosave, the send confirm - stays in the one surface that already does
 * it, on both the profile route and the routes that were already there.
 */
@Composable
fun NewKinTaleScreen(
    kinfolkId: String,
    onBack: () -> Unit,
    onPickSession: (sessionId: String) -> Unit,
    viewModel: NewKinTaleViewModel = viewModel(),
) {
    val state by viewModel.uiState.collectAsState()

    LaunchedEffect(kinfolkId) { viewModel.load(kinfolkId) }

    AuntieScreenScaffold(title = "New KinTale", onBack = onBack) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 16.dp),
        ) {
            Spacer(Modifier.height(12.dp))
            Text(
                text = "Which visit is this about?",
                style = AuntieTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                color = AuntieTheme.colors.textPrimary,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                text = pickerSubtitle(state),
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.textDim,
            )
            Spacer(Modifier.height(16.dp))

            when {
                state.isLoading -> Box(
                    modifier = Modifier.fillMaxWidth(),
                    contentAlignment = Alignment.Center,
                ) {
                    AuntieSpinner(
                        modifier = Modifier.size(32.dp),
                        color = AuntieTheme.colors.kinfolkOrange,
                    )
                }

                // A read that FAILED is not a household with no visits. Saying so,
                // and offering the retry, is the difference between "there is
                // nothing to write up" and "we could not ask".
                state.error != null -> AuntieEmptyState(
                    title = "Couldn't load visits",
                    message = state.error,
                    icon = Lucide.FileText,
                    action = {
                        AuntieTextBtn(onClick = { viewModel.retry() }) { Text("Retry") }
                    },
                )

                state.isEmpty -> AuntieEmptyState(
                    title = "No visits to write up yet",
                    message = emptyMessage(state),
                    icon = Lucide.FileText,
                )

                else -> LazyColumn(
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    contentPadding = PaddingValues(bottom = 24.dp),
                ) {
                    items(state.sessions, key = { it.id }) { session ->
                        SessionPickRow(
                            session = session,
                            showHousehold = state.kinfolkId.isBlank(),
                            onClick = { onPickSession(session.id) },
                        )
                    }
                }
            }
        }
    }
}

/**
 * Names the household when this picker was opened from one, so the operator can
 * see at a glance that they did not land in every household's visits.
 * The name comes off the sessions, so it is absent until they arrive and absent
 * when there are none, and the copy holds up in both cases.
 */
internal fun pickerSubtitle(state: NewKinTaleUiState): String = when {
    state.kinfolkId.isBlank() -> "A KinTale always starts from a visit that has already happened."
    state.householdName.isBlank() -> "Visits for this household that have already happened."
    else -> "Visits for ${state.householdName} that have already happened."
}

/** Empty-state copy, which differs by whether one household or all of them came back bare. */
internal fun emptyMessage(state: NewKinTaleUiState): String =
    if (state.kinfolkId.isBlank()) {
        "Nothing has departed or completed yet. Once a visit ends, it shows up here."
    } else {
        "This household has no departed or completed visit to recap. Once a visit ends, it shows up here."
    }

@Composable
private fun SessionPickRow(
    session: KinCareSession,
    showHousehold: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(AuntieTheme.colors.surface)
            .clickable(onClick = onClick)
            .padding(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = sessionPickPrimaryLabel(session, showHousehold),
                style = AuntieTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                color = AuntieTheme.colors.textPrimary,
            )
            Text(
                text = sessionPickMetaLabel(session, showHousehold),
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.textDim,
            )
        }
        Icon(
            Lucide.ChevronRight,
            contentDescription = null,
            tint = AuntieTheme.colors.textDim,
            modifier = Modifier.size(18.dp),
        )
    }
}

/**
 * The row's headline.
 *
 * Household-scoped, every row is the same household, so the SERVICE leads and the
 * name would just repeat down the list. Unscoped, the household is what
 * distinguishes one row from the next, so it leads instead.
 */
internal fun sessionPickPrimaryLabel(session: KinCareSession, showHousehold: Boolean): String {
    val service = session.serviceType.ifBlank { "Visit" }
    if (!showHousehold) return service
    return session.kinfolkName.ifBlank { "Unnamed household" }
}

/**
 * The row's second line: the date, plus the service only when the headline did
 * not already carry it. Repeating "Dog Walk" twice in one row is noise, and a
 * blank `startTime` says so rather than rendering an empty line.
 */
internal fun sessionPickMetaLabel(session: KinCareSession, showHousehold: Boolean): String {
    val date = freeTextDateLabel(session.startTime).ifBlank { "Date not recorded" }
    if (!showHousehold) return date
    return "$date  ${session.serviceType.ifBlank { "Visit" }}"
}
