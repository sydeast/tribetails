package com.tribetails.auntieos.ui.admin

import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import coil3.compose.AsyncImage
import com.composables.icons.lucide.Lock
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.X
import com.tribetails.auntieos.data.repository.TemplateRepository
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieChip
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.components.AuntieFieldLabel
import com.tribetails.auntieos.ui.components.DenCrumb
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.GlassSurface
import com.tribetails.auntieos.ui.components.LoadingHint
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.components.TagAssignField
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

internal const val PREVIEW_DEBOUNCE_MS = 700L
internal const val PREVIEW_LOADING_TEXT = "Loading preview…"
internal const val VISUAL_SAVE_TAG = "visual-save"
internal const val PREVIEW_WEB_TAG = "email-preview-web"
internal fun blockTag(index: Int) = "email-block-$index"
internal fun imageTag(index: Int) = "email-image-$index"

/** An inline image shows as this glyph in a text field: same length as [EMAIL_IMAGE_CHAR], so offsets map 1:1. */
private const val IMAGE_GLYPH = '▣'

/**
 * #953 PR 5: the Android editor for a visual template (spec, "Admin Android").
 *
 * Subject and headline are plain fields. The body is its blocks, in order, and
 * nothing adds, removes or moves one. Text blocks change words only (see
 * [applyBlockEdit]); a button's label changes and its target is shown locked;
 * images and shapes the phone does not model are shown locked. The preview is
 * the server's own render, in a WebView. Save sends [visualTemplateToSave],
 * which writes back every field the operator did not change exactly as loaded.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun VisualTemplateEditorScreen(
    template: TemplateRepository.EmailTemplate,
    categories: List<String>,
    saving: Boolean,
    saveError: String?,
    onDismissError: () -> Unit,
    onDismiss: () -> Unit,
    onSave: (TemplateRepository.EmailTemplate) -> Unit,
    loadPreview: suspend (EmailPreviewRequest) -> Result<TemplateRepository.EmailPreview>,
    previewDebounceMs: Long = PREVIEW_DEBOUNCE_MS,
) {
    val c = AuntieTheme.colors
    var draft by rememberSaveable(template.templateId, stateSaver = VisualDraftSaver) {
        mutableStateOf(VisualDraft.from(template))
    }
    val problem = visualDraftProblem(draft)

    BackHandler { onDismiss() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        DenScreenHeading(
            kicker = "The Den · Template bank",
            crumbs = listOf(DenCrumb("Template bank", onDismiss), DenCrumb("Edit template")),
            title = "Email",
            accentTail = "template",
            modifier = Modifier.fillMaxWidth(),
            trailing = {
                PrimaryButton(
                    label = "Save",
                    enabled = problem == null,
                    loading = saving,
                    onClick = { onSave(visualTemplateToSave(template, draft)) },
                    modifier = Modifier.testTag(VISUAL_SAVE_TAG),
                )
            },
        )

        saveError?.let { msg ->
            AuntieBanner(
                tone = AuntieBannerTone.Error,
                title = "Couldn't save",
                icon = Lucide.X,
                onDismiss = onDismissError,
                body = { Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim) },
            )
        }

        GlassSurface(cornerRadius = 18.dp, modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Column {
                    AuntieFieldLabel(text = "Template key")
                    Spacer(Modifier.height(6.dp))
                    Text(template.templateId, style = AuntieTheme.typography.mono, color = c.textPrimary)
                }
                LabeledField("Display name", draft.title, placeholder = "Defaults to the template key") {
                    draft = draft.copy(title = it)
                }
                LabeledField("Subject", draft.subject, required = true) { draft = draft.copy(subject = it) }
                LabeledField("Headline", draft.headline, required = true) { draft = draft.copy(headline = it) }

                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    AuntieFieldLabel(text = "Body")
                    draft.blocks.forEachIndexed { index, block ->
                        key(index) {
                            when (block) {
                                is EmailBlock.TextBlock -> EmailTextBlockField(block, index) { updated ->
                                    draft = draft.copy(blocks = draft.blocks.toMutableList().also { it[index] = updated })
                                }
                                is EmailBlock.ImageBlock -> EmailImageBlockView(block, index)
                                is EmailBlock.LockedBlock -> EmailLockedBlockView(block)
                            }
                        }
                    }
                }

                LabeledField("Internal description", draft.description, singleLine = false) {
                    draft = draft.copy(description = it)
                }
                Column {
                    LabeledField("Category", draft.category, placeholder = "Booking") { draft = draft.copy(category = it) }
                    if (categories.isNotEmpty()) {
                        Spacer(Modifier.height(8.dp))
                        FlowRow(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            categories.forEach { cat ->
                                AuntieChip(
                                    label = cat,
                                    selected = draft.category.equals(cat, ignoreCase = true),
                                    onClick = { draft = draft.copy(category = cat) },
                                )
                            }
                        }
                    }
                }
                Column {
                    AuntieFieldLabel(text = "Tags")
                    Spacer(Modifier.height(6.dp))
                    TagAssignField(
                        value = draft.tags,
                        vocab = emptyList(),
                        onChange = { draft = draft.copy(tags = it) },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                problem?.let { Text(it, style = AuntieTheme.typography.bodySmall, color = c.error) }
            }
        }

        GlassSurface(cornerRadius = 18.dp, modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                AuntieFieldLabel(text = "Preview")
                EmailPreviewPanel(draft.previewRequest(template.templateId), loadPreview, previewDebounceMs)
            }
        }
    }
}

@Composable
private fun LabeledField(
    label: String,
    value: String,
    placeholder: String = "",
    required: Boolean = false,
    singleLine: Boolean = true,
    onChange: (String) -> Unit,
) {
    Column {
        AuntieFieldLabel(text = label, required = required)
        Spacer(Modifier.height(6.dp))
        AuntieField(
            value = value,
            onValueChange = onChange,
            placeholder = placeholder,
            singleLine = singleLine,
            minLines = if (singleLine) 1 else 2,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/**
 * One text block. The field holds the block's plain text; bold, italic, links
 * and merge fields are drawn by a [VisualTransformation] over the block model,
 * so the styling can never drift from what Save serializes.
 */
