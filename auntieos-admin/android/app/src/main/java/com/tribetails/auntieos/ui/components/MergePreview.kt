package com.tribetails.auntieos.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * The live preview pane: what this copy looks like once the merge fields are
 * filled in, and which of them nothing will fill. The Android twin of
 * `src/components/MergePreview.tsx`.
 *
 * WHY IT EXISTS. The live `account.welcome.business` body ends "See their
 * account here: []" and shipped that way, because no editor on any platform
 * ever rendered a template the way a kinfolk receives it. Six of the operator's
 * mockups tag a `SUGGESTION: live preview pane`.
 *
 * HOW IT REUSES THE CARD RATHER THAN REDRAWING IT. [AuntieEmailPreviewCard]
 * already paints the inbox-accurate masthead, subject and paragraphs, and
 * already tints `{{token}}` spans when asked. This composable adds the two
 * things it could not know about on its own: it SUBSTITUTES the bound fields
 * before handing the text over (so what is on screen is the sent copy, not the
 * source), and it names the ones nothing binds. Because substitution leaves
 * only the unbound tokens in braces, the card's existing tint stops meaning
 * "this is a merge field" and starts meaning "this one will arrive blank",
 * which is the only one of the two worth a colour.
 *
 * WHAT THE WARNING MEANS, precisely. It is not "these are broken", it is
 * "nothing here fills these in, so somebody else has to". On a notification
 * template the sample is [ENRICHABLE_SAMPLE], the twelve tokens
 * `enrichTemplateData.ts` hydrates, so an unbound token is one the emitting
 * function has to pass. On an ad-hoc broadcast the sample is empty, because
 * `broadcastMessage` sends `data: {}` and no token can resolve at all. The
 * caller supplies the [footnote] that says which of those two it is, so the pane
 * never implies a resolution that will not happen.
 *
 * @param sample the bindings to preview against. [ENRICHABLE_SAMPLE] wherever
 *   the notification pipeline does the filling; `emptyMap()` where nothing will.
 */
@Composable
fun MergePreview(
    subject: String,
    body: String,
    sample: Map<String, String>,
    modifier: Modifier = Modifier,
    footnote: String? = null,
    ctaLabel: String? = null,
    html: String? = null,
) {
    val dims = AuntieTheme.dims

    val filledSubject = remember(subject, sample) { substituteMergeFields(subject, sample) }
    val filledBody = remember(body, sample) { substituteMergeFields(body, sample) }

    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(dims.space2)) {
        AuntieEmailPreviewCard(
            subject = filledSubject,
            body = filledBody,
            modifier = Modifier.fillMaxWidth(),
            ctaLabel = ctaLabel,
            footer = footnote,
            // Only the UNBOUND tokens are still in braces at this point, so the
            // tint marks the problem rather than every merge field.
            highlightTokens = true,
            html = html,
        )
        // `html` is counted but never shown: the card surfaces its own
        // "HTML BODY PROVIDED" notice, and `<a href="{{link}}">` is exactly where
        // account.welcome.business hides its empty account link, so counting only
        // what is on screen would miss the defect this pane was built for.
        MergeFieldWarning(subject = subject, body = body, sample = sample, html = html)
    }
}

/**
 * The warning line on its own, for a screen that already draws its own preview
 * and only needs to be told what will arrive blank.
 *
 * The Template Bank editor is exactly that case: its body is authored as
 * Markdown and previewed through `MarkdownPreview`, which renders the same
 * parsed blocks the save path emits to HTML. Replacing that with the email card
 * would trade a true preview of the markdown pipeline for a true preview of the
 * merge fields, when the screen can simply have both.
 *
 * Renders nothing at all when every field binds; there is no "0 unresolved"
 * state, because a line that is usually empty is one an operator learns to read,
 * and a line that always says zero is one they learn to ignore.
 */
@Composable
fun MergeFieldWarning(
    subject: String,
    body: String,
    sample: Map<String, String>,
    modifier: Modifier = Modifier,
    html: String? = null,
) {
    val warning = remember(subject, body, sample, html) {
        // Subject, body and html together: all three go through the same
        // Handlebars compile (email.ts#sendTemplatedEmail compiles
        // subjectTemplate, bodyTemplate and htmlTemplate), so a blank in any of
        // them is the same defect.
        unresolvedWarning(
            unresolvedKeys(
                renderPreview(subject, sample) +
                    renderPreview(body, sample) +
                    renderPreview(html.orEmpty(), sample),
            ),
        )
    } ?: return

    Text(
        text = warning,
        style = AuntieTheme.typography.bodySmall,
        color = AuntieTheme.colors.warning,
        modifier = modifier,
    )
}
