package com.tribetails.auntieos.ui.admin

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import coil3.compose.AsyncImage
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.X
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieDialog
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.components.AuntieLoading
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.LoadingHint
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.components.WaitPhase
import com.tribetails.auntieos.ui.components.rememberSlowWait
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

/**
 * #957: Settings > Email frame on Android. The same fields as the web section
 * (`EmailFrameSection.tsx`): nine colors, a header line, a logo and the footer
 * line, with the server's own render of a sample email below them.
 *
 * Colors are hex fields with a swatch (Compose has no stock color picker, and
 * a hex field is exact). A blank field is the default, shown as its
 * placeholder; the swatch paints whatever will actually be sent.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun EmailFramePanel(
    vm: EmailFrameViewModel = viewModel { EmailFrameViewModel() },
) {
    val s by vm.state.collectAsState()
    when (val load = s.load) {
        EmailFrameViewModel.Load.Loading -> AuntieLoading(text = "Loading the email frame…", onSync = { vm.load() })
        is EmailFrameViewModel.Load.Failed -> AuntieBanner(
            tone = AuntieBannerTone.Error,
            title = "Email frame unavailable",
            icon = Lucide.X,
            trailing = { GhostButton(label = "Retry", onClick = { vm.load() }) },
            body = { Text(load.message, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim) },
        )
        is EmailFrameViewModel.Load.Ready -> EmailFrameEditor(vm, s, load.frame)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun EmailFrameEditor(
    vm: EmailFrameViewModel,
    s: EmailFrameViewModel.UiState,
    frame: com.tribetails.auntieos.data.repository.EmailFrameRepository.EmailFrameState,
) {
    val c = AuntieTheme.colors
    val t = AuntieTheme.typography
    val dims = AuntieTheme.dims
    val context = LocalContext.current
    val problems = emailFrameProblems(s.draft)
    val changes = emailFrameChanges(s.draft, frame.stored)
    val busy = s.busy != null
    var confirmReset by remember { mutableStateOf(false) }

    val logoPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) vm.uploadLogo(context, uri)
    }
    // D-2026-09-12-SLOW-WAIT: a long save offers to ask again, which re-sends
    // the write in flight (see EmailFrameViewModel.resend).
    val wait = rememberSlowWait(
        active = busy,
        retry = { vm.resend() },
    )

    DenPanel(
        title = "Email frame",
        subtitle = "The colors, header, logo and footer every email is sent in. Changes reach the next email sent.",
        detail = frame.updatedAt?.let { "Last saved ${it.take(10)}" + (frame.updatedBy?.let { by -> " by $by" } ?: "") }
            ?: "Using the default frame",
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(dims.space3)) {
            s.error?.let { msg ->
                AuntieBanner(tone = AuntieBannerTone.Error, title = "Save failed", icon = Lucide.X) {
                    Text(msg, style = t.bodySmall, color = c.textDim)
                }
            }

            Text("Colors", style = t.labelMedium, color = c.textDim)
            EmailFrameFields.COLORS.forEach { f ->
                val label = EmailFrameFields.LABELS[f] ?: f
                val shown = s.draft[f].orEmpty().ifBlank { frame.defaults[f].orEmpty() }
                val argb = emailFrameColorArgb(shown) ?: emailFrameColorArgb(frame.defaults[f].orEmpty())
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(dims.space2)) {
                    Box(
                        Modifier
                            .size(32.dp)
                            .clip(RoundedCornerShape(8.dp))
                            .background(argb?.let { Color(it) } ?: Color.Transparent)
                            .border(1.dp, c.border, RoundedCornerShape(8.dp))
                            .semantics { contentDescription = "$label swatch" },
                    )
                    AuntieField(
                        value = s.draft[f].orEmpty(),
                        onValueChange = { vm.edit(f, it.take(7)) },
                        label = label,
                        placeholder = frame.defaults[f].orEmpty(),
                        enabled = !busy,
                        isError = problems[f] != null,
                        modifier = Modifier.weight(1f),
                        fieldModifier = Modifier.testTag("emailFrame.$f"),
                    )
                    if (s.draft[f].orEmpty().isNotEmpty()) {
                        GhostButton(label = "Default", enabled = !busy, onClick = { vm.edit(f, "") })
                    }
                }
                problems[f]?.let { Text(it, style = t.bodySmall, color = c.error) }
            }

            Text("Header", style = t.labelMedium, color = c.textDim)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(dims.space2), verticalArrangement = Arrangement.spacedBy(dims.space2)) {
                val logo = s.draft[EmailFrameFields.LOGO_URL].orEmpty()
                if (logo.isNotEmpty()) {
                    AsyncImage(
                        model = logo,
                        contentDescription = "Email logo",
                        modifier = Modifier.width(120.dp).heightIn(max = 60.dp),
                    )
                }
                GhostButton(
                    label = if (logo.isEmpty()) "Upload logo" else "Replace logo",
                    enabled = !busy && !s.uploadingLogo,
                    onClick = { logoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                )
                if (logo.isNotEmpty()) {
                    GhostButton(label = "Remove", enabled = !busy, onClick = { vm.edit(EmailFrameFields.LOGO_URL, "") })
                }
            }
            if (s.uploadingLogo) LoadingHint("Uploading the logo…")
            s.uploadError?.let { Text(it, style = t.bodySmall, color = c.error) }
            AuntieField(
                value = s.draft[EmailFrameFields.HEADER_TEXT].orEmpty(),
                onValueChange = { vm.edit(EmailFrameFields.HEADER_TEXT, it.take(EmailFrameFields.HEADER_TEXT_MAX)) },
                label = "Header line",
                placeholder = "None",
                enabled = !busy,
                isError = problems[EmailFrameFields.HEADER_TEXT] != null,
                modifier = Modifier.fillMaxWidth(),
                fieldModifier = Modifier.testTag("emailFrame.headerText"),
            )
            problems[EmailFrameFields.HEADER_TEXT]?.let { Text(it, style = t.bodySmall, color = c.error) }

            Text("Footer", style = t.labelMedium, color = c.textDim)
            AuntieField(
                value = s.draft[EmailFrameFields.FOOTER_TEXT].orEmpty(),
                onValueChange = { vm.edit(EmailFrameFields.FOOTER_TEXT, it.take(EmailFrameFields.FOOTER_TEXT_MAX)) },
                label = "Footer line",
                placeholder = frame.defaults[EmailFrameFields.FOOTER_TEXT].orEmpty(),
                enabled = !busy,
                isError = problems[EmailFrameFields.FOOTER_TEXT] != null,
                modifier = Modifier.fillMaxWidth(),
                fieldModifier = Modifier.testTag("emailFrame.footerText"),
            )
            problems[EmailFrameFields.FOOTER_TEXT]?.let { Text(it, style = t.bodySmall, color = c.error) }

            if (busy && wait.phase == WaitPhase.Slow) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(dims.space2)) {
                    Text(
                        if (wait.attempt > 0) "Asked again. Still waiting on the server." else "The server has not answered yet.",
                        style = t.bodySmall,
                        color = c.textDim,
                        modifier = Modifier.weight(1f),
                    )
                    GhostButton(label = if (wait.attempt > 0) "Ask again" else "Sync now", onClick = wait.sync)
                }
            }

            FlowRow(horizontalArrangement = Arrangement.spacedBy(dims.space2), verticalArrangement = Arrangement.spacedBy(dims.space2)) {
                PrimaryButton(
                    label = when (s.busy) {
                        EmailFrameViewModel.Busy.Save -> "Saving…"
                        EmailFrameViewModel.Busy.Reset -> "Resetting…"
                        null -> "Save"
                    },
                    loading = busy,
                    enabled = !busy && changes.isNotEmpty() && problems.isEmpty(),
                    onClick = { vm.save() },
                )
                GhostButton(label = "Cancel", enabled = !busy && changes.isNotEmpty(), onClick = { vm.cancel() })
                GhostButton(
                    label = "Reset to default",
                    enabled = !busy && frame.stored.isNotEmpty(),
                    onClick = { confirmReset = true },
                )
            }
            s.savedNote?.let { Text(it, style = t.bodySmall, color = c.success) }

            Text("Preview", style = t.labelMedium, color = c.textDim)
            EmailFramePreview(
                frame = if (problems.isEmpty()) emailFramePreviewFrame(s.draft) else null,
                load = { vm.preview(it) },
            )
        }
    }

    AuntieDialog(
        visible = confirmReset,
        title = "Reset the email frame?",
        onDismiss = { confirmReset = false },
        footer = {
            GhostButton(label = "Keep my frame", onClick = { confirmReset = false })
            PrimaryButton(label = "Reset", onClick = { confirmReset = false; vm.reset() })
        },
    ) {
        Text(
            "Every color, the header, the logo and the footer go back to the default. The next email sent uses it.",
            style = t.bodyMedium,
            color = c.textPrimary,
        )
    }
}

/**
 * The server's render of a sample email in [frame]. A loading cue shows for
 * every request in flight, over the last render. [frame] null means the draft
 * has a field the server would refuse: nothing is sent and the last render
 * stays up. A newer request cancels the older one.
 */
@Composable
private fun EmailFramePreview(
    frame: Map<String, String>?,
    load: suspend (Map<String, String>) -> Result<com.tribetails.auntieos.data.repository.EmailFrameRepository.FramePreview>,
) {
    val c = AuntieTheme.colors
    var html by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableIntStateOf(0) }

    LaunchedEffect(frame, attempt) {
        if (frame == null) {
            loading = false
            return@LaunchedEffect
        }
        loading = true
        error = null
        delay(PREVIEW_DEBOUNCE_MS)
        val result = load(frame)
        if (!isActive) return@LaunchedEffect
        result
            .onSuccess { html = it.html }
            .onFailure { error = it.message ?: "The preview could not be loaded." }
        loading = false
    }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (loading) LoadingHint(PREVIEW_LOADING_TEXT)
        error?.let { msg ->
            AuntieBanner(
                tone = AuntieBannerTone.Error,
                title = "Preview unavailable",
                icon = Lucide.X,
                trailing = { GhostButton(label = "Retry", onClick = { attempt++ }) },
                body = { Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim) },
            )
        }
        html?.let { EmailHtmlView(it, Modifier.fillMaxWidth().height(520.dp)) }
    }
}
