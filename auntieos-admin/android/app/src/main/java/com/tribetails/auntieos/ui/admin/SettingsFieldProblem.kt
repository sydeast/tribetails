package com.tribetails.auntieos.ui.admin

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * #1593: the sentence under a Settings field that will not save, in the error
 * colour. Draws nothing when [message] is null, so a caller can pass its check
 * straight through. The words come from [SettingsChecks.kt], which are the
 * server's.
 */
@Composable
internal fun SettingsFieldProblem(message: String?, modifier: Modifier = Modifier) {
    if (message == null) return
    Text(
        message,
        style = AuntieTheme.typography.labelSmall,
        color = AuntieTheme.colors.error,
        modifier = modifier.testTag("settings-field-problem"),
    )
}

/**
 * The server's refusal of the last Settings save, kept on screen until the next
 * save (#1593). The toast says it too, but a toast goes away before the
 * operator has found the field it is about.
 */
@Composable
internal fun SettingsRefusalBanner(refusal: SettingsRefusal?) {
    if (refusal == null) return
    AuntieBanner(tone = AuntieBannerTone.Error, title = "Not saved") {
        Text(refusal.message, style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textPrimary)
    }
}
