/**
 * Pure parsers for on-disk notification template files.
 * No I/O, no Firestore. Tested in isolation under functions vitest config.
 */

export interface EmailTxtParsed {
  subject: string;
  body: string;
}

export function parseEmailTxt(raw: string): EmailTxtParsed {
  const firstNewline = raw.indexOf('\n');
  const firstLine = firstNewline === -1 ? raw : raw.slice(0, firstNewline);
  if (!firstLine.startsWith('Subject: ')) {
    throw new Error(`parseEmailTxt: first line must start with "Subject: ", got: ${JSON.stringify(firstLine)}`);
  }
  const subject = firstLine.slice('Subject: '.length).trim();
  const sepIdx = raw.indexOf('\n\n');
  if (sepIdx === -1) {
    throw new Error('parseEmailTxt: missing "\\n\\n" separator, body is empty');
  }
  const body = raw.slice(sepIdx + 2);
  if (body.trim().length === 0) {
    throw new Error('parseEmailTxt: body is empty (whitespace only after separator)');
  }
  return { subject, body };
}

/**
 * Final safety net applied to ALREADY-RENDERED template output. Handlebars
 * blanks a missing simple `{{x}}` to an empty string, but a malformed or
 * never-substituted token could otherwise survive; this strips any residual
 * `{{...}}` so a raw merge token can never reach a customer (fail-loud policy:
 * a blank reads better than a leaked `{{kinfolkName}}`). Pure string op.
 */
export function stripUnresolvedTokens(rendered: string): string {
  return rendered.replace(/\{\{[^}]*\}\}/g, '');
}

export interface PushTxtParsed {
  title: string;
  body: string;
}

export function parsePushTxt(raw: string): PushTxtParsed {
  const trimmed = raw.trim();
  const periodIdx = trimmed.indexOf('.');
  if (periodIdx === -1) {
    throw new Error(`parsePushTxt: no period found in input: ${JSON.stringify(trimmed)}`);
  }
  const title = trimmed.slice(0, periodIdx).trim();
  const body = trimmed.slice(periodIdx + 1).trim();
  if (body.length === 0) {
    throw new Error('parsePushTxt: body is empty after first period');
  }
  return { title, body };
}

/**
 * #2093, UNTIL THE TEMPLATES ARE RE-IMPORTED. A quote with no Kin on it names
 * no Kin, and the repo's templates say so with `{{#if kinName}}`. Prod sends
 * the STORED templates, and the ones stored before this change put
 * `{{kinName}}` in a sentence unguarded ("accepted the quote for {{kinName}}'s
 * care"), which an empty name breaks ("for 's care"). So when a quote names no
 * Kin, the enricher also keeps the household's roster under this field, the
 * name those older templates were always given, and `kinForStoredTemplate`
 * hands it only to a template that has no guard. The card never reads it.
 */
export const QUOTE_HOUSEHOLD_KIN_FIELD = 'quoteHouseholdKinNames';

const KIN_TOKEN = /\{\{\{?\s*kinName\s*\}?\}\}/;
const KIN_GUARD = /\{\{\s*#if\s+kinName\s*\}\}/;

/**
 * The context one stored template renders with (see QUOTE_HOUSEHOLD_KIN_FIELD).
 * `texts` are that channel's template strings (subject, body, title...). A
 * template that guards on `{{#if kinName}}` gets the context as it is; one that
 * uses `{{kinName}}` with no guard gets the household's names, as before #2093.
 * PURE.
 */
export function kinForStoredTemplate(
  data: Record<string, unknown>,
  texts: ReadonlyArray<string | null | undefined>,
): Record<string, unknown> {
  const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const roster = text(data[QUOTE_HOUSEHOLD_KIN_FIELD]);
  if (roster === '' || text(data.kinName) !== '') return data;
  const all = texts.filter((t): t is string => typeof t === 'string');
  if (!all.some((t) => KIN_TOKEN.test(t)) || all.some((t) => KIN_GUARD.test(t))) return data;
  return { ...data, kinName: roster };
}
