/**
 * The rules a notification template has to satisfy, in one place, because two
 * doors now lead into the same three collections.
 *
 * `admin/saveTemplate.ts` is the authoring door and has always enforced these.
 * `admin/importSeedTemplates.ts` is the bulk door added under issue #468. An
 * importer that skipped the triple-stash guard would be the hole authoring
 * closes: an operator blocked from typing `{{{payload}}}` into the editor could
 * put it in a seed file and import it instead. So the guard lives here and both
 * doors call it, rather than each carrying its own copy of the regex.
 *
 * These functions return a sentence or null, not a boolean. A caller that only
 * learns "invalid" has to invent the explanation, and two callers inventing it
 * separately is how an operator gets told two different things about one rule.
 */

/**
 * Handlebars triple-stash, `{{{var}}}`, renders a variable WITHOUT HTML escape,
 * so an attacker-controlled merge value reaches an inbox as live markup: stored
 * XSS, a smuggled link, a phishing form. Double-stash `{{var}}` is escaped by
 * default. The block is at author time rather than at render time, because
 * admins still want rich formatting and cannot be expected to know which merge
 * fields a stranger can fill in.
 */
const TRIPLE_STASH = /\{\{\{/;

/** True when the text is free of triple-stash (or absent). */
export function noTripleStash(s: string | null | undefined): boolean {
  return !s || !TRIPLE_STASH.test(s);
}

/**
 * What an operator is told when one field carries a triple stash.
 *
 * @param field the name an operator would recognise, e.g. `subject`, `html`.
 */
export function tripleStashMessage(field: string): string {
  return (
    `${field} uses the Handlebars triple stash {{{...}}}, which sends a merge ` +
    `value as raw HTML. Change every {{{name}}} to {{name}} so the value is escaped.`
  );
}

/** The complaint about one field's triple stash, or null when it is clean. */
export function tripleStashIssue(field: string, value: string | null | undefined): string | null {
  return noTripleStash(value) ? null : tripleStashMessage(field);
}

/**
 * A merge field written straight into an attribute with no quotes around it,
 * `href={{link}}`. Handlebars escaping protects a quoted attribute, but it does
 * not escape spaces, so an unquoted value can end the attribute and start a new
 * one (`x onmouseover=...`). Refused at author time for the same reason as the
 * triple stash (#892 review).
 */
const UNQUOTED_ATTRIBUTE_MERGE = /\s[a-zA-Z][\w:-]*\s*=\s*\{\{/;

/** The complaint about one field's unquoted attribute merge, or null when it is clean. */
export function unquotedAttributeIssue(field: string, value: string | null | undefined): string | null {
  if (!value || !UNQUOTED_ATTRIBUTE_MERGE.test(value)) return null;
  return (
    `${field} puts a merge field straight into an attribute without quotes, like href={{link}}. ` +
    `Quote it, href="{{link}}", so the value cannot break out of the attribute.`
  );
}

/** A template id is a document id in three collections, so it is kept narrow. */
export const TEMPLATE_ID_PATTERN = /^[a-zA-Z0-9_.-]+$/;
export const TEMPLATE_ID_MAX_LENGTH = 120;

/**
 * The rule, phrased for a human. Both clients show this next to the id field so
 * the constraint is readable before it is violated, not only after.
 */
export const TEMPLATE_ID_RULE =
  'Letters, numbers, dots, dashes and underscores only, up to 120 characters. ' +
  'The convention is a dotted key that matches the notification it renders, ' +
  'for example kincare.reschedule.requested.';

/** The complaint about a proposed template id, or null when it is usable. */
export function templateIdIssue(id: string): string | null {
  if (id.length === 0) return `A template id is required. ${TEMPLATE_ID_RULE}`;
  if (id.length > TEMPLATE_ID_MAX_LENGTH) {
    return `That template id is ${id.length} characters, and the limit is ${TEMPLATE_ID_MAX_LENGTH}. ${TEMPLATE_ID_RULE}`;
  }
  if (!TEMPLATE_ID_PATTERN.test(id)) {
    const offenders = Array.from(new Set(id.split('').filter((c) => !/[a-zA-Z0-9_.-]/.test(c))));
    return `That template id contains ${offenders.map((c) => JSON.stringify(c)).join(', ')}. ${TEMPLATE_ID_RULE}`;
  }
  return null;
}

/** The renderable fields of an email template, as stored. */
export interface EmailTemplateContent {
  subject: string;
  body: string;
  html: string | null;
}

/**
 * Every complaint about one email template's renderable content, in the order
 * an operator would read the fields. Empty means it passes.
 *
 * The importer reports all of them at once. A bulk import that surfaced only
 * the first problem per template would take one round trip per bad field.
 */
export function emailTemplateIssues(content: EmailTemplateContent): string[] {
  const issues: string[] = [];
  if (content.subject.trim().length === 0) issues.push('subject is empty.');
  if (content.body.trim().length === 0) issues.push('body is empty.');
  for (const [field, value] of [
    ['subject', content.subject],
    ['body', content.body],
    ['html', content.html],
  ] as const) {
    const issue = tripleStashIssue(field, value);
    if (issue) issues.push(issue);
  }
  const attributeIssue = unquotedAttributeIssue('html', content.html);
  if (attributeIssue) issues.push(attributeIssue);
  return issues;
}

/** The renderable field of an SMS template, as stored. */
export function smsTemplateIssues(text: string): string[] {
  const issues: string[] = [];
  if (text.trim().length === 0) issues.push('sms text is empty.');
  const issue = tripleStashIssue('sms text', text);
  if (issue) issues.push(issue);
  return issues;
}

/** The renderable fields of a push template, as stored. */
export function pushTemplateIssues(title: string, body: string): string[] {
  const issues: string[] = [];
  if (title.trim().length === 0) issues.push('push title is empty.');
  if (body.trim().length === 0) issues.push('push body is empty.');
  for (const [field, value] of [
    ['push title', title],
    ['push body', body],
  ] as const) {
    const issue = tripleStashIssue(field, value);
    if (issue) issues.push(issue);
  }
  return issues;
}
