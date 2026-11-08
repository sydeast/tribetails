import Handlebars from 'handlebars';
import { stripUnresolvedTokens } from '../notifications/templateParsers';
import { businessTokens } from './businessName';

/**
 * Merge fields in a Communicate broadcast (#1610).
 *
 * A broadcast used to carry no merge data at all: email went through
 * `sendTemplatedEmail` with `data: {}`, so `Hi {{firstName}},` arrived as
 * `Hi ,`, and SMS, push and in-app got the braces exactly as typed. The fields
 * are now filled HERE, on the server, per household, for every channel, so no
 * client and no channel can disagree about what a household reads.
 *
 * ── THE STAND-IN WORD (operator ruling, 2026-11-05 docket) ────────────────
 * A household with no first name on file reads "Kinfolk": `Hi {{firstName}},`
 * becomes "Hi Kinfolk,". The same word stands in for a household with no name
 * at all in `{{kinfolkName}}`.
 *
 * ── ANYTHING ELSE IS REFUSED, NOT SENT BLANK ──────────────────────────────
 * Only the fields below can be filled. A broadcast naming any other
 * `{{token}}`, or carrying braces that are not a field at all, is refused
 * before a single household is contacted (`unsupportedMergeFields`), so a
 * typo like `{{firstname}}` is caught by the operator instead of by a
 * customer.
 */

/** The fields a broadcast may use, in the order the composers list them. */
export const BROADCAST_MERGE_FIELDS = ['firstName', 'lastName', 'kinfolkName', 'business', 'Business'] as const;
export type BroadcastMergeField = (typeof BROADCAST_MERGE_FIELDS)[number];

/** Operator ruling, 2026-11-05: what a blank first name reads as. */
export const KINFOLK_NAME_STAND_IN = 'Kinfolk';

const SUPPORTED: ReadonlySet<string> = new Set(BROADCAST_MERGE_FIELDS);
/** One simple, optionally spaced `{{ name }}`. */
const SIMPLE_TOKEN = /\{\{\s*([A-Za-z_][\w]*)\s*\}\}/g;

/**
 * Every merge field (or brace run) in `texts` the broadcast cannot fill, in
 * first-seen order, no repeats. An empty list means the copy is sendable.
 * A stray `{{` or `}}` that is not part of a supported field is reported as
 * the raw text, because a template engine would choke on it or blank it. Pure.
 */
export function unsupportedMergeFields(...texts: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (v: string): void => {
    if (seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(SIMPLE_TOKEN)) {
      const name = m[1] as string;
      if (!SUPPORTED.has(name)) add(name);
    }
    // Whatever braces remain once every simple token is taken out are not a
    // field anyone can fill: `{{#if}}`, `{{> partial}}`, `{{{x}}}`, a lone `{{`.
    const rest = text.replace(SIMPLE_TOKEN, '');
    for (const m of rest.matchAll(/\{\{[^}]*\}*\}?|\}\}/g)) add(m[0].trim());
  }
  return out;
}

/** The values one household's copy is filled with. Pure. */
export function broadcastMergeData(
  k: { firstName?: string; lastName?: string },
  businessName: string,
): Record<BroadcastMergeField, string> {
  const first = (k.firstName ?? '').trim();
  const last = (k.lastName ?? '').trim();
  const full = `${first} ${last}`.trim();
  return {
    firstName: first !== '' ? first : KINFOLK_NAME_STAND_IN,
    lastName: last,
    kinfolkName: full !== '' ? full : KINFOLK_NAME_STAND_IN,
    ...businessTokens(businessName),
  };
}

/**
 * One household's subject and body, filled with the same engine and rules the
 * email pipeline uses for its subject and text part, so SMS, push and in-app read exactly what the email reads.
 * Pure.
 */
export function renderBroadcastCopy(
  subject: string,
  body: string,
  data: Record<string, string>,
): { subject: string; body: string } {
  // Plain text, the way lib/email.ts renders a subject and text part:
  // Handlebars with no HTML escaping, then any leftover token stripped.
  const render = (t: string): string => stripUnresolvedTokens(Handlebars.compile(t, { noEscape: true })(data));
  return { subject: render(subject), body: render(body) };
}
