package com.tribetails.auntieos.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.ui.theme.AuntieTheme
import com.tribetails.auntieos.ui.theme.BrandCream
import com.tribetails.auntieos.ui.theme.BrandNavy
import com.tribetails.auntieos.ui.theme.KinTeal
import com.tribetails.auntieos.ui.theme.KinfolkOrange
import com.tribetails.auntieos.ui.theme.PackPink

/**
 * AuntieEmailPreviewCard. A faithful, LIGHT preview of a transactional TribeTails email,
 * rendered inside the Den's warm-dark admin so an operator can see what a kinfolk receives.
 *
 * The inner email surface is intentionally light-on-cream (real inbox look) even when the
 * surrounding app is in dark mode, so brand-light constants are used for the email body and
 * masthead. The outer frame still honors the Den aesthetic (glass-style hairline border,
 * rounded corners, hover lift, AuntieTheme.dims spacing).
 *
 * Layout, top to bottom:
 *   - Gradient TribeTails masthead (orange -> pink -> teal) with the brand wordmark.
 *   - Optional pet-avatar cluster (small monograms / photos) under the masthead.
 *   - Fraunces subject line.
 *   - Body paragraphs (split on blank lines), with optional Handlebars `{{token}}` highlight.
 *   - Optional CTA chip (visual only; preview, not a live button).
 *   - Optional footer line in muted mono.
 *
 * [html] is accepted for API parity with richer renderers but is NOT parsed here; when a caller
 * passes raw HTML we surface a small visible notice rather than silently dropping it or pretending
 * to render it. The plain-text [body] remains the source of truth for the preview.
 *
 * @param subject      Email subject, shown in Fraunces.
 * @param body         Plain-text body. Blank-line-separated chunks become paragraphs.
 * @param ctaLabel     Optional call-to-action chip label. Null hides the chip.
 * @param pets         Optional pet avatars shown beneath the masthead.
 * @param footer       Optional fine-print footer line.
 * @param brandName    Masthead wordmark. Defaults to "TribeTails".
 * @param highlightTokens When true, Handlebars-style `{{ token }}` spans in the body and subject
 *                        are tinted and weighted so an author can spot unresolved merge fields.
 * @param html         Optional raw HTML. Not rendered here; presence shows a visible notice.
 */
