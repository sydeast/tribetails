package com.tribetails.auntieos.ui.directory

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.domain.addKinToVisitsConfirmLine
import com.tribetails.auntieos.domain.addKinToVisitsLabel
import com.tribetails.auntieos.domain.kinMissingFromVisitsLine
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * #1822 (operator ruling 2026-11-20): the owner's "Add <Kin> to the N
 * upcoming visits" on the Kin's own page, for visits booked before the Kin
 * joined the household. Asks first; the confirm reads "Adding…" and locks
 * while [inFlight]. [error] is the server's refusal, shown on the card. Same
 * card as the web band (`AddKinToUpcomingVisits.tsx`).
 */
@Composable
fun AddKinToVisitsCard(
    kinName: String,
    count: Int,
    inFlight: Boolean,
    error: String?,
    onAdd: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = AuntieTheme.colors
    val name = kinName.ifBlank { "this Kin" }
    var confirming by remember { mutableStateOf(false) }
    AuntieBanner(modifier = modifier.testTag("add-kin-to-visits"), tone = AuntieBannerTone.Info, title = "Upcoming visits") {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (!confirming) {
                Text(kinMissingFromVisitsLine(name, count), style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
                PrimaryButton(label = addKinToVisitsLabel(name, count), onClick = { confirming = true }, enabled = !inFlight)
            } else {
                Text(addKinToVisitsConfirmLine(name, count), style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PrimaryButton(
                        label = if (inFlight) "Adding…" else "Add $name",
                        onClick = onAdd,
                        enabled = !inFlight,
                        loading = inFlight,
                    )
                    GhostButton(label = "Cancel", onClick = { confirming = false }, enabled = !inFlight)
                }
            }
            error?.let { Text(it, style = AuntieTheme.typography.bodySmall, color = c.error) }
        }
    }
}
