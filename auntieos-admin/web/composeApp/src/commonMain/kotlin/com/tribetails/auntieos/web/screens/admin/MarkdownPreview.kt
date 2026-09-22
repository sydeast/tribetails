package com.tribetails.auntieos.web.screens.admin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieAsyncImage

/**
 * 13.3/13.4 live preview for the Template Bank rich editor (web/desktop). Renders the
 * SAME parsed blocks the save path emits to HTML ([parseMarkdown]) so the preview can
 * never drift from the sent email. Constrained Compose renderer (no WebView): headings,
 * bold/italic/links as AnnotatedString spans, images via coil3 AsyncImage, bullet lists.
 * Handlebars {{vars}} render literally (the operator sees the placeholder).
 */
@Composable
fun MarkdownPreview(markdown: String, modifier: Modifier = Modifier) {
    val c = AuntieTheme.colors
    val blocks = remember(markdown) { parseMarkdown(markdown) }

    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (blocks.isEmpty()) {
            Text(
                "Nothing to preview yet. Start typing the email body.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textFaint,
            )
            return@Column
        }
        blocks.forEach { block ->
            when (block) {
                is MdBlock.Heading -> Text(
                    text = annotatedInlines(block.inlines),
                    style = when (block.level) {
                        1 -> AuntieTheme.typography.headlineSmall
                        2 -> AuntieTheme.typography.titleLarge
                        else -> AuntieTheme.typography.titleSmall
                    },
                    color = c.textPrimary,
                )
                is MdBlock.Paragraph -> Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    block.lines.forEach { line -> InlineLine(line) }
                }
                is MdBlock.BulletList -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    block.items.forEach { item ->
                        Row {
                            Text("•  ", style = AuntieTheme.typography.bodyMedium, color = c.textDim)
                            InlineLine(item, modifier = Modifier.fillMaxWidth())
                        }
                    }
                }
            }
        }
    }
}

/** Render one line's inlines: text/bold/italic/link as a single styled Text, images stacked. */
@Composable
private fun InlineLine(inlines: List<MdInline>, modifier: Modifier = Modifier) {
    val c = AuntieTheme.colors
    val textRuns = inlines.filterNot { it is MdInline.Image }
    val images = inlines.filterIsInstance<MdInline.Image>()
    Column(modifier = modifier) {
        val hasText = textRuns.any { it !is MdInline.Text || it.text.isNotBlank() }
        if (hasText) {
            Text(annotatedInlines(textRuns), style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
        }
        images.forEach { img ->
            AuntieAsyncImage(
                model = img.url,
                contentDescription = img.alt,
                contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxWidth().heightIn(max = 180.dp).padding(vertical = 4.dp),
            )
        }
    }
}

/** Build an AnnotatedString from inline spans (images are rendered separately, skipped here). */
@Composable
private fun annotatedInlines(inlines: List<MdInline>): AnnotatedString {
    val c = AuntieTheme.colors
    return buildAnnotatedString {
        inlines.forEach { n ->
            when (n) {
                is MdInline.Text -> append(n.text)
                is MdInline.Bold -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(n.text) }
                is MdInline.Italic -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(n.text) }
                is MdInline.Link -> withStyle(
                    SpanStyle(color = c.primary, textDecoration = TextDecoration.Underline),
                ) { append(n.text) }
                is MdInline.Image -> { /* rendered as AsyncImage by InlineLine */ }
            }
        }
    }
}
