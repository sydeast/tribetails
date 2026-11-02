import { businessLabel } from './businessName';
import { DAY_NAMES } from './businessHours';
import type { BusinessPublicCard } from './businessPublicCard';

/**
 * #1399: the email footer every visual email carries, composed from settings.
 *
 * Ruling 2026-11-01: the footer is required and never blank. It is built from
 * the public business card (`businessPublicCard.ts`: name, weekly hours,
 * published phone, privacy policy link), the same projection the sign-in
 * screen reads, so an email can never say something about the business that
 * the portal does not. The free-text `footerText` line (#957) stays as an
 * optional extra line under the composed block.
 *
 * NO NAME IS EVER INVENTED (`businessName.ts`). A blank business name drops the
 * name line and words the hours line "Your Auntie's hours". Blank hours, a
 * blank phone and a blank privacy link each drop their own line rather than
 * print a placeholder.
 *
 * Pure: no Firestore, no logger. `emailFrame.ts` imports this at module scope
 * for every send route.
 */

/** What the footer needs. The public card already carries exactly these. */
export type EmailFooterFacts = Pick<BusinessPublicCard, 'name' | 'phone' | 'hours' | 'privacyPolicyUrl'>;

/** The card of a business that has set nothing: every line is omitted. */
export const EMPTY_FOOTER_FACTS: Readonly<EmailFooterFacts> = Object.freeze({
  name: '',
  phone: '',
  hours: Object.freeze(Object.fromEntries(DAY_NAMES.map((d) => [d, '']))) as EmailFooterFacts['hours'],
  privacyPolicyUrl: '',
});

/**
 * `(512) 555-0142` for a US number in any common shape; anything else as
 * stored. Ported from the portal's `mytribe/web/src/lib/phone.ts` (and its
 * Kotlin twin `util/PhoneFormat.kt`) so an email shows a number the way the
 * portal does. Ported rather than imported: Cloud Functions deploy as a
 * self-contained artifact (see `businessHours.ts`).
 */
export function formatPhoneForDisplay(raw: string | null | undefined): string {
  if (raw == null) return '';
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  const digits = trimmed.replace(/\D/g, '');
  let us: string | null = null;
  if (digits.length === 10 && !trimmed.startsWith('+')) us = digits;
  else if (digits.length === 11 && digits.startsWith('1')) us = digits.slice(1);
  if (!us) return trimmed;
  return `(${us.slice(0, 3)}) ${us.slice(3, 6)}-${us.slice(6)}`;
}

/**
 * "8:00 AM" for a normalized "08:00". The admin's `scheduleFormat.ts` renders
 * the hours editor the same way. Anything that is not HH:MM comes back as is.
 */
export function formatHHmm12h(hhmm: string): string {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const hour = Number(m[1]);
  if (hour > 23) return hhmm;
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${m[2]} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** One day as the footer words it: "Monday 8:00 AM to 6:00 PM" or "Sunday Closed". */
export function formatDayHours(day: string, range: string): string {
  const m = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(range);
  if (!m) return `${day} Closed`;
  return `${day} ${formatHHmm12h(m[1]!)} to ${formatHHmm12h(m[2]!)}`;
}

/** True when no day carries hours: the operator has not set them, so no hours line is drawn. */
export function hoursUnset(hours: EmailFooterFacts['hours']): boolean {
  return DAY_NAMES.every((day) => (hours[day] ?? '') === '');
}

/**
 * The footer's lines, as plain text, in order. Markup-free so the renderer
 * escapes each one; the privacy link is the one line that is not plain text
 * and is handed back separately.
 */
export interface ComposedFooter {
  /** The business name, '' when unset (no footnote line). */
  nameLine: string;
  /** "Hours: Monday ... · Sunday Closed", or '' when no hours are set. */
  hoursLine: string;
  /** "Phone: (512) 555-0142", or '' when unset. */
  phoneLine: string;
  /** An https URL, or '' when unset. */
  privacyPolicyUrl: string;
}

export function composeFooter(facts: EmailFooterFacts): ComposedFooter {
  const name = facts.name.trim();
  let hoursLine = '';
  if (!hoursUnset(facts.hours)) {
    const label = name === '' ? `${businessLabel(name, { capital: true, possessive: true })} hours` : 'Hours';
    hoursLine = `${label}: ${DAY_NAMES.map((day) => formatDayHours(day, facts.hours[day] ?? '')).join(' · ')}`;
  }
  const phone = formatPhoneForDisplay(facts.phone);
  return {
    nameLine: name,
    hoursLine,
    phoneLine: phone === '' ? '' : `Phone: ${phone}`,
    privacyPolicyUrl: facts.privacyPolicyUrl.trim(),
  };
}
