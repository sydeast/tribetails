package com.tribetails.auntieos.web.screens.kintales

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.PawPrint
import com.composables.icons.lucide.Lucide
import com.tribetails.auntieos.web.data.AuntieDataSource
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.KinCareReport
import com.tribetails.auntieos.web.ui.components.LoadErrorBanner
import com.tribetails.auntieos.web.ui.components.NotFoundNotice
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.SectionHeader
import com.tribetails.auntieos.web.ui.components.ShimmerCard
import com.tribetails.auntieos.web.ui.components.rememberReloadableRead
import com.tribetails.auntieos.web.ui.components.settlesRetry

/**
 * #2355: a KinTale notification names the KinTale by its REPORT id, and the
 * report screen is opened by the visit's SESSION id. Open on the Notifications
 * list handed the report id over as if it were a session id, so the screen
 * looked for a visit that does not exist and showed nothing of the KinTale.
 * Admin Android had the same gap and closed it the same way (#389,
 * `Screen.KinTaleByReport`).
 *
 * What the reports read says about one report id. Pure; unit-tested.
 */
sealed class KinTaleReportLookup {
    data object Loading : KinTaleReportLookup()
    data class Failed(val message: String) : KinTaleReportLookup()
    /** The read answered and the report is not in it: deleted, or never this console's to see. */
    data object Missing : KinTaleReportLookup()
    data class Found(val sessionId: String, val reportId: String) : KinTaleReportLookup()
}

fun kinTaleReportLookup(reports: FirestoreResult<List<KinCareReport>>, reportId: String): KinTaleReportLookup =
    when (reports) {
        FirestoreResult.Loading -> KinTaleReportLookup.Loading
        is FirestoreResult.Error -> KinTaleReportLookup.Failed(reports.message)
        is FirestoreResult.Data -> {
            val report = reports.value.firstOrNull { it._id == reportId.trim() && reportId.isNotBlank() }
            val sessionId = report?.sessionId?.trim().orEmpty()
            // A report with no visit behind it has no report screen to open.
            if (report == null || sessionId.isEmpty()) KinTaleReportLookup.Missing
            else KinTaleReportLookup.Found(sessionId, report._id)
        }
    }

/** The KinTale a notification is about: its report screen, or a plain word that it is gone. */
@Composable
fun KinTaleByReportScreen(
    reportId: String,
    dataSource: AuntieDataSource,
    onBack: () -> Unit,
    client: FirestoreClient = remember { FirestoreClient() },
) {
    val reload = rememberReloadableRead()
    val reports by remember(reload.generation) { client.reportsStream().settlesRetry(reload) }
        .collectAsState(initial = FirestoreResult.Loading)
    when (val found = kinTaleReportLookup(reports, reportId)) {
        is KinTaleReportLookup.Found -> KinTaleReportScreen(
            sessionId = found.sessionId,
            dataSource = dataSource,
            onBack = onBack,
            initialReportId = found.reportId,
        )
        is KinTaleReportLookup.Failed -> ScreenScaffold {
            SectionHeader(title = "KinTale", subtitle = "", icon = Lucide.PawPrint, onBack = onBack)
            LoadErrorBanner("Couldn't load this KinTale", found.message, onRetry = reload::retry, retrying = reload.retrying)
        }
        KinTaleReportLookup.Missing -> ScreenScaffold {
            SectionHeader(title = "KinTale", subtitle = "", icon = Lucide.PawPrint, onBack = onBack)
            NotFoundNotice("This KinTale couldn't be found. It may have been removed.", onBack = onBack)
        }
        KinTaleReportLookup.Loading -> ScreenScaffold {
            SectionHeader(title = "Loading…", subtitle = "Pulling the KinTale", icon = Lucide.PawPrint)
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                repeat(4) { ShimmerCard(height = 72.dp) }
            }
        }
    }
}
