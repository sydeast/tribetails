package com.tribetails.auntieos.web.screens.admin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import com.tribetails.auntieos.web.observability.rememberReportingScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.TriangleAlert
import com.tribetails.auntieos.web.config.FeatureFlags
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieToggle
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.DenScreenHeading
import com.tribetails.auntieos.web.ui.components.EmptyHint
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import kotlinx.coroutines.launch

/** One togglable flag row: stable key + operator-facing label + what it gates. */
internal data class FlagMeta(val key: String, val label: String, val detail: String)

/** Operator-facing toggle rows: the genuinely-gated flags only. Built features that
 *  ship ON live in [FeatureFlags.ALWAYS_ON] and intentionally have no row (#3); they
 *  are not experimental. FeatureFlagsScreenCoverageTest keeps this == KEYS - ALWAYS_ON,
 *  so a new gated flag can never be silently missing from the admin toggles. */
internal val FLAGS: List<FlagMeta> = listOf(
    FlagMeta(FeatureFlags.KEY_COMMUNICATE_COMMS_RECAP, "Communicate: comms recap", "AI-generated 1-2 sentence recap of recent communications in the recipient context panel (recap_recent_comms callable)."),
)

/**
 * Admin Feature Flags screen. Lists the central `auntieos.*` flags with live
 * toggles, reading current values via getFeatureFlags and writing via the
 * admin-gated setFeatureFlags callable (Firestore `business_settings/feature_flags`).
 * Changes apply on the next app load (flags are fetched at startup).
 */
@Composable
fun FeatureFlagsScreen() {
    val c = AuntieTheme.colors
    val client = remember { FirestoreClient() }
    val scope = rememberReportingScope()

    var overrides by remember { mutableStateOf<Map<String, Boolean>?>(null) } // null = loading
    var error by remember { mutableStateOf<String?>(null) }
    var savingKey by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        when (val r = client.getFeatureFlags()) {
            is WriteResult.Ok -> { overrides = r.value; error = null }
            is WriteResult.Err -> { overrides = emptyMap(); error = r.message }
        }
    }

    ScreenScaffold {
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
            if (overrides == null) {
                EmptyHint("Loading flags…")
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    FLAGS.forEach { meta ->
                        val current = overrides?.get(meta.key) ?: false
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(meta.label, style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
                                Text(meta.key, style = AuntieTheme.typography.mono, color = c.textFaint)
                                Text(meta.detail, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                            }
                            AuntieToggle(
                                checked = current,
                                enabled = savingKey == null,
                                onCheckedChange = { newVal ->
                                    val prev = overrides ?: emptyMap()
                                    overrides = prev + (meta.key to newVal) // optimistic
                                    savingKey = meta.key
                                    scope.launch {
                                        when (val r = client.setFeatureFlags(mapOf(meta.key to newVal))) {
                                            is WriteResult.Ok -> error = null
                                            is WriteResult.Err -> { overrides = prev; error = r.message } // revert
                                        }
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