@Composable
fun AuntieEmailPreviewCard(
    subject: String,
    body: String,
    modifier: Modifier = Modifier,
    ctaLabel: String? = null,
    pets: List<PetAvatar> = emptyList(),
    footer: String? = null,
    brandName: String = "TribeTails",
    highlightTokens: Boolean = false,
    html: String? = null,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val typo = AuntieTheme.typography

    // Email-light palette. Fixed to brand-light so the preview reads as a real inbox
    // regardless of the app theme. Not pulled from AuntieTheme.colors on purpose.
    val paper = BrandCream
    val ink = BrandNavy
    val inkDim = Color(0xFF5A5860)
    val inkFaint = Color(0xFF9A98A2)
    val hairline = Color(0xFFD8D1C2)
    val tokenTint = Color(0xFFB36724) // primaryDim orange, readable on cream

    // The signature Tribe Gradient for the masthead. Brand-fixed light stops so the
    // banner matches the production email template, not the app's dark accents.
    val masthead = Brush.horizontalGradient(listOf(KinfolkOrange, PackPink, KinTeal))

    // Outer frame hover lift, in keeping with the Den's interactive surfaces.
    val interaction = remember { MutableInteractionSource() }
    val hovered = interaction.collectIsHoveredAsState().value
    val frameBorder = animateColorAsState(
        if (hovered) c.primary.copy(alpha = 0.55f) else c.border,
        label = "emailFrameBorder",
    ).value

    val paragraphs = remember(body) { splitParagraphs(body) }

    Column(
        modifier = modifier
            .clip(AuntieTheme.shapes.cardLg)
            .background(paper)
            .border(dims.borderHairline, frameBorder, AuntieTheme.shapes.cardLg)
            .hoverable(interaction),
    ) {
        // ---- Masthead -------------------------------------------------------
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(masthead)
                .padding(horizontal = dims.space6, vertical = dims.space5),
            contentAlignment = Alignment.CenterStart,
        ) {
            Text(
                text = brandName,
                style = typo.headlineMedium,
                color = BrandCream,
            )
        }

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = dims.space6, vertical = dims.space6),
        ) {
            // ---- Pet avatar cluster -----------------------------------------
            if (pets.isNotEmpty()) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(dims.space2),
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.padding(bottom = dims.space4),
                ) {
                    pets.forEach { pet ->
                        AuntieAvatar(
                            imageUrl = pet.imageUrl,
                            initials = pet.initials,
                            size = 36.dp,
                            gradientSeed = pet.initials,
                        )
                    }
                }
            }

            // ---- Subject ----------------------------------------------------
            Text(
                text = renderTokens(subject, highlightTokens, tokenTint),
                style = typo.headlineLarge,
                color = ink,
            )

            Spacer(Modifier.height(dims.space4))

            // ---- Body paragraphs --------------------------------------------
            Column(verticalArrangement = Arrangement.spacedBy(dims.space3)) {
                paragraphs.forEach { para ->
                    Text(
                        text = renderTokens(para, highlightTokens, tokenTint),
                        style = typo.bodyLarge,
                        color = inkDim,
                    )
                }
            }

            // ---- Raw-HTML notice (fail-visible, never silent) ---------------
            if (!html.isNullOrBlank()) {
                Spacer(Modifier.height(dims.space4))
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(AuntieTheme.shapes.chip)
                        .background(c.warning.copy(alpha = 0.14f))
                        .border(dims.borderHairline, c.warning.copy(alpha = 0.55f), AuntieTheme.shapes.chip)
                        .padding(horizontal = dims.space3, vertical = dims.space2),
                ) {
                    Text(
                        text = "HTML BODY PROVIDED. PREVIEW SHOWS PLAIN TEXT ONLY.",
                        style = typo.labelSmall,
                        color = c.warning,
                    )
                }
            }

            // ---- CTA chip (visual preview only) -----------------------------
            if (!ctaLabel.isNullOrBlank()) {
                Spacer(Modifier.height(dims.space5))
                Box(
                    modifier = Modifier
                        .clip(AuntieTheme.shapes.pill)
                        .background(Brush.horizontalGradient(listOf(KinfolkOrange, PackPink)))
                        .padding(horizontal = dims.space5, vertical = dims.space3),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = ctaLabel,
                        style = typo.labelLarge,
                        color = BrandCream,
                    )
                }
            }

            // ---- Footer -----------------------------------------------------
            if (!footer.isNullOrBlank()) {
                Spacer(Modifier.height(dims.space5))
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(dims.borderHairline)
                        .background(hairline),
                )
                Spacer(Modifier.height(dims.space3))
                Text(
                    text = renderTokens(footer, highlightTokens, tokenTint),
                    style = typo.mono.copy(fontSize = typo.labelSmall.fontSize),
                    color = inkFaint,
                )
            }
        }
    }
}

/** Avatar shown in the preview's pet cluster. Reuses [AuntieAvatar] for rendering. */
data class PetAvatar(
    val initials: String,
    val imageUrl: String? = null,
)

// ---- internals -------------------------------------------------------------

/** Split a plain-text body into paragraphs on blank lines, trimming empties. */
private fun splitParagraphs(body: String): List<String> =
    body.split(Regex("\\n\\s*\\n"))
        .map { it.trim() }
        .filter { it.isNotEmpty() }

/**
 * Render text, optionally tinting Handlebars-style `{{ token }}` spans so an author can
 * spot unresolved merge fields. When [highlight] is false the text is returned plain.
 */
private fun renderTokens(text: String, highlight: Boolean, tint: Color): AnnotatedString {
    if (!highlight) return AnnotatedString(text)
    val regex = Regex("\\{\\{.*?\\}\\}")
    return buildAnnotatedString {
        var last = 0
        regex.findAll(text).forEach { match ->
            if (match.range.first > last) append(text.substring(last, match.range.first))
            withStyle(SpanStyle(color = tint, fontWeight = FontWeight.SemiBold)) {
                append(match.value)
            }
            last = match.range.last + 1
        }
        if (last < text.length) append(text.substring(last))
    }
}
