package com.tribetails.auntieos.ui.admin

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import com.composables.icons.lucide.Bold
import com.composables.icons.lucide.Braces
import com.composables.icons.lucide.Heading
import com.composables.icons.lucide.Image
import com.composables.icons.lucide.Italic
import com.composables.icons.lucide.Link
import com.composables.icons.lucide.Lucide
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * 13.3/13.4 Template Bank rich editor pieces (android). Mirror of the web
 * MarkdownPreview + MultilineFieldValue + MarkdownToolbar. The preview renders the SAME
 * parsed blocks the save path emits to HTML, so it cannot drift from the sent email.
 */

/** TextFieldValue-backed Auntie multiline field, for the selection-aware toolbar. */
@Composable
fun AuntieMarkdownField(
    value: TextFieldValue,
    onValueChange: (TextFieldValue) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    minLines: Int = 6,
) {
    val c = AuntieTheme.colors
    var focused by remember { mutableStateOf(false) }
    Column(modifier = modifier) {
        Text(label.uppercase(), style = AuntieTheme.typography.labelSmall, color = c.textDim, modifier = Modifier.padding(bottom = 6.dp))
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .background(c.surface)
                .border(AuntieTheme.dims.borderHairline, if (focused) c.primary else c.border, RoundedCornerShape(8.dp))
                .padding(horizontal = 12.dp, vertical = 10.dp),
        ) {
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                cursorBrush = SolidColor(c.primary),
                textStyle = AuntieTheme.typography.bodyMedium.copy(color = c.textPrimary, lineHeight = 22.sp),
                modifier = Modifier
                    .fillMaxWidth()
                    .defaultMinSize(minHeight = (24 * minLines).dp)
                    .onFocusChanged { focused = it.isFocused },
            )
        }
    }
}

/** Formatting toolbar: Bold/Italic wrap the selection; the rest insert a snippet. */
@Composable
fun MarkdownToolbar(onWrap: (String, String) -> Unit, onInsert: (String) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        MdToolBtn(Lucide.Bold, "Bold") { onWrap("**", "**") }
        MdToolBtn(Lucide.Italic, "Italic") { onWrap("_", "_") }
        MdToolBtn(Lucide.Heading, "Heading") { onInsert("## ") }
        MdToolBtn(Lucide.Link, "Link") { onInsert("[text](https://)") }
        MdToolBtn(Lucide.Image, "Image") { onInsert("![alt](https://)") }
        MdToolBtn(Lucide.Braces, "Insert variable") { onWrap("{{", "}}") }
    }
}

@Composable
private fun MdToolBtn(icon: ImageVector, desc: String, onClick: () -> Unit) {
    val c = AuntieTheme.colors
    Box(
        modifier = Modifier
            .size(34.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(c.surface)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = desc, tint = c.textDim, modifier = Modifier.size(18.dp))
    }
}

/** Live preview: renders [parseMarkdown] blocks to Compose (no WebView). */
@Composable
fun MarkdownPreview(markdown: String, modifier: Modifier = Modifier) {
    val c = AuntieTheme.colors
    val blocks = remember(markdown) { parseMarkdown(markdown) }
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (blocks.isEmpty()) {
            Text("Nothing to preview yet. Start typing the email body.", style = AuntieTheme.typography.bodySmall, color = c.textFaint)
            return@Column
        }
        blocks.forEach { block ->
            when (block) {
                is MdBlock.Heading -> Text(
                    annotatedInlines(block.inlines),
                    style = when (block.level) {
                        1 -> AuntieTheme.typography.headlineLarge
                        2 -> AuntieTheme.typography.headlineSmall
                        else -> AuntieTheme.typography.titleSmall
                    },
                    color = c.textPrimary,
                )
                is MdBlock.Paragraph -> Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    block.lines.forEach { InlineLine(it) }
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

@Composable
private fun InlineLine(inlines: List<MdInline>, modifier: Modifier = Modifier) {
    val c = AuntieTheme.colors
    val textRuns = inlines.filterNot { it is MdInline.Image }
    val images = inlines.filterIsInstance<MdInline.Image>()
    Column(modifier = modifier) {
        if (textRuns.any { it !is MdInline.Text || it.text.isNotBlank() }) {
            Text(annotatedInlines(textRuns), style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
        }
        images.forEach { img ->
            AsyncImage(
                model = img.url,
                contentDescription = img.alt,
                contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxWidth().heightIn(max = 180.dp).padding(vertical = 4.dp),
            )
        }
    }
}

@Composable
private fun annotatedInlines(inlines: List<MdInline>): AnnotatedString {
    val c = AuntieTheme.colors
    return buildAnnotatedString {
        inlines.forEach { n ->
            when (n) {
                is MdInline.Text -> append(n.text)
                is MdInline.Bold -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(n.text) }
                is MdInline.Italic -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(n.text) }
                is MdInline.Link -> withStyle(SpanStyle(color = c.primary, textDecoration = TextDecoration.Underline)) { append(n.text) }
                is MdInline.Image -> {}
            }
        }
    }
}
