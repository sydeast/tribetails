import { db } from './firestoreAdmin';
import { isInactiveKinStatus } from './kinStatus';
import { resolveKinNames } from './resolveKinNames';

/**
 * OPERATOR RULING R1: a KinCare session covers EVERY Kin in the household.
 *
 * "KinCare rarely is split between the Kin in a home. IE. kinfolk has a dog and
 * a cat. The KinCare will always care for both the dog and cat. I wouldn't go
 * into a home and care for one kin while ignoring the other."
 *
 * So an absent or empty `kinIds` on an incoming booking payload never meant
 * "this visit is for no Kin". A booking for zero animals is not a thing the
 * business sells. It meant "all of them", and the writer stored the omission
 * literally, which is how a whole-household booking ended up rendering as
 * "Not set" and "your kin" downstream.
 *
 * This module is where that omission gets MATERIALIZED. Every booking writer
 * funnels through [materializeKinRoster], so the document that lands in
 * Firestore always carries the concrete roster, and no reader anywhere has to
 * know the convention or re-derive it.
 *
 * ROSTER DRIFT, the consequence this design accepts: the roster is resolved
 * ONCE, at write time, and then frozen on the document. A Kin adopted next
 * month is NOT retroactively added to a booking already on the calendar; the
 * operator edits the booking, or the next booking picks the new Kin up. That
 * is deliberate. The alternative (a `coversAllKin` flag expanded at read time)
 * would re-answer "who is covered" against today's roster every time the page
 * loads, so a session completed in March would silently start listing a dog
 * adopted in July, rewriting history, on a record that feeds KinTales and
 * invoices.
 */

/** One Kin on a household's roster, as the roster reader sees it. */
export interface KinRosterEntry {
  id: string;
  /** Null when the doc carries no usable `name`, never an empty string. */
  name: string | null;
}

/**
 * The household's ACTIVE Kin, from the same `families/{kinfolkId}/kin` docs
 * `getMyKin` reads.
 *
 * Inactive means [isInactiveKinStatus]: the memorial state plus the legacy
 * AuntieOS `inactive`/`archived` spellings. A pet who is no longer with us is
 * still LISTED in the portal (that is a visibility question), but is not
 * receiving care, so putting them on a future visit would put a name on a
 * roster the Auntie cannot act on. A doc with no `status` counts as active,
 * per `kinStatus.ts`.
 */
export async function readHouseholdKinRoster(kinfolkId: string): Promise<KinRosterEntry[]> {
  const snap = await db().collection('families').doc(kinfolkId).collection('kin').get();
  const roster: KinRosterEntry[] = [];
  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown>;
    if (isInactiveKinStatus(data['status'])) continue;
    const name = data['name'];
    roster.push({
      id: doc.id,
      name: typeof name === 'string' && name.trim().length > 0 ? name : null,
    });
  }
  return roster;
}

/**
 * Resolves the `kinIds` + `kinNames` pair a booking or session document should
 * carry, given whatever the caller stated.
 *
 * - Caller named specific Kin: those ids win, de-duplicated, names resolved.
 *   Narrowing a booking to a subset is an explicit act and is honored exactly.
 * - Caller named none: R1 applies and the full active roster is materialized.
 *
 * A household with genuinely no Kin on file still yields `[]`, which is honest:
 * there is nothing to name. That is the one case an empty `kinIds` survives,
 * and it stops meaning "unknown" the moment a Kin is added and the next booking
 * is written.
 */
export async function materializeKinRoster(
  kinfolkId: string,
  kinIds: readonly string[] | null | undefined,
): Promise<{ kinIds: string[]; kinNames: string[] }> {
  const stated = [...new Set(kinIds ?? [])].filter((id) => id.length > 0);
  if (stated.length > 0) {
    return { kinIds: stated, kinNames: await resolveKinNames(kinfolkId, stated) };
  }
  const roster = await readHouseholdKinRoster(kinfolkId);
  return {
    kinIds: roster.map((k) => k.id),
    // Same convention as resolveKinNames: a nameless Kin contributes an id but
    // no name, rather than an empty string a UI would render as a blank chip.
    kinNames: roster.map((k) => k.name).filter((n): n is string => n !== null),
  };
}

/**
 * The household's display name, for stamping onto a session document.
 *
 * WHY A SESSION CARRIES A NAME AT ALL: every list that renders visits — the
 * admin Schedule agenda, Auntie Time, Home — reads `kinfolkName` straight off
 * the `kin_care_sessions` row and never joins back to `kinfolk`
 * (`auntieos-admin/src/lib/sessionFormat.ts#sessionHousehold`). A row without
 * it renders as "Unnamed Kinfolk", which is what every session
 * `createKinCareSession` has ever written looked like: it was the one visit
 * writer that never stamped the field, so an ad-hoc visit was anonymous on the
 * very screen that created it.
 *
 * Resolution matches `approveBookingSeriesCore`'s (`firstName` + `lastName` off
 * `kinfolk/{kinfolkId}`, falling back to the id) so two writers to one
 * collection do not disagree about what the field holds. That handler keeps its
 * own copy rather than calling this one: it has a booking-envelope parent doc
 * to consult FIRST, which this caller has no equivalent of.
 *
 * Best-effort by design: a read failure returns the id rather than throwing. A
 * missing display name must not be the reason a real visit fails to be booked.
 */
export async function resolveKinfolkDisplayName(kinfolkId: string): Promise<string> {
  try {
    const snap = await db().collection('kinfolk').doc(kinfolkId).get();
    const data = snap.data() as Record<string, unknown> | undefined;
    const stated = data?.['kinfolkName'];
    if (typeof stated === 'string' && stated.trim() !== '') return stated.trim();
    const first = typeof data?.['firstName'] === 'string' ? data['firstName'] : '';
    const last = typeof data?.['lastName'] === 'string' ? data['lastName'] : '';
    return `${first} ${last}`.trim() || kinfolkId;
  } catch {
    return kinfolkId;
  }
}
