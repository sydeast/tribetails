package com.tribetails.auntieos.ui.kintales

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieSpinner
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * What a KinTale notification's "Open" resolves through.
 *
 * The notification names a REPORT. [KinTaleReportScreen] is keyed by SESSION,
 * because in every other part of the app you reach a recap from the visit it
 * belongs to. Nothing bridged the two, so a kintale notification's Open dropped
 * the id and opened the KinTales LIST, which is the operator's complaint in
 * issue #389 word for word: the button opened the feature, not the record.
 *
 * The bridge is a field, not a derivation: `kin_care_reports/{id}.sessionId`
 * names the visit. So this reads the report once, then renders the real screen
 * with both ids.
 *
 * THE MISS IS VISIBLE. A report that no longer exists, or that this account may
 * not read, gets a sentence saying so and a way back. It never falls through to
 * the list, because a silent redirect to a list is indistinguishable from the
 * bug this screen exists to fix.
 */
private sealed interface ResolveState {
    data object Loading : ResolveState
    data class Found(val sessionId: String) : ResolveState
    data class Missing(val message: String) : ResolveState
}

@Composable
fun KinTaleByReportScreen(
    reportId: String,
    onBack: () -> Unit,
) {
    val kinCareRepo = AuntieOSApp.instance.kinCareRepository
    var state by remember(reportId) { mutableStateOf<ResolveState>(ResolveState.Loading) }

    LaunchedEffect(reportId) {
        state = ResolveState.Loading
        val read = kinCareRepo.getKinCareReport(reportId)
        val report = read.getOrNull()
        state = when {
            // A read that FAILED and a read that found NOTHING are told apart on
            // purpose: one is worth retrying and the other is not, and the
            // KinTaleReportViewModel already refuses to conflate them for the
            // same reason (a transient failure once looked like a blank draft).
            read.isFailure ->
                ResolveState.Missing("This KinTale couldn't be loaded. Check your connection and try again.")
            report == null ->
                ResolveState.Missing("This KinTale is no longer available. It may have been deleted.")
            report.sessionId.isBlank() ->
                ResolveState.Missing("This KinTale isn't linked to a visit, so there's nothing to open it against.")
            else -> ResolveState.Found(report.sessionId)
        }
    }

    when (val current = state) {
        is ResolveState.Found ->
            KinTaleReportScreen(
                sessionId = current.sessionId,
                existingReportId = reportId,
                onBack = onBack,
            )
        is ResolveState.Loading ->
            AuntieScreenScaffold(title = "KinTale", onBack = onBack) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    AuntieSpinner(
                        modifier = Modifier.size(32.dp),
                        color = AuntieTheme.colors.kinfolkOrange,
                    )
                }
            }
        is ResolveState.Missing ->
            AuntieScreenScaffold(title = "KinTale", onBack = onBack) {
                Column(
                    modifier = Modifier.fillMaxSize().padding(24.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        text = current.message,
                        color = AuntieTheme.colors.textPrimary.copy(alpha = 0.7f),
                    )
                    GhostButton(label = "Back", onClick = onBack)
                }
            }
    }
}
