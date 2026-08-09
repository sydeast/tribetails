package com.tribetails.auntieos.ui.admin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.TriangleAlert
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.config.FeatureFlags
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieToggle
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlinx.coroutines.launch

/** One togglable flag row: stable key + operator-facing label + what it gates. */
internal data class FlagMeta(val key: String, val label: String, val detail: String)

/** Operator-facing toggle rows: the genuinely-gated flags only. Built features that
 *  ship ON live in [FeatureFlags.ALWAYS_ON] and intentionally have no row (#3); they
 *  are not experimental. FeatureFlagsScreenCoverageTest keeps this == KEYS - ALWAYS_ON,
 *  so a new gated flag can never be silently missing. Mirrors the web FLAGS list. */
internal val FLAGS: List<FlagMeta> = listOf(
    FlagMeta(FeatureFlags.KEY_COMMUNICATE_COMMS_RECAP, "Communicate: AI comms recap", "AI-summarised 'where things last left off' box in the recipient-context panel (Phase 1)."),
    FlagMeta(FeatureFlags.KEY_INBOUND_COMMS_SERVER_AUTHORITATIVE, "Inbound comms: server authoritative (WARNING-8)", "ON = stop this device writing inbound call/voicemail/SMS records from FCM pushes; the server Twilio webhooks become the sole writer (closes the spoofed-push vuln). Flip ON only AFTER verifying the server path, or records may be lost."),
    FlagMeta(FeatureFlags.KEY_INBOX_WAITING_SECTIONS, "Inbox: waiting/answered sections", "ON (the default): message threads sit under \"Waiting on a reply\" and \"Answered\". OFF: one flat list, the arrangement before this. Both are finished; pick either. Shared with the web admin, and it takes effect on the next app load here."),
)

/**
 * What a row's toggle SHOWS for [key], given the raw override map
 * `repo.getFeatureFlags()` returned.
 *
 * That map is SPARSE: it holds only the keys somebody has actually written, so
 * a flag nobody has touched is absent from it. Reading that absence as "off"
 * was harmless while every gated flag defaulted off. The Inbox arrangement flag
 * defaults ON, and the same reading would draw its toggle OFF beside the
 * sections it gates, then turn the operator's first tap into a write of `true`
 * that changes nothing: a control that looks broken because it is being asked
 * to undo something already undone. Resolving through
 * [FeatureFlags.fromOverrides] makes the row show the value the app is running.
 */
internal fun flagRowValue(overrides: Map<String, Boolean>, key: String): Boolean =
    FeatureFlags.fromOverrides(overrides).toMap()[key] ?: false

/**
 * Admin Feature Flags screen (Android parity with web `FeatureFlagsScreen`). Lists the
 * central `auntieos.*` flags with live toggles, reading current values via getFeatureFlags
 * and writing via the admin-gated setFeatureFlags callable (Firestore
 * `business_settings/feature_flags`). Changes apply on the next app load.
 */
@Composable
fun FeatureFlagsScreen(onBack: () -> Unit) {
    val c = AuntieTheme.colors
    val repo = remember { AuntieOSApp.instance.repository }
    val scope = rememberCoroutineScope()

    var overrides by remember { mutableStateOf<Map<String, Boolean>?>(null) } // null = loading
    var error by remember { mutableStateOf<String?>(null) }
    var savingKey by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        repo.getFeatureFlags()
            .onSuccess { overrides = it; error = null }
            .onFailure { overrides = emptyMap(); error = it.message ?: "Feature-flag call failed" }
    }

    AuntieScreenScaffold(title = "Feature Flags", onBack = onBack, imePaddingEnabled = true) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 16.dp),
        ) {
            DenScreenHeading(
                kicker = "The Den · Admin",
                title = "Feature",
                accentTail = "flags.",
                subtitle = "Toggle the central auntieos.* flags. Writes business_settings/feature_flags; takes effect on the next app load.",
            )
            Spacer(Modifier.height(20.dp))

            error?.let {
                AuntieBanner(tone = AuntieBannerTone.Error, title = "Feature-flag call failed", icon = Lucide.TriangleAlert) {
                    Text(it, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
                Spacer(Modifier.height(16.dp))
            }

            DenPanel(
                title = "Central flags",
                subtitle = "Every flag here is a finished feature. Flipping it on switches it on, nothing left to build.",
            ) {
                val ov = overrides
                if (ov == null) {
                    EmptyHint("Loading flags…")
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        FLAGS.forEach { meta ->
                            val current = flagRowValue(ov, meta.key)
                            Row(
                                modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(12.dp),
                            ) {
                                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                    Text(meta.label, style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
                                    Text(meta.key, style = AuntieTheme.typography.labelSmall, color = c.textFaint)
                                    Text(meta.detail, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                                }
                                AuntieToggle(
                                    checked = current,
                                    enabled = savingKey == null,
                                    onCheckedChange = { newVal ->
                                        val prev = ov
                                        overrides = prev + (meta.key to newVal) // optimistic
                                        savingKey = meta.key
                                        scope.launch {
                                            repo.setFeatureFlags(mapOf(meta.key to newVal))
                                                .onSuccess { error = null }
                                                .onFailure { overrides = prev; error = it.message ?: "Save failed" } // revert
                                            savingKey = null
                                        }
                                    },
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
