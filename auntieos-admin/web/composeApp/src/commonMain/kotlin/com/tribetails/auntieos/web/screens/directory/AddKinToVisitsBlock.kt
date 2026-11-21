package com.tribetails.auntieos.web.screens.directory

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.addKinToVisitsConfirmLine
import com.tribetails.auntieos.web.data.addKinToVisitsLabel
import com.tribetails.auntieos.web.data.addedKinToVisitsLine
import com.tribetails.auntieos.web.data.kinMissingFromVisitsLine
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieSpinner
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.LoadErrorBanner
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import kotlinx.coroutines.launch

const val ADD_KIN_TO_VISITS_TAG = "add-kin-to-visits"

/**
 * #1822 (operator ruling 2026-11-20): the owner's "Add <Kin> to the N
 * upcoming visits" on the Kin's view, for visits booked before the Kin joined
 * the household. Asks the server how many upcoming visits lack the Kin; draws
 * nothing when none do. Asks first; the confirm reads "Adding…" and locks
 * while the call runs, and a refusal stays on the card. Same card as admin web
 * and admin Android.
 */
@Composable
fun AddKinToVisitsBlock(client: FirestoreClient, kinfolkId: String, kinId: String, kinName: String) {
    val c = AuntieTheme.colors
    val scope = rememberCoroutineScope()
    val name = kinName.ifBlank { "this Kin" }
    var reads by remember(kinfolkId, kinId) { mutableIntStateOf(0) }
    var loading by remember(kinfolkId, kinId) { mutableStateOf(true) }
    var loadError by remember(kinfolkId, kinId) { mutableStateOf<String?>(null) }
    var missing by remember(kinfolkId, kinId) { mutableIntStateOf(0) }
    var confirming by remember(kinfolkId, kinId) { mutableStateOf(false) }
    var adding by remember(kinfolkId, kinId) { mutableStateOf(false) }
    var addError by remember(kinfolkId, kinId) { mutableStateOf<String?>(null) }
    var done by remember(kinfolkId, kinId) { mutableStateOf<String?>(null) }

    LaunchedEffect(kinfolkId, kinId, reads) {
        loading = true
        loadError = null
        when (val r = client.addKinToUpcomingVisits(kinfolkId, kinId, apply = false)) {
            is WriteResult.Ok -> missing = r.value.upcoming
            is WriteResult.Err -> loadError = r.message
        }
        loading = false
    }

    done?.let { msg ->
        AuntieBanner(tone = AuntieBannerTone.Success, title = "Upcoming visits", onDismiss = { done = null }) {
            Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim)
        }
    }
    when {
        loading && missing == 0 -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            AuntieSpinner(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
            Text("Checking upcoming visits…", style = AuntieTheme.typography.bodySmall, color = c.textDim)
        }
        loadError != null -> LoadErrorBanner(
            title = "Couldn't check upcoming visits",
            message = loadError.orEmpty(),
            onRetry = { reads++ },
        )
        missing > 0 -> AuntieBanner(
            modifier = Modifier.testTag(ADD_KIN_TO_VISITS_TAG),
            tone = AuntieBannerTone.Info,
            title = "Upcoming visits",
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (!confirming) {
                    Text(kinMissingFromVisitsLine(name, missing), style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
                    PrimaryButton(label = addKinToVisitsLabel(name, missing), onClick = { confirming = true; addError = null })
                } else {
                    Text(addKinToVisitsConfirmLine(name, missing), style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        PrimaryButton(
                            label = if (adding) "Adding…" else "Add $name",
                            enabled = !adding,
                            loading = adding,
                            onClick = {
                                if (adding) return@PrimaryButton
                                adding = true
                                addError = null
                                scope.launch {
                                    when (val r = client.addKinToUpcomingVisits(kinfolkId, kinId, apply = true)) {
                                        is WriteResult.Ok -> {
                                            done = addedKinToVisitsLine(name, r.value.added)
                                            missing = (missing - r.value.added).coerceAtLeast(0)
                                            confirming = false
                                            reads++
                                        }
                                        is WriteResult.Err -> addError = r.message
                                    }
                                    adding = false
                                }
                            },
                        )
                        GhostButton(label = "Cancel", onClick = { confirming = false }, enabled = !adding)
                    }
                }
                addError?.let { Text(it, style = AuntieTheme.typography.bodySmall, color = c.error) }
            }
        }
    }
}
