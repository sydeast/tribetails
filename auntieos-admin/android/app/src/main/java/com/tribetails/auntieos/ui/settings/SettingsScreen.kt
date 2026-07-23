package com.tribetails.auntieos.ui.settings

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tribetails.auntieos.BuildConfig
import io.sentry.Sentry
import com.tribetails.auntieos.ui.components.*
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme

@Composable
fun SettingsScreen(
    viewModel: SettingsViewModel,
    onNavigateToAdminDashboard: () -> Unit = {}
) {
    val state by viewModel.uiState.collectAsState()
    val context = LocalContext.current

    var urlDraft by remember(state.baseUrl) { mutableStateOf(state.baseUrl) }
    var copyConfirm by remember { mutableStateOf(false) }

    AuntieScreenScaffold(title = "Settings") {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp, vertical = 24.dp),
        verticalArrangement = Arrangement.spacedBy(24.dp)
    ) {
        PrimaryButton(
            label = "Go to Admin Dashboard",
            onClick = onNavigateToAdminDashboard,
            modifier = Modifier.fillMaxWidth()
        )

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .background(AuntieTheme.colors.surface)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Text("FCM DEVICE TOKEN", style = AuntieTheme.typography.labelSmall)
            Text(
                "Copy this and paste it into the FCM_DEVICE_TOKEN environment variable in your Twilio Function.",
                style = AuntieTheme.typography.bodySmall
            )

            if (state.fcmToken.isBlank()) {
                Text(
                    "Token not yet registered. Launch the app once with internet access.",
                    color = AuntieTheme.colors.error,
                    style = AuntieTheme.typography.bodySmall
                )
            } else {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(6.dp))
                        .background(AuntieTheme.colors.surface2)
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        state.fcmToken,
                        style = AuntieTheme.typography.bodySmall.copy(
                            fontFamily = FontFamily.Monospace,
                            fontSize   = 11.sp,
                            color      = AuntieTheme.colors.textPrimary
                        ),
                        modifier = Modifier.weight(1f)
                    )
                    AuntieIconBtn(
                        onClick = {
                            copyToClipboard(context, state.fcmToken)
                            copyConfirm = true
                        },
                        modifier = Modifier.size(36.dp)
                    ) {
                        Icon(Lucide.Copy, contentDescription = "Copy token", tint = AuntieTheme.colors.kinfolkOrange)
                    }
                }
                if (copyConfirm) {
                    LaunchedEffect(copyConfirm) {
                        kotlinx.coroutines.delay(2000)
                        copyConfirm = false
                    }
                    Text("Copied!", color = AuntieTheme.colors.success, style = AuntieTheme.typography.bodySmall)
                }
            }
        }

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .background(AuntieTheme.colors.surface)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Text("TUNNEL URL", style = AuntieTheme.typography.labelSmall)

            AuntieField(
                value = urlDraft,
                onValueChange = { urlDraft = it },
                modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { viewModel.saveBaseUrl(urlDraft) })
            )

            val baseUrlError by viewModel.baseUrlError.collectAsState()
            baseUrlError?.let { err ->
                Text(err, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.error)
            }

            PrimaryButton(
                label = "Save",
                onClick = { viewModel.saveBaseUrl(urlDraft) },
                modifier = Modifier.align(Alignment.End)
            )
        }

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .background(AuntieTheme.colors.surface)
                .padding(16.dp)
        ) {
            Text("APP VERSION", style = AuntieTheme.typography.labelSmall)
            Spacer(Modifier.height(6.dp))
            Text(
                "AuntieOS v${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
                style = AuntieTheme.typography.bodyMedium
            )
        }

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .background(AuntieTheme.colors.surface)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text("APPEARANCE", style = AuntieTheme.typography.labelSmall)
            val themeMode by viewModel.themeMode.collectAsState()
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                com.tribetails.auntieos.ui.theme.ThemeMode.entries.forEach { mode ->
                    AuntieChip(
                        selected = themeMode == mode,
                        onClick  = { viewModel.saveThemeMode(mode) },
                        label    = mode.name.lowercase().replaceFirstChar { it.uppercaseChar() },
                        modifier = Modifier.weight(1f),
                    )
                }
            }
            val themeSyncError by viewModel.themeSyncError.collectAsState()
            themeSyncError?.let { err ->
                Text(
                    err,
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.error,
                )
            }

            // ── 17.1 personalization: accent / density / text size ──
            val personalization by viewModel.personalization.collectAsState()
            val isDark = AuntieTheme.colors.isDark

            Spacer(Modifier.height(4.dp))
            Text("Accent color", style = AuntieTheme.typography.titleSmall, color = AuntieTheme.colors.textPrimary)
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                AccentChoice.entries.forEach { choice ->
                    val selected = choice == personalization.accent
                    val grad = choice.gradientColors(AuntieTheme.colors)
                    Box(
                        modifier = Modifier
                            .size(32.dp)
                            .clip(RoundedCornerShape(999.dp))
                            .then(
                                if (grad != null) Modifier.background(androidx.compose.ui.graphics.Brush.horizontalGradient(grad))
                                else Modifier.background(choice.colorFor(isDark)),
                            )
                            .border(
                                width = if (selected) 2.5.dp else AuntieTheme.dims.borderHairline,
                                color = if (selected) AuntieTheme.colors.textPrimary else AuntieTheme.colors.border,
                                shape = RoundedCornerShape(999.dp),
                            )
                            .clickable { viewModel.saveAccent(choice) },
                    )
                }
            }

            Text("Density", style = AuntieTheme.typography.titleSmall, color = AuntieTheme.colors.textPrimary)
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                DensityChoice.entries.forEach { choice ->
                    AuntieChip(
                        selected = choice == personalization.density,
                        onClick  = { viewModel.saveDensity(choice) },
                        label    = choice.label,
                        modifier = Modifier.weight(1f),
                    )
                }
            }

            Text("Text size", style = AuntieTheme.typography.titleSmall, color = AuntieTheme.colors.textPrimary)
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FontScaleChoice.entries.forEach { choice ->
                    AuntieChip(
                        selected = choice == personalization.fontScale,
                        onClick  = { viewModel.saveFontScale(choice) },
                        label    = choice.label,
                        modifier = Modifier.weight(1f),
                    )
                }
            }

            val appearanceSyncError by viewModel.appearanceSyncError.collectAsState()
            appearanceSyncError?.let { err ->
                Text(err, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.error)
            }
        }

        if (BuildConfig.DEBUG) {
            Spacer(Modifier.height(16.dp))
            PrimaryButton(
                label = "Test Sentry (debug only)",
                onClick = { Sentry.captureException(RuntimeException("sentry-test")) },
                modifier = Modifier.fillMaxWidth()
            )
        }
    }
    }
}

private fun copyToClipboard(context: Context, text: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("FCM Token", text))
}
