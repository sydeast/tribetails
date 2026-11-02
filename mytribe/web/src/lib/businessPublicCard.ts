import { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { firestore } from './firebase';

/**
 * #1321: the public business card, read straight from `business_public/card`
 * BEFORE sign-in. The sign-in and email-action screens put "by <business>"
 * under the MyTribe wordmark so a household knows it has the right app, and the
 * About screen (#1411) reuses this read.
 *
 * WHY A DIRECT READ. The screens that need it have no user yet, so no callable
 * can answer, and a callable's cold start (5 to 13 s on the 2026-11-01 walk)
 * would delay the one line on the page that has nothing to wait for. Firestore
 * has no cold start, and `firestore.rules` opens `business_public/{docId}` to
 * every reader and no client writer. The `onBusinessSettingsWrite` trigger
 * keeps the document equal to the four public fields of the staff-only
 * settings document; `functions/src/lib/businessPublicCard.ts` is the closed
 * list, and the mapping below is a field-for-field copy of it.
 *
 * NO NAME IS EVER INVENTED. A missing card, a blank name, a failed read and a
 * cold cache all read as `name: ''`, and the screens leave the line out.
 */
export const BUSINESS_PUBLIC_CARD_PATH = ['business_public', 'card'] as const;

/** Monday-first, the order the settings editor writes and the card carries. */
export const PUBLIC_HOURS_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
export type PublicHoursDay = (typeof PUBLIC_HOURS_DAYS)[number];

export interface BusinessPublicCard {
  name: string;
  phone: string;
  /** Every day present; "HH:MM-HH:MM" when open, '' when closed. */
  hours: Record<PublicHoursDay, string>;
  /** '' until #1410 lands and the operator sets one; always https when set. */
  privacyPolicyUrl: string;
}

/** The card with nothing set: what every failure path and a cold cache read as. */
export function emptyBusinessPublicCard(): BusinessPublicCard {
  const hours = {} as Record<PublicHoursDay, string>;
  for (const day of PUBLIC_HOURS_DAYS) hours[day] = '';
  return { name: '', phone: '', hours, privacyPolicyUrl: '' };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Maps the stored document to the card. Unknown keys are dropped; a bad value reads as unset. */
export function businessPublicCardFromDoc(data: Record<string, unknown> | undefined): BusinessPublicCard {
  const card = emptyBusinessPublicCard();
  if (!data) return card;
  card.name = str(data['name']);
  card.phone = str(data['phone']);
  const hours = data['hours'];
  if (hours && typeof hours === 'object' && !Array.isArray(hours)) {
    for (const day of PUBLIC_HOURS_DAYS) card.hours[day] = str((hours as Record<string, unknown>)[day]);
  }
  const url = str(data['privacyPolicyUrl']);
  card.privacyPolicyUrl = url.startsWith('https://') ? url : '';
  return card;
}

/** Reads the card. Throws whatever Firestore throws; the caller decides the fallback. */
export async function readBusinessPublicCardDirect(): Promise<BusinessPublicCard> {
  const snap = await getDoc(doc(firestore, BUSINESS_PUBLIC_CARD_PATH[0], BUSINESS_PUBLIC_CARD_PATH[1]));
  return businessPublicCardFromDoc(snap.exists() ? (snap.data() as Record<string, unknown>) : undefined);
}

/**
 * The last card this browser saw, so a cold open shows the business name with
 * the headline instead of a beat later. localStorage, not sessionStorage: the
 * point is the NEXT visit. Every access is guarded: Safari may have wiped the
 * store (see `installState.ts`), a private window may refuse it, and neither
 * is a reason for the sign-in form to fail.
 */
export const BUSINESS_PUBLIC_CARD_CACHE_KEY = 'businessPublicCard';

export function readCachedBusinessPublicCard(): BusinessPublicCard | null {
  try {
    const raw = localStorage.getItem(BUSINESS_PUBLIC_CARD_CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return businessPublicCardFromDoc(parsed as Record<string, unknown>);
  } catch {
    return null;
  }
}

/**
 * The cached business name and nothing else: no live read, so a screen that
 * draws offline (#1428: LaunchOffline, LaunchError) never waits on the network.
 * '' on a cold cache, and the screen leaves its footer out.
 */
export function readCachedBusinessName(): string {
  return readCachedBusinessPublicCard()?.name ?? '';
}
export function cacheBusinessPublicCard(card: BusinessPublicCard): void {
  try {
    localStorage.setItem(BUSINESS_PUBLIC_CARD_CACHE_KEY, JSON.stringify(card));
  } catch {
    // A full or refused store costs the next visit a beat, nothing more.
  }
}

/**
 * The card for a pre-auth screen: the cached copy at once (or the empty card),
 * then the live one when the read returns. A failed read keeps whatever was
 * showing; it is never surfaced, because a missing "by ..." line is not a
 * degraded state worth a banner on the sign-in form.
 */
export function useBusinessPublicCard(): BusinessPublicCard {
  const [card, setCard] = useState<BusinessPublicCard>(() => readCachedBusinessPublicCard() ?? emptyBusinessPublicCard());
  useEffect(() => {
    let live = true;
    readBusinessPublicCardDirect()
      .then((fresh) => {
        cacheBusinessPublicCard(fresh);
        if (live) setCard(fresh);
      })
      .catch(() => {
        // Keep the cached or empty card.
      });
    return () => {
      live = false;
    };
  }, []);
  return card;
}
