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
