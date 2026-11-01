import { db } from './firestoreAdmin';
import { logEvent } from './logger';

/**
 * The operator's business name, for household-facing prose (#1381).
 *
 * The one source is `business_settings/business_settings.businessName`, the same
 * field `getMyHome` returns to both portal clients and the invoice footnote reads
 * (#1369). Server-built household text (a refused request, an email's fallback
 * wording, a push title, an invoice PDF) names the business through this module
 * so it can never drift from what the apps show.
 *
 * NO NAME IS EVER INVENTED. When the operator has not set one, sentences say
 * "your Auntie" ([BUSINESS_FALLBACK]) and footnote-style lines are omitted by
 * their callers. The same rule the web and Android portals follow.
 *
 * Kept out of `emailFrame.ts` and the other pure modules for the reason
 * `emailFrameStore.ts` is: those are cold-start-pinned and synchronous.
 */
export const BUSINESS_FALLBACK = 'your Auntie';

export interface BusinessLabelOptions {
  /** The label opens a sentence: "Your Auntie could not take that time." */
  capital?: boolean;
  /** "your Auntie's" / "Test Business's". */
  possessive?: boolean;
}

/** [name] as it reads inside a sentence. Pure. */
export function businessLabel(name: string | null | undefined, opts: BusinessLabelOptions = {}): string {
  const trimmed = (name ?? '').trim();
  let label = trimmed === '' ? BUSINESS_FALLBACK : trimmed;
  if (opts.possessive === true) label += "'s";
  if (opts.capital === true) label = label.charAt(0).toUpperCase() + label.slice(1);
  return label;
}

/**
 * Fills the household copy placeholders in a stored string: `{business}`,
 * `{Business}` (opens a sentence) and `{business's}` (possessive). Used on the
 * static notification catalog, whose strings cannot know the name themselves.
 */
export function fillBusinessPlaceholders(text: string, name: string | null | undefined): string {
  return text
    .replace(/\{Business's\}/g, businessLabel(name, { capital: true, possessive: true }))
    .replace(/\{business's\}/g, businessLabel(name, { possessive: true }))
    .replace(/\{Business\}/g, businessLabel(name, { capital: true }))
    .replace(/\{business\}/g, businessLabel(name));
}

/**
 * The merge fields notification templates use for the business: `{{business}}`
 * mid-sentence ("news from your Auntie") and `{{Business}}` where it opens one
 * ("Your Auntie: a password reset was requested"). Both are the settings name
 * when set and "your Auntie" / "Your Auntie" when not.
 */
export function businessTokens(name: string | null | undefined): { business: string; Business: string } {
  return { business: businessLabel(name), Business: businessLabel(name, { capital: true }) };
}

/**
 * Reads the stored name. '' when unset, blank, or when the read fails: a name
 * that cannot be read must degrade to the neutral wording, never to an error
 * that blocks a booking refusal, an email or a PDF. A failed read is logged.
 */
export async function loadBusinessName(caller: string): Promise<string> {
  try {
    const snap = await db().collection('business_settings').doc('business_settings').get();
    const raw = snap.data()?.['businessName'];
    return typeof raw === 'string' ? raw.trim() : '';
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: caller,
      event: 'business.name.read_failed',
      extra: { err: (err as Error)?.message ?? String(err), action: 'used the neutral wording' },
    });
    return '';
  }
}
