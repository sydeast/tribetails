package com.tribetails.auntieos.ui.admin.scheduling

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.data.repository.ScheduleOverrideKind
import com.tribetails.auntieos.data.repository.scheduleOverrideHint
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * The one banner every schedule WRITE refusal comes back through — blocking a
 * window, unblocking one, moving a visit (#574, #575).
 *
 * IT CARRIES THE SERVER'S OWN SENTENCE, unchanged. The guards behind these
 * writes name the visit, the window or the holiday they refused for, and that
 * naming is the whole value of the refusal; a friendlier summary composed here
 * would throw it away.
 *
 * THE RETRY BUTTON IS DRAWN ONLY WHEN [override] IS NON-NULL, and that is the
 * asymmetry this component exists to keep. A visit already on the books and a
 * Google Calendar busy import are judgement calls the server cannot make alone,
 * so they have an override and the server audits it. A COMPANY CLOSURE DOES
 * NOT: `guardCompanyHolidayConflict` has no override parameter at all, so a
 * "Block anyway" next to it would be a button that re-sends the identical
 * request and fails identically — the dead control the Buttons convention
 * exists to prevent. The decision is made by `overridableScheduleRefusal`
 * reading `details.code`, never by reading the wording.
 */
@Composable
fun ScheduleWriteBanner(
    message: String?,
    override: ScheduleOverrideKind?,
    busy: Boolean,
    /** Names the action that failed, in the React admin's own wording: "Couldn't move that visit". */
    title: String,
    overrideLabel: String,
    onOverride: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    if (message == null) return
    AuntieBanner(
        modifier = modifier
            .fillMaxWidth()
            // The refusal arrives after a button press with no other visible
            // change, so TalkBack has to be told it appeared.
            .semantics { liveRegion = LiveRegionMode.Assertive },
        tone = AuntieBannerTone.Error,
        title = title,
        onDismiss = onDismiss,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                text = message,
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.textPrimary,
            )
            if (override != null) {
                Text(
                    text = scheduleOverrideHint(override),
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textPrimary,
                )
                GhostButton(label = overrideLabel, onClick = onOverride, enabled = !busy)
            }
        }
    }
}
