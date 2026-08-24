import type { NotificationDef } from './types';

/**
 * What a channel sends when its template DOCUMENT does not exist.
 *
 * THE PROBLEM THIS SOLVES. Templates live in Firestore (`emailTemplates/{id}`,
 * `smsTemplates/{id}`, `pushTemplates/{id}`) and arrive there only when the
 * operator runs the Template Bank importer. Every sender used to THROW when the
 * document was absent, which meant two bad things:
 *
 *   1. Shipping a new catalog key put a content deadline on the operator. The
 *      feature was dead in prod until they wrote public-facing copy, on the
 *      engineer's schedule rather than their own.
 *   2. Deleting templates broke the whole notification system. The operator
 *      intends to mass-delete and re-author the current set; before this, that
 *      delete would have taken down every message the business sends.
 *
 * Operator ruling 2026-08-23: "if there is going to be a dumbass blocker, then
 * in these cases create a generic message. i shouldnt be forced to make a public
 * facing doc so quickly."
 *
 * THIS IS NOT SILENT DEGRADATION. A fallback send is logged at `error` with the
 * key, channel and template id, and the channel subdoc is stamped
 * `usedFallback: true` so the admin surface can badge it. The recipient hears
 * from the business; the office sees that copy is missing. That is the
 * disclosed-fallback shape CLAUDE.md permits, not the silent kind it forbids.
 *
 * WHAT IS DELIBERATELY NOT COVERED. A catalog row with NO template id at all is
 * still a throw. That is a misconfigured row, a developer error, and there is no
 * operator action that fixes it. Only a MISSING DOCUMENT gets a fallback,
 * because that is the one caused by content not being authored yet.
 *
 * SMS IS EXCLUDED, by operator ruling on the same day: an SMS segment costs
 * money and a content-free "sign in to see it" is not worth paying for. The SMS
 * channel records a visible `skipped` instead. Email and push cost nothing per
 * message and carry it.
 */

/** Where each audience goes to read the thing we could not describe. */
const KINFOLK_URL = 'kinfolk.tribetails.com';
const OFFICE_URL = 'auntie.tribetails.com';

/**
 * True when this notification is going to a household rather than to the
 * business or to staff. Drives which app the fallback points at: telling a
 * kinfolk to sign in to AuntieOS is worse than telling them nothing.
 */
export function isKinfolkFacing(def: NotificationDef): boolean {
  return def.audiences?.kinfolk === true;
}

export interface FallbackEmail {
  subject: string;
  body: string;
}

/**
 * The generic email. Says nothing about WHAT happened, because this function
 * cannot know: it is the same text for a declined request, a new invoice and a
 * cancelled visit. Saying nothing specific is the only way it is never wrong.
 * The catalog's own `label` and `description` are written for the operator's
 * settings screen, not for a customer, so they are deliberately not used here.
 */
export function fallbackEmail(def: NotificationDef): FallbackEmail {
  if (isKinfolkFacing(def)) {
    return {
      subject: 'An update about your care',
      body: [
        "There's an update about your care with Tribe Tails Pet Care.",
        '',
        `Sign in to see it: ${KINFOLK_URL}`,
        '',
        "Tribe Tails Pet Care. Your Kin's Favorite Auntie.",
      ].join('\n'),
    };
  }
  return {
    subject: 'An update in AuntieOS',
    body: [
      "There's an update that needs your attention.",
      '',
      `Sign in to see it: ${OFFICE_URL}`,
      '',
      "Tribe Tails Pet Care. Your Kin's Favorite Auntie.",
    ].join('\n'),
  };
}

export interface FallbackPush {
  title: string;
  body: string;
}

/**
 * The generic push. Push is a doorbell rather than the message even when its
 * template DOES exist, so a content-free fallback costs almost nothing here:
 * tapping it lands on the real thing either way.
 */
export function fallbackPush(def: NotificationDef): FallbackPush {
  return isKinfolkFacing(def)
    ? { title: 'An update about your care', body: 'Tap to see it.' }
    : { title: 'An update in AuntieOS', body: 'Tap to see it.' };
}
