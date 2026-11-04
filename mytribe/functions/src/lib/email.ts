import Handlebars from 'handlebars';
import { stripUnresolvedTokens } from '../notifications/templateParsers';
import { sendsAreSuppressed, suppressedId, logSuppressedSend } from './sendGuard';
import { isReservedEmailDomain, logRefusedSend, refusedId } from './reservedEmailDomains';
import { describeProviderFailure, providerFailureFields } from './providerFailure';

/**
 * Email transport: smtp2go HTTP API (replaced SendGrid 2026-06-10 when the
 * free tier was dropped). Same contract as the old SendGrid lib —
 * Handlebars-rendered subject/text/html, returns the provider message id
 * (smtp2go email_id) for the engagement ledger in external_messages.
 *
 * Env (Secret Manager, bind via `secrets: ['SMTP2GO_API_KEY', 'EMAIL_FROM']`):
 *   SMTP2GO_API_KEY  - restricted smtp2go API key with email send allowed
 *   EMAIL_FROM       - verified sender address
 *
 * Every failure it throws names smtp2go (#1535, lib/providerFailure.ts): an
 * HTTP error carries the status in its own message, and a network or timeout
 * error from `fetch` or from the body read (#1540) is rethrown through
 * `describeProviderFailure`, so the wrappers' one-line logs always carry the
 * vendor and the code.
 */

const SMTP2GO_SEND_URL = 'https://api.smtp2go.com/v3/email/send';

export interface SendArgs {
  to: string;
  subjectTemplate: string;
  bodyTemplate: string;
  data: Record<string, unknown>;
  htmlTemplate?: string;
  replyTo?: string;
  /** The template catalog key, when there is one. Only used to log a refused send (#1076). */
  templateKey?: string;
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

/**
 * A merge value that may render unescaped inside the html part: an absolute
 * https URL with no character that could close an attribute or open markup.
 *
 * WHY (#892). Handlebars escapes `=` to `&#x3D;` and `&` to `&amp;`, so a reset
 * link inside `href='{{link}}'` reached the inbox with entities in the URL.
 * Browsers decode them; a click-tracking rewriter that reads the attribute
 * literally does not, and hands the reader a dead link.
 *
 * WHY HERE AND NOT `{{{link}}}` IN THE TEMPLATES. Triple-stash is refused by
 * both template doors (`lib/templateValidation.ts`), so a seed carrying it
 * could never be imported, and an operator could not author it. Deciding at
 * render time also fixes every stored template at once, with no re-import.
 *
 * Anything that is not a plain https URL (a `javascript:` or `http:` value,
 * text, a URL carrying a quote, space, angle bracket or backtick) is left as an
 * ordinary string and keeps its escaping.
 */
const SAFE_HTTPS_URL = /^https:\/\/[^\s"'<>`\\]+$/;

export function isSafeHtmlUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !SAFE_HTTPS_URL.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname !== '';
  } catch {
    return false;
  }
}

/** The html render context: safe https URLs become SafeStrings, all else unchanged. */
function htmlRenderData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = isSafeHtmlUrl(value) ? new Handlebars.SafeString(value) : value;
  }
  return out;
}

/**
 * Renders subject, text and html exactly as they are sent. Pure, so the
 * rendering rules can be tested without the transport.
 */
export function renderEmailParts(
  args: Pick<SendArgs, 'subjectTemplate' | 'bodyTemplate' | 'htmlTemplate' | 'data'>,
): { subject: string; text: string; html: string | undefined } {
  // Subject and text are plain text: HTML entity escaping would corrupt URLs
  // ({{claimUrl}} -> claim?i&#x3D;1). Only the html body keeps escaping, apart
  // from safe https URLs (see isSafeHtmlUrl).
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
    ? stripUnresolvedTokens(Handlebars.compile(args.htmlTemplate)(htmlRenderData(args.data)))
    : undefined;
  return { subject, text, html };
}

export async function sendTemplatedEmail(args: SendArgs): Promise<string> {
  // SEND_SUPPRESS=1: log and return a marked id, never contact smtp2go. Checked
  // before the secret reads so a non-prod deploy needs no email credentials.
  // See lib/sendGuard.ts for why this exists and why it is fail-open.
  if (sendsAreSuppressed()) {
    logSuppressedSend('email', args.to, args.subjectTemplate);
    return suppressedId('email');
  }
  // #1076: a reserved or invented domain can only bounce, and bounces cost the
  // sender reputation. Refused before the secret reads and before any fetch;
  // resolves with a marked id so no caller throws or retries.
  if (isReservedEmailDomain(args.to)) {
    logRefusedSend(args.to, args.templateKey, args.subjectTemplate);
    return refusedId();
  }
  const key = process.env.SMTP2GO_API_KEY;
  if (!key) throw new Error('SMTP2GO_API_KEY environment variable is required');
  const from = process.env.EMAIL_FROM;
  if (!from) throw new Error('EMAIL_FROM environment variable is required');

  const { subject, text, html } = renderEmailParts(args);

  let res: Response;
  try {
    res = await fetch(SMTP2GO_SEND_URL, {
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
  } catch (err) {
    // #1535: a network failure never reaches the HTTP-error throws below. undici
    // throws `TypeError: fetch failed` with the real code on `err.cause.code`
    // (UND_ERR_CONNECT_TIMEOUT, ECONNRESET), and the trigger and callable
    // wrappers log the message alone, so a bare rethrow logged a line with no
    // vendor name and no timeout word for the real-services classifier (D3-e)
    // to read. Wrapped here rather than in each caller so the notification
    // channel, password reset, engagement, sendFromTemplate and suppressions
    // all describe the failure the same way. The original stays as `cause`.
    throw describeProviderFailure('smtp2go', err);
  }

  // #1540: the headers can arrive and the body still fail. undici errors the
  // body stream with `TypeError: terminated` and the real error as `cause`
  // (UND_ERR_BODY_TIMEOUT, ECONNRESET mid body), and `.catch(() => ({}))`
  // swallowed that into the generic "no sends succeeded" line below, with no
  // timeout word and no code for the classifier. An error carrying a code (its
  // own or `cause.code`) is a transport failure and is described like the
  // `fetch` throw above. A plain SyntaxError from a body that is not JSON has
  // no code and keeps the empty-object fallback: a 4xx then reads its HTTP
  // status as before, and an unreadable 2xx is still not a delivered send.
  let payload: Smtp2goResponse;
  try {
    payload = (await res.json()) as Smtp2goResponse;
  } catch (err) {
    if (providerFailureFields(err).providerCode !== undefined) {
      throw describeProviderFailure('smtp2go', err);
    }
    payload = {};
  }
  if (!res.ok) {
    throw new Error(`smtp2go send failed (HTTP ${res.status}): ${payload.data?.error ?? 'unknown error'}`);
  }
  if (!payload.data?.succeeded) {
    throw new Error(`smtp2go send failed: ${payload.data?.failures?.join('; ') ?? 'no sends succeeded'}`);
  }
  return payload.data.email_id ?? '';
}
