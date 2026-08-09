/**
 * Merge-field parsing for the live preview panes.
 *
 * WHY THIS IS NOT A TEMPLATE ENGINE. The notification pipeline really does run
 * Handlebars: `sendTemplatedEmail` (mytribe/functions/src/lib/email.ts) compiles
 * subject, body and html against a data bag. We do not, and must not, ship that
 * evaluator into the admin bundle just to draw a box. A preview needs to answer
 * one question, "which spots in this copy get filled in, and which will arrive
 * blank", and that question is answered by a scanner, not by an interpreter
 * with helpers, partials and arbitrary expression evaluation.
 *
 * The deliberate consequence is that block helpers are NOT merge fields here.
 * `{{#if paid}}`, `{{/if}}` and `{{> footer}}` are control flow and inclusion;
 * naming them as unresolved merge fields would send an operator hunting for a
 * value that was never a value. They are simply skipped, which matches what
 * reaches a customer: `stripUnresolvedTokens`
 * (mytribe/functions/src/notifications/templateParsers.ts) wipes whatever
 * Handlebars leaves behind either way.
 */

/** One `{{token}}` found in a body, with the span it occupies. */
export interface MergeField {
  token: string;
  key: string;
  start: number;
  end: number;
}

/**
 * A body cut into renderable pieces. A `field` segment with `value: null` is a
 * token nothing binds, which is exactly what the unresolved warning counts. A
 * `field` segment with `value: ''` is a token bound to a deliberately empty
 * string, which is a different fact and is not warned about.
 */
export type PreviewSegment =
  | { kind: 'text'; value: string }
  | { kind: 'field'; key: string; value: string | null };

/**
 * Simple merge fields only: an optionally-spaced identifier, dotted paths
 * allowed (`{{invoice.number}}`), between doubled braces. The leading
 * `[\w.]` requirement is what excludes `{{#if}}`, `{{/if}}`, `{{^}}` and
 * `{{> partial}}` without needing a parser.
 */
const TOKEN = /\{\{\s*([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\s*\}\}/g;

/** Every simple merge field in `body`, in the order they appear. */
export function findMergeFields(body: string): MergeField[] {
  const out: MergeField[] = [];
  for (const m of body.matchAll(TOKEN)) {
    // `index` and group 1 are both always present on a match of THIS pattern:
    // the regex has exactly one capturing group and it is not optional. They are
    // typed as possibly-absent because the shape is shared with patterns where
    // that is not true, so the assertions record a fact rather than paper over
    // an unknown.
    const start = m.index as number;
    out.push({ token: m[0], key: m[1] as string, start, end: start + m[0].length });
  }
  return out;
}

/**
 * Cut `body` into text and field segments, binding each field against `sample`.
 *
 * The `?? null` below is the point of this function, not a fallback that hides a
 * failure: an unbound token has to survive as `null` all the way to the warning,
 * and turning it into `''` here is precisely the silent degradation that put
 * "See their account here:" in front of customers with nothing after the colon.
 */
export function renderPreview(body: string, sample: Record<string, string>): PreviewSegment[] {
  const segments: PreviewSegment[] = [];
  let cursor = 0;
  for (const f of findMergeFields(body)) {
    if (f.start > cursor) segments.push({ kind: 'text', value: body.slice(cursor, f.start) });
    // `?? null`, NOT `|| null`: an empty-string binding is a real binding that
    // someone chose, and `||` would fold it into the unbound case and warn
    // about a field that is deliberately blank.
    segments.push({ kind: 'field', key: f.key, value: sample[f.key] ?? null });
    cursor = f.end;
  }
  if (cursor < body.length) segments.push({ kind: 'text', value: body.slice(cursor) });
  return segments;
}

/**
 * The distinct unbound keys, in first-seen order.
 *
 * DISTINCT, not one entry per occurrence: the preview both counts and names
 * them in one sentence, and a body repeating `{{link}}` three times has one
 * thing wrong with it, not three. `unresolvedKeys(...).length` is therefore the
 * count the warning uses; there is no separate occurrence counter, because
 * nothing would read it.
 */
export function unresolvedKeys(segments: readonly PreviewSegment[]): string[] {
  const seen: string[] = [];
  for (const s of segments) {
    if (s.kind === 'field' && s.value === null && !seen.includes(s.key)) seen.push(s.key);
  }
  return seen;
}

/**
 * Sample bindings for the twelve tokens the notification enricher can hydrate.
 *
 * SOURCE: `ENRICHABLE` in mytribe/functions/src/notifications/enrichTemplateData.ts.
 * That set is the honest boundary of "the pipeline will fill this in": the
 * enricher hydrates those twelve from the entities a notification names, and
 * everything else (`link`, `score`, `count`, `incidentId`, `ip`, the Stripe
 * dispute fields) has to be handed in by whichever emitter raised the
 * notification. So a token outside this map is not necessarily a bug, but it IS
 * a promise somebody else has to keep, and the preview says so rather than
 * quietly rendering it as though it were handled.
 *
 * The sample values use the fictional households the mockups already use
 * (see auntieos-admin/CLAUDE.md), never a real client.
 */
export const ENRICHABLE_SAMPLE: Readonly<Record<string, string>> = {
  kinfolkName: 'Sandy Wren',
  kinName: 'Biscuit',
  serviceType: 'Drop-in visit',
  bookingDate: 'Thursday, 14 August',
  bookingTime: '9:00 AM',
  invoiceNumber: 'INV-1042',
  amount: '$68.00',
  dueDate: '21 August',
  email: 'sandy@example.com',
  kinfolkEmail: 'sandy@example.com',
  displayName: 'Sandy Wren',
  notes: 'Back door key is with the neighbour.',
};
