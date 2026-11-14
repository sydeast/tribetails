package com.tribetails.auntieos.ui.admin

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.domain.CLOCK_STEP_WARNING_TITLE
import com.tribetails.auntieos.domain.ClockStep
import com.tribetails.auntieos.domain.clockStepWarning
import com.tribetails.auntieos.ui.components.AuntieModal
import com.tribetails.auntieos.ui.components.AuntieTextBtn
import java.time.ZoneId

/**
 * #2039: the warning for a clock tap on [session] right now, or null when the
 * tap fits the booking. The caller writes straight away on null, exactly as it
 * did before, and asks [ClockStepWarningDialog] first otherwise.
 */
internal fun clockStepWarningFor(
    step: ClockStep,
    session: KinCareSession,
    zone: ZoneId,
    nowMs: Long = System.currentTimeMillis(),
): String? = clockStepWarning(
    step = step,
    startTime = session.startTime,
    endTime = session.endTime,
    serviceDurationMinutes = session.serviceDurationMinutes,
    arrivedAt = session.arrivedAt,
    nowMs = nowMs,
    zone = zone,
)

/**
 * #2039: "Check the time". A warning, never a refusal: confirming runs the
 * same write the tap would have, and "Not yet" leaves the visit alone.
 */
@Composable
internal fun ClockStepWarningDialog(
    step: ClockStep,
    warning: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AuntieModal(
        onDismissRequest = onDismiss,
        title = CLOCK_STEP_WARNING_TITLE,
        confirmButton = {
            AuntieTextBtn(onClick = onConfirm) {
                Text(if (step == ClockStep.DEPARTED) "Yes, clock out" else "Yes, clock in")
            }
        },
        dismissButton = { AuntieTextBtn(onClick = onDismiss) { Text("Not yet") } },
    ) {
        Text(warning)
    }
}