@Composable
private fun EmailTextBlockField(
    block: EmailBlock.TextBlock,
    index: Int,
    onChange: (EmailBlock.TextBlock) -> Unit,
) {
    val c = AuntieTheme.colors
    val plain = block.plainText()
    var field by remember { mutableStateOf(TextFieldValue(plain, TextRange(plain.length))) }
    var refusal by remember { mutableStateOf<String?>(null) }
    // After a restore or an outside change, the model wins over the field.
    val shown = if (field.text == plain) field else TextFieldValue(plain, TextRange(plain.length))
    val styled = remember(block, c.accent) { styleEmailInlines(block.inlines, c.accent) }
    val isButton = block.kind == EmailBlockKind.BUTTON
    val textStyle = when (block.kind) {
        EmailBlockKind.HEADING2 -> AuntieTheme.typography.titleLarge
        EmailBlockKind.HEADING3 -> AuntieTheme.typography.titleMedium
        EmailBlockKind.BUTTON -> AuntieTheme.typography.labelLarge
        else -> AuntieTheme.typography.bodyMedium
    }.copy(color = if (isButton) c.background else c.textPrimary)

    val input: @Composable () -> Unit = {
        BasicTextField(
            value = shown,
            onValueChange = { next ->
                if (next.text == plain) {
                    field = next
                    return@BasicTextField
                }
                when (val r = applyBlockEdit(block, next.text)) {
                    is BlockEdit.Accepted -> {
                        refusal = null
                        val text = r.block.plainText()
                        field = if (text == next.text) next else TextFieldValue(text, TextRange(r.cursor))
                        onChange(r.block)
                    }
                    is BlockEdit.Rejected -> {
                        refusal = r.reason
                        field = shown
                    }
                }
            },
            textStyle = textStyle,
            cursorBrush = SolidColor(c.accent),
            visualTransformation = VisualTransformation { TransformedText(styled, OffsetMapping.Identity) },
            modifier = Modifier.fillMaxWidth().testTag(blockTag(index)),
        )
    }
    val boxed = Modifier
        .fillMaxWidth()
        .clip(RoundedCornerShape(10.dp))
        .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(10.dp))
        .padding(horizontal = 12.dp, vertical = 10.dp)

    Column(Modifier.fillMaxWidth()) {
        when (block.kind) {
            EmailBlockKind.BULLET_ITEM, EmailBlockKind.NUMBERED_ITEM -> Row(boxed) {
                Text(
                    if (block.kind == EmailBlockKind.BULLET_ITEM) "•" else "${block.number}.",
                    style = textStyle.copy(color = c.textDim),
                    modifier = Modifier.width(24.dp),
                )
                Box(Modifier.weight(1f)) { input() }
            }
            EmailBlockKind.CALLOUT -> Row(boxed.height(IntrinsicSize.Min)) {
                Box(Modifier.width(3.dp).fillMaxHeight().background(c.accent))
                Box(Modifier.padding(start = 12.dp).weight(1f)) { input() }
            }
            EmailBlockKind.BUTTON -> Column {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .background(c.kinfolkOrange)
                        .padding(horizontal = 18.dp, vertical = 12.dp),
                ) { input() }
                buttonTarget(block)?.let { target ->
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 6.dp)) {
                        Icon(Lucide.Lock, contentDescription = "Locked", tint = c.textFaint, modifier = Modifier.size(12.dp))
                        Spacer(Modifier.width(6.dp))
                        Text(target, style = AuntieTheme.typography.mono, color = c.textDim)
                    }
                }
            }
            else -> Box(boxed) { input() }
        }
        refusal?.let {
            Text(it, style = AuntieTheme.typography.bodySmall, color = c.error, modifier = Modifier.padding(top = 4.dp))
        }
    }
}

