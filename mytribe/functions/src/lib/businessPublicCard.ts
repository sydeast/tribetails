import { businessHoursForDayName, DAY_NAMES } from './businessHours';

/**
 * The public business card (#1321): the few facts about the business a
 * household may read BEFORE signing in. The sign-in screen names the business
 * under the MyTribe wordmark so a household knows it has the right app, and the
 * About screen (#1411) reuses the same read.
 *
 * WHY A MIRROR DOCUMENT. `business_settings/business_settings` is staff-only in
 * `firestore.rules` and holds some fifty fields, several of them operational
 * (rates, payment handles, notification gates). The sign-in page cannot read
 * it, and must not be able to. `onBusinessSettingsWrite` copies ONLY the fields
 * below into `business_public/card`, which the rules let anyone read and no
 * client write. A direct Firestore read has no cold start, which is what lets
 * the "by ..." line follow the headline instead of delaying the form.
 *
 * WHAT IS PUBLIC, AND NOTHING ELSE. The list is closed:
 *   name              `businessName`
 *   phone             `businessPhone`, the published line
 *   hours             `businessHours`, the seven Monday-first days, each a
 *                     normalized "HH:MM-HH:MM" or '' for a closed day
 *   privacyPolicyUrl  `privacyPolicyUrl` once #1410 adds it to settings; ''
 *                     until then and whenever the stored value is not an
 *                     https URL
 * Adding a field here means deciding it may be read by anyone on the internet.
 */
export const BUSINESS_PUBLIC_CARD_DOC = 'business_public/card';

/** `business_settings/business_settings`, the one document the mirror follows. */
export const BUSINESS_SETTINGS_SOURCE_DOC = 'business_settings/business_settings';

/** One entry per day in `DAY_NAMES`, '' when closed or when the stored range could not be read. */
export type PublicWeeklyHours = Record<(typeof DAY_NAMES)[number], string>;

export interface BusinessPublicCard {
  name: string;
  phone: string;
  hours: PublicWeeklyHours;
  /** '' until #1410 lands and the operator sets one. Always an https URL when set. */
  privacyPolicyUrl: string;
}

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * A public card may only carry a link a browser can follow safely. Anything
 * that is not https (a `javascript:` value, a bare domain, a typo) reads as
 * unset, so the clients draw no link at all rather than a broken one.
 */
export function publicHttpsUrl(value: unknown): string {
  const raw = trimmedString(value);
  if (raw === '') return '';
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

/** `businessHours` as the card carries it: every day present, normalized, closed as ''. */
export function publicWeeklyHours(hours: unknown): PublicWeeklyHours {
  const out = {} as PublicWeeklyHours;
  for (const day of DAY_NAMES) {
    const parsed = businessHoursForDayName(hours, day);
    out[day] = parsed.kind === 'open' ? `${parsed.startHHmm}-${parsed.endHHmm}` : '';
  }
  return out;
}

/**
 * Projects a raw settings document onto the card. Pure, and the ONLY place the
 * public field list is spelled: a settings field that is not read here never
 * reaches the public document, whatever the admin writes.
 */
export function buildBusinessPublicCard(settings: Record<string, unknown> | undefined): BusinessPublicCard {
  const s = settings ?? {};
  return {
    name: trimmedString(s['businessName']),
    phone: trimmedString(s['businessPhone']),
    hours: publicWeeklyHours(s['businessHours']),
    privacyPolicyUrl: publicHttpsUrl(s['privacyPolicyUrl']),
  };
}

/** True when the stored card already says exactly what `next` says, so no write is due. */
export function sameBusinessPublicCard(stored: Record<string, unknown> | undefined, next: BusinessPublicCard): boolean {
  if (!stored) return false;
  if (stored['name'] !== next.name || stored['phone'] !== next.phone) return false;
  if (stored['privacyPolicyUrl'] !== next.privacyPolicyUrl) return false;
  const hours = stored['hours'];
  if (!hours || typeof hours !== 'object') return false;
  const storedHours = hours as Record<string, unknown>;
  if (Object.keys(storedHours).length !== DAY_NAMES.length) return false;
  return DAY_NAMES.every((day) => storedHours[day] === next.hours[day]);
}
