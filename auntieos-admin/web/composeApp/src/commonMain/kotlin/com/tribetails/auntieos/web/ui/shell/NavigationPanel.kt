package com.tribetails.auntieos.web.ui.shell

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import com.tribetails.auntieos.web.observability.rememberReportingScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.ArrowDown
import com.composables.icons.lucide.ArrowUp
import com.composables.icons.lucide.Eye
import com.composables.icons.lucide.EyeOff
import com.composables.icons.lucide.Lucide
import com.tribetails.auntieos.web.data.AuthUser
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.UserProfile
import com.tribetails.auntieos.web.screens.settings.ProfileLoad
import com.tribetails.auntieos.web.screens.settings.baseline
import com.tribetails.auntieos.web.screens.settings.isLoaded
import com.tribetails.auntieos.web.screens.settings.profileNotReadyMessage
import com.tribetails.auntieos.web.screens.settings.rememberProfileLoad
import com.tribetails.auntieos.web.ui.components.LoadErrorBanner
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieIconButton
import com.tribetails.auntieos.web.ui.components.AuntieSaveBar
import com.tribetails.auntieos.web.ui.components.AuntieStatusPill
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.GhostButton
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * 17.4 Nav editor (web/desktop). Reorder / rename / show-hide the side-rail links,
 * persisted per-admin to UserProfile.navConfig. Edits are staged locally and committed
 * by the Save bar in one write (copied onto the loaded profile so theme/branding/etc are
 * never clobbered). Leaving everything at default keeps navConfig empty, so the rail
 * renders its shipped grouped layout. Fail loud on a save failure.
 */
@Composable
fun NavigationPanel(authUser: AuthUser) {
    val c = AuntieTheme.colors
    val client = remember { FirestoreClient() }
    val scope = rememberReportingScope()
    val saveMutex = remember { Mutex() }
    val defaultKeys = remember { navEditableDestinations.map { it.name } }

    // #897: pending, failed and "no document" stay distinct; see ProfileLoad.
    val profileHandle = rememberProfileLoad(client, authUser.uid)
    val profileLoad = profileHandle.load
    val profile = profileLoad.baseline

    val baseline = resolvedNav(profile?.navConfig ?: emptyList(), defaultKeys)
    // Re-seed only when the saved navConfig itself changes (not on any unrelated profile
    // field write), so an in-flight edit is not reset by a sibling pref save.
    var entries by remember(profile?.navConfig) { mutableStateOf(baseline) }
    var navError by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    val dirty = entries != baseline

    DenPanel(
        title = "Navigation",
        subtitle = "Reorder, rename, or hide the links in your side menu. Leave it untouched to keep the standard layout.",
        trailing = { AuntieStatusPill(label = "Your menu", tone = AuntieStatusTone.Teal, mono = true) },
    ) {
        Column {
            (profileLoad as? ProfileLoad.Failed)?.let {
                LoadErrorBanner(
                    "Couldn't load your profile",
                    it.message,
                    onRetry = profileHandle.retry,
                    retrying = profileHandle.retrying,
                )
                Spacer(Modifier.height(12.dp))
            }
            entries.forEachIndexed { i, e ->
                val fallback = destinationByName(e.key)?.title ?: e.key
                Row(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    BottomBorderField(
                        value = e.label(fallback),
                        onValueChange = { entries = renameNav(entries, e.key, it) },
                        label = fallback,
                        modifier = Modifier.weight(1f),
                    )
                    AuntieIconButton(Lucide.ArrowUp, "Move $fallback up", { entries = moveNavUp(entries, i) }, size = 30.dp, enabled = i > 0)
                    AuntieIconButton(Lucide.ArrowDown, "Move $fallback down", { entries = moveNavDown(entries, i) }, size = 30.dp, enabled = i < entries.lastIndex)
                    AuntieIconButton(Lucide.EyeOff, "Hide $fallback", { entries = hideNav(entries, e.key) }, size = 30.dp, destructive = true)
                }
            }

            val hidden = hiddenNavKeys(entries, defaultKeys)
            if (hidden.isNotEmpty()) {
                Spacer(Modifier.height(12.dp))
                Text("Hidden links", style = AuntieTheme.typography.labelSmall, color = c.textFaint)
                Spacer(Modifier.height(6.dp))
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    hidden.forEach { k ->
                        GhostButton(
                            label = destinationByName(k)?.title ?: k,
                            onClick = { entries = showNav(entries, k) },
                            leading = { androidx.compose.material3.Icon(Lucide.Eye, contentDescription = null, modifier = Modifier.height(14.dp)) },
                        )
                    }
                }
            }

            navError?.let { msg ->
                Spacer(Modifier.height(12.dp))
                AuntieBanner(tone = AuntieBannerTone.Error, title = "Navigation not saved") {
                    Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
            }

            Spacer(Modifier.height(14.dp))
            AuntieSaveBar(
                dirty = dirty,
                saveEnabled = dirty && !saving && profileLoad.isLoaded,
                onCancel = { entries = baseline },
                onSave = {
                    val load = profileLoad
                    if (load !is ProfileLoad.Loaded) {
                        navError = profileNotReadyMessage(load, "your change was not saved")
                    } else {
                        saving = true
                        val base = load.profile ?: UserProfile(uid = authUser.uid, email = authUser.email.orEmpty())
                        val next = base.copy(navConfig = entries.toNavTokens())
                        scope.launch {
                            saveMutex.withLock {
                                // #897: writes navConfig (and its stamp) only.
                                when (val r = client.updateUserProfile(authUser.uid, load.profile, next)) {
                                    is WriteResult.Err -> navError = "Navigation not saved: ${r.message}"
                                    is WriteResult.Ok -> { navError = null; profileHandle.saved(next) }
                                }
                            }
                            saving = false
                        }
                    }
                },
                dirtyLabel = "Unsaved navigation",
                savedLabel = "Navigation saved",
            )
        }
    }
}
