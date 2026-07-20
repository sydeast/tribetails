import Handlebars from 'handlebars';
import { stripUnresolvedTokens } from '../notifications/templateParsers';
import { sendsAreSuppressed, suppressedId, logSuppressedSend } from './sendGuard';

/**
 * Email transport: smtp2go HTTP API (replaced SendGrid 2026-06-10 when the
 * free tier was dropped). Same contract as the old SendGrid lib —
 * Handlebars-rendered subject/text/html, returns the provider message id
 * (smtp2go email_id) for the engagement ledger in external_messages.
 *
 * Env (Secret Manager, bind via `secrets: ['SMTP2GO_API_KEY', 'EMAIL_FROM']`):
 *   SMTP2GO_API_KEY  - restricted smtp2go API key with email send allowed
 *   EMAIL_FROM       - verified sender address
 */

const SMTP2GO_SEND_URL = 'https://api.smtp2go.com/v3/email/send';

export interface SendArgs {
  to: string;
  subjectTemplate: string;
  bodyTemplate: string;
  data: Record<string, unknown>;
  htmlTemplate?: string;
  replyTo?: string;
}

interface Smtp2goResponse {
  data?: {
    succeeded?: number;
    failed?: number;
    email_id?: string;
    error?: string;
    error_code?: string;
    failures?: string[];
  };
}

export async function sendTemplatedEmail(args: SendArgs): Promise<string> {
  // SEND_SUPPRESS=1: log and return a marked id, never contact smtp2go. Checked
  // before the secret reads so a non-prod deploy needs no email credentials.
  // See lib/sendGuard.ts for why this exists and why it is fail-open.
  if (sendsAreSuppressed()) {
    logSuppressedSend('email', args.to, args.subjectTemplate);
    return suppressedId('email');
  }
  const key = process.env.SMTP2GO_API_KEY;
  if (!key) throw new Error('SMTP2GO_API_KEY environment variable is required');
  const from = process.env.EMAIL_FROM;
  if (!from) throw new Error('EMAIL_FROM environment variable is required');

  // Subject and text are plain text: HTML entity escaping would corrupt URLs
  // ({{claimUrl}} -> claim?i&#x3D;1). Only the html body keeps escaping.
  // Strip any unresolved {{token}} after render so a raw merge field can never
  // reach a customer (Handlebars blanks missing simple tokens; this is the belt
  // for anything malformed that slips through).
  const subject = stripUnresolvedTokens(
    Handlebars.compile(args.subjectTemplate, { noEscape: true })(args.data),
  );
  const text = stripUnresolvedTokens(
    Handlebars.compile(args.bodyTemplate, { noEscape: true })(args.data),
  );
  const html = args.htmlTemplate
    ? stripUnresolvedTokens(Handlebars.compile(args.htmlTemplate)(args.data))
    : undefined;

  const res = await fetch(SMTP2GO_SEND_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Smtp2go-Api-Key': key,
    },
    body: JSON.stringify({
      sender: from,
      to: [args.to],
      subject,
      text_body: text,
      ...(html && { html_body: html }),
      ...(args.replyTo && { custom_headers: [{ header: 'Reply-To', value: args.replyTo }] }),
    }),
  });

  const payload = (await res.json().catch(() => ({}))) as Smtp2goResponse;
  if (!res.ok) {
    throw new Error(`smtp2go send failed (HTTP ${res.status}): ${payload.data?.error ?? 'unknown error'}`);
  }
  if (!payload.data?.succeeded) {
    throw new Error(`smtp2go send failed: ${payload.data?.failures?.join('; ') ?? 'no sends succeeded'}`);
  }
  return payload.data.email_id ?? '';
}