@Composable
private fun EmailImageBlockView(block: EmailBlock.ImageBlock, index: Int) {
    val c = AuntieTheme.colors
    Column(Modifier.fillMaxWidth().testTag(imageTag(index))) {
        AsyncImage(
            model = block.src,
            contentDescription = block.alt.ifBlank { "Email image" },
            contentScale = ContentScale.FillWidth,
            modifier = Modifier.fillMaxWidth().heightIn(max = 240.dp).clip(RoundedCornerShape(8.dp)),
        )
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 4.dp)) {
            Icon(Lucide.Lock, contentDescription = null, tint = c.textFaint, modifier = Modifier.size(12.dp))
            Spacer(Modifier.width(6.dp))
            Text("Change this image on the web admin.", style = AuntieTheme.typography.labelSmall, color = c.textFaint)
        }
    }
}

@Composable
private fun EmailLockedBlockView(block: EmailBlock.LockedBlock) {
    val c = AuntieTheme.colors
    val text = htmlToReadableText(block.raw)
    if (text.isBlank()) return
    Row(verticalAlignment = Alignment.Top, modifier = Modifier.fillMaxWidth()) {
        Icon(Lucide.Lock, contentDescription = null, tint = c.textFaint, modifier = Modifier.padding(top = 3.dp).size(12.dp))
        Spacer(Modifier.width(8.dp))
        Column {
            Text(text, style = AuntieTheme.typography.bodyMedium, color = c.textDim)
            Text("Edit this part on the web admin.", style = AuntieTheme.typography.labelSmall, color = c.textFaint)
        }
    }
}

/** Bold, italic, links and merge fields, over exactly the block's plain text. */
internal fun styleEmailInlines(inlines: List<EmailInline>, accent: Color): AnnotatedString {
    val plain = inlines.joinToString("") { inlinePlain(it) }
    return buildAnnotatedString {
        fun walk(nodes: List<EmailInline>, bold: Boolean, italic: Boolean, link: Boolean) {
            for (n in nodes) {
                if (n is EmailInline.Element) {
                    walk(n.children, bold || n.name == "strong", italic || n.name == "em", link || n.name == "a")
                    continue
                }
                val style = SpanStyle(
                    fontWeight = if (bold) FontWeight.Bold else null,
                    fontStyle = if (italic) FontStyle.Italic else null,
                    color = if (link) accent else Color.Unspecified,
                    textDecoration = if (link) TextDecoration.Underline else null,
                )
                withStyle(style) { append(inlinePlain(n).replace(EMAIL_IMAGE_CHAR, IMAGE_GLYPH)) }
            }
        }
        walk(inlines, bold = false, italic = false, link = false)
        EMAIL_MERGE_TOKEN.findAll(plain).forEach {
            addStyle(
                SpanStyle(fontFamily = FontFamily.Monospace, background = accent.copy(alpha = 0.12f)),
                it.range.first,
                it.range.last + 1,
            )
        }
    }
}

/**
 * The server's render of [request], in a WebView. A loading cue shows for
 * every request in flight, over the last render if there is one. A newer
 * request cancels the older one, and an answer that arrives for a cancelled
 * request is dropped, so the page never shows an older draft than the last
 * one asked for.
 */
@Composable
internal fun EmailPreviewPanel(
    request: EmailPreviewRequest,
    loadPreview: suspend (EmailPreviewRequest) -> Result<TemplateRepository.EmailPreview>,
    debounceMs: Long = PREVIEW_DEBOUNCE_MS,
) {
    val c = AuntieTheme.colors
    var html by remember { mutableStateOf<String?>(null) }
    var issues by remember { mutableStateOf<List<String>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableIntStateOf(0) }

    LaunchedEffect(request, attempt) {
        loading = true
        // A new attempt replaces the last failure: only the loading cue shows while it runs.
        error = null
        if (debounceMs > 0) delay(debounceMs)
        val result = loadPreview(request)
        if (!isActive) return@LaunchedEffect
        result
            .onSuccess {
                html = it.html
                issues = it.issues
                error = null
            }
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
        if (issues.isNotEmpty()) {
            AuntieBanner(
                tone = AuntieBannerTone.Warning,
                title = "Check before saving",
                body = {
                    Column { issues.forEach { Text(it, style = AuntieTheme.typography.bodySmall, color = c.textDim) } }
                },
            )
        }
        html?.let { EmailHtmlView(it, Modifier.fillMaxWidth().height(520.dp)) }
    }
}

@Composable
private fun EmailHtmlView(html: String, modifier: Modifier) {
    AndroidView(
        factory = { context ->
            WebView(context).apply {
                settings.javaScriptEnabled = false
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                webViewClient = object : WebViewClient() {
                    // The preview is a picture of the email: a tapped link must not navigate it.
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true
                }
            }
        },
        update = { view ->
            if (view.tag != html) {
                view.tag = html
                view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
            }
        },
        modifier = modifier.testTag(PREVIEW_WEB_TAG).semantics { contentDescription = "Email preview" },
    )
}
