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
 * funnels through [kinRosterForNewVisit] (a new visit) or
 * [materializeKinRoster] (a booking that already exists), so the document that
 * lands in Firestore always carries the concrete roster, and no reader
 * anywhere has to know the convention or re-derive it.
 *
 * OPERATOR RULING 2026-11-12 (#1822 / #1862) made R1 the rule rather than the
 * fallback: EVERY VISIT COVERS EVERY KIN, and choosing specific Kin is a
 * feature flag that is off by default. See [kinRosterForNewVisit].
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
  /**
   * The id a booking stores for this Kin: the household copy's id
   * (`families/{kinfolkId}/kin/{id}`), or the admin record's id when the
   * office made the Kin and no household copy exists yet.
   */
  id: string;
  /** The admin record (`kin/{flatId}`) tied to this Kin, or null when it has none. */
  flatId: string | null;
  /** Null when the doc carries no usable `name`, never an empty string. */
  name: string | null;
}
function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
/**
 * The household's ACTIVE Kin. THE one roster: every booking writer, the
 * `getHouseholdKinRoster` callable both admin apps, the desktop console and
 * both portal apps draw their Kin list from, all read it here (#1862).
 *
 * A Kin lives in two places (see `lib/kinLink.ts`): the household's copy
 * `families/{kinfolkId}/kin/{kinId}` and the admin's flat `kin/{id}`. The
 * three surfaces used to count different ones. The admin wizard listed the
 * flat docs and sent their ids, the server named only the ids that happened
 * to be household copies too, and the portal listed the household copies with
 * a memorial Kin among them. One booking read six Kin, three and four.
 *
 * - A Kin with a household copy is on the roster under that copy's id, when
 *   the copy is active. The copy's `status` is the one that counts: an office
 *   archive writes both copies (`lib/kinArchive.ts`), and a memorial is the
 *   household's own.
 * - A Kin the office made that has no household copy yet is on the roster
 *   under its admin id, when the admin record is active. Without this a
 *   household whose only Kin the office typed in had an empty roster, and its
 *   visits covered nobody (#1822).
 *
 * Inactive means [isInactiveKinStatus]: the memorial state plus the legacy
 * AuntieOS `inactive`/`archived` spellings. A pet who is no longer with us is
 * still LISTED in the portal (that is a visibility question), but is not
 * receiving care, so putting them on a future visit would put a name on a
 * roster the Auntie cannot act on. A doc with no `status` counts as active,
 * per `kinStatus.ts`.
 */
export async function readHouseholdKinRoster(kinfolkId: string): Promise<KinRosterEntry[]> {
  const firestore = db();
  const [familySnap, flatSnap] = await Promise.all([
    firestore.collection('families').doc(kinfolkId).collection('kin').get(),
    firestore.collection('kin').where('kinfolkId', '==', kinfolkId).get(),
  ]);
  const flatDocs = flatSnap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }));
  const flatIds = new Set(flatDocs.map((f) => f.id));
  /** Admin records a household copy accounts for, active or not. */
  const claimed = new Set<string>();
  const roster: KinRosterEntry[] = [];
  for (const doc of familySnap.docs) {
    const data = doc.data() as Record<string, unknown>;
    const stamped = textOf(data['legacyKinId']);
    const pointed = flatDocs.find((f) => textOf(f.data['familyKinPath']) === `families/${kinfolkId}/kin/${doc.id}`);
    const flatId = stamped !== '' ? stamped : pointed ? pointed.id : flatIds.has(doc.id) ? doc.id : null;
    if (flatId !== null) claimed.add(flatId);
    if (pointed) claimed.add(pointed.id);
    if (isInactiveKinStatus(data['status'])) continue;
    const name = textOf(data['name']);
    roster.push({ id: doc.id, flatId, name: name !== '' ? (data['name'] as string) : null });
  }
  for (const flat of flatDocs) {
    if (claimed.has(flat.id)) continue;
    if (isInactiveKinStatus(flat.data['status'])) continue;
    const name = textOf(flat.data['name']);
    roster.push({ id: flat.id, flatId: flat.id, name: name !== '' ? (flat.data['name'] as string) : null });
  }
  return roster;
}
function rosterPair(entries: readonly KinRosterEntry[]): { kinIds: string[]; kinNames: string[] } {
  return {
    kinIds: entries.map((k) => k.id),
    // Same convention as resolveKinNames: a nameless Kin contributes an id but
    // no name, rather than an empty string a UI would render as a blank chip.
    kinNames: entries.map((k) => k.name).filter((n): n is string => n !== null),
  };
}
/**
 * Resolves the `kinIds` + `kinNames` pair for a booking that ALREADY EXISTS,
 * from the ids stored on it: an approval, or a visit getting its booking
 * record. A new visit goes through [kinRosterForNewVisit] instead.
 *
 * - The record names specific Kin: those ids are kept, de-duplicated, names
 *   resolved. An existing booking keeps the Kin it was made for.
 * - The record names none: R1 applies and the full active roster is
 *   materialized.
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
  return rosterPair(await readHouseholdKinRoster(kinfolkId));
}
/**
 * The Kin a NEW visit covers (operator ruling 2026-11-12, #1822 / #1862).
 *
 * EVERY VISIT COVERS EVERY KIN. With `chooseKin` off, the default, whatever
 * the caller named is set aside and the household's whole active roster is
 * stored. That is what makes an older installed app harmless: an Android
 * build that still shows its own Kin picker sends a subset, and the visit is
 * written for the whole home all the same.
 *
 * With `chooseKin` on (the `auntieos.visits.chooseKin` feature flag) the Kin
 * the caller named are the ones stored, as long as they are on the roster. A
 * named id may be either of a Kin's two ids: the admin apps list admin records
 * and the portal lists household copies, and both mean the same animal. An id
 * that is not an active Kin of this household is dropped. Naming none, or
 * none that is on the roster, means the whole home: a visit for nobody is not
 * a thing the business sells.
 *
 * The roster is read once, here, and frozen on the document. A Kin added
 * later is on the next visit that is made, never on this one.
 */
export async function kinRosterForNewVisit(
  kinfolkId: string,
  kinIds: readonly string[] | null | undefined,
  opts: { chooseKin: boolean },
): Promise<{ kinIds: string[]; kinNames: string[] }> {
  const roster = await readHouseholdKinRoster(kinfolkId);
  if (!opts.chooseKin) return rosterPair(roster);
  const named = new Set((kinIds ?? []).filter((id) => typeof id === 'string' && id.length > 0));
  const chosen = roster.filter((k) => named.has(k.id) || (k.flatId !== null && named.has(k.flatId)));
  return rosterPair(chosen.length > 0 ? chosen : roster);
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
