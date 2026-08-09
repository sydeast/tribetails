package com.tribetails.auntieos.ui.components

/**
 * Merge-field parsing for the live preview panes. The Android twin of
 * `auntieos-admin/src/lib/mergeFields.ts`, function for function and vector for
 * vector (`MergeFieldsTest` mirrors `mergeFields.test.ts`).
 *
 * WHY THIS IS NOT A TEMPLATE ENGINE. The notification pipeline really does run
 * Handlebars: `sendTemplatedEmail` (mytribe/functions/src/lib/email.ts) compiles
 * subject, body and html against a data bag. We do not, and must not, ship an
 * evaluator into the app just to draw a box. A preview answers one question,
 * "which spots in this copy get filled in, and which will arrive blank", and
 * that is a scanner's job, not an interpreter's.
 *
 * The deliberate consequence is that block helpers are NOT merge fields here.
 * `{{#if paid}}`, `{{/if}}` and `{{> footer}}` are control flow and inclusion;
 * naming them as unresolved merge fields would send an operator hunting for a
 * value that was never a value. They are skipped, which matches what reaches a
 * customer: `stripUnresolvedTokens`
 * (mytribe/functions/src/notifications/templateParsers.ts) wipes whatever
 * Handlebars leaves behind either way.
 */

/** One `{{token}}` found in a body, with the span it occupies. */
data class MergeField(
    val token: String,
    val key: String,
    val start: Int,
    val end: Int,
)

/**
 * A body cut into renderable pieces. A [PreviewSegment.Field] with a null
 * [PreviewSegment.Field.value] is a token nothing binds, which is what the
 * unresolved warning names. A field bound to `""` is a token deliberately bound
 * to an empty string, which is a different fact and is not warned about.
 */
sealed interface PreviewSegment {
    data class Text(val value: String) : PreviewSegment
    data class Field(val key: String, val value: String?) : PreviewSegment
}

/**
 * Simple merge fields only: an optionally-spaced identifier, dotted paths
 * allowed (`{{invoice.number}}`), between doubled braces. Requiring an
 * identifier start is what excludes `{{#if}}`, `{{/if}}`, `{{^}}` and
 * `{{> partial}}` without needing a parser.
 */
private val TOKEN = Regex("""\{\{\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*}}""")

/** Every simple merge field in [body], in the order they appear. */
fun findMergeFields(body: String): List<MergeField> =
    TOKEN.findAll(body).map { m ->
        MergeField(
            token = m.value,
            // Group 1 is not optional in THIS pattern, so it is always present.
            key = m.groupValues[1],
            start = m.range.first,
            end = m.range.last + 1,
        )
    }.toList()

/**
 * Cut [body] into text and field segments, binding each field against [sample].
 *
 * An unbound token survives as `null` all the way to the warning. Folding it
 * into `""` here is precisely the silent degradation that put "See their account
 * here:" in front of customers with nothing after the colon.
 */
fun renderPreview(body: String, sample: Map<String, String>): List<PreviewSegment> {
    val segments = mutableListOf<PreviewSegment>()
    var cursor = 0
    for (f in findMergeFields(body)) {
        if (f.start > cursor) segments += PreviewSegment.Text(body.substring(cursor, f.start))
        // `sample[key]` is null for absent AND returns "" for a real empty
        // binding, which is exactly the distinction this preview needs.
        segments += PreviewSegment.Field(key = f.key, value = sample[f.key])
        cursor = f.end
    }
    if (cursor < body.length) segments += PreviewSegment.Text(body.substring(cursor))
    return segments
}

/**
 * [body] with every BOUND merge field replaced by its sample value, and every
 * unbound one left standing as its raw `{{token}}`.
 *
 * That asymmetry is the design, not a shortcut. Handing the result to
 * [AuntieEmailPreviewCard] with `highlightTokens = true` means the only braces
 * left on screen are the ones nothing fills, so the card's existing tint stops
 * marking "this is a merge field" (true of every token, and therefore not worth
 * marking) and starts marking "this one will arrive blank".
 */
fun substituteMergeFields(body: String, sample: Map<String, String>): String =
    renderPreview(body, sample).joinToString("") { segment ->
        when (segment) {
            is PreviewSegment.Text -> segment.value
            is PreviewSegment.Field -> segment.value ?: "{{${segment.key}}}"
        }
    }

/**
 * The distinct unbound keys, in first-seen order.
 *
 * DISTINCT, not one entry per occurrence: the warning both counts and names them
 * in one sentence, and a body repeating `{{link}}` three times has one thing
 * wrong with it, not three.
 */
fun unresolvedKeys(segments: List<PreviewSegment>): List<String> =
    segments.filterIsInstance<PreviewSegment.Field>()
        .filter { it.value == null }
        .map { it.key }
        .distinct()

/**
 * The warning sentence for [keys], or null when there is nothing to warn about.
 * Word for word with the React twin, so an operator reading the same template on
 * a phone and on the web is told the same thing.
 */
fun unresolvedWarning(keys: List<String>): String? = when (keys.size) {
    0 -> null
    1 -> "1 merge field has no sample value: ${keys[0]}"
    else -> "${keys.size} merge fields have no sample value: ${keys.joinToString(", ")}"
}

/**
 * Sample bindings for the twelve tokens the notification enricher can hydrate.
 *
 * SOURCE: `ENRICHABLE` in mytribe/functions/src/notifications/enrichTemplateData.ts,
 * and identical to the React twin's `ENRICHABLE_SAMPLE`. That set is the honest
 * boundary of "the pipeline will fill this in": the enricher hydrates those
 * twelve from the entities a notification names, and everything else (`link`,
 * `score`, `count`, `incidentId`, the Stripe dispute fields) has to be handed in
 * by whichever emitter raised the notification. A token outside this map is not
 * necessarily a bug, but it IS a promise somebody else has to keep, and the
 * preview says so rather than quietly rendering it as though it were handled.
 *
 * The sample values use the fictional households the mockups already use, never
 * a real client.
 */
val ENRICHABLE_SAMPLE: Map<String, String> = mapOf(
    "kinfolkName" to "Sandy Wren",
    "kinName" to "Biscuit",
    "serviceType" to "Drop-in visit",
    "bookingDate" to "Thursday, 14 August",
    "bookingTime" to "9:00 AM",
    "invoiceNumber" to "INV-1042",
    "amount" to "$68.00",
    "dueDate" to "21 August",
    "email" to "sandy@example.com",
    "kinfolkEmail" to "sandy@example.com",
    "displayName" to "Sandy Wren",
    "notes" to "Back door key is with the neighbour.",
)
