import type { Firestore } from 'firebase-admin/firestore';
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
 * next booking picks the new Kin up, and the owner can add the Kin to the
 * upcoming visits in one deliberate step (`admin/addKinToUpcomingVisits.ts`,
 * #1822), which never touches a visit that has started. That is deliberate. The alternative (a `coversAllKin` flag expanded at read time)
 * would re-answer "who is covered" against today's roster every time the page
 * loads, so a session completed in March would silently start listing a dog
 * adopted in July, rewriting history, on a record that feeds KinTales and
 * invoices.
 */

/** One Kin of a household, as the roster reader sees it. */
export interface KinRosterEntry {
  /**
   * The id a booking stores for this Kin: its admin record's id (`kin/{id}`)
   * when it has one, else the household copy's id. See [readHouseholdKin] for
   * why the admin record's id is the one stored.
   */
  id: string;
  /** The household copy (`families/{kinfolkId}/kin/{householdId}`), or null when the office made the Kin and no copy exists yet. */
  householdId: string | null;
  /** Null when the doc carries no usable `name`, never an empty string. */
  name: string | null;
  /** False for a memorial or archived Kin. */
  active: boolean;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function nameOf(data: Record<string, unknown>): string | null {
  return textOf(data['name']) !== '' ? (data['name'] as string) : null;
}

/**
 * Every Kin of a household, each one once, active or not.
 *
 * A Kin lives in two places (see `lib/kinLink.ts`): the household's copy
 * `families/{kinfolkId}/kin/{kinId}` and the admin's flat `kin/{id}`, tied by
 * `legacyKinId` on the copy and `familyKinPath` on the record. The two ids
 * differ for every Kin a household adds itself (`onFamilyKinWrite` mints the
 * admin record under a new id).
 *
 * WHICH ID A BOOKING STORES (#1862). The admin record's, when there is one.
 * Every admin reader looks a visit's Kin up there by that id: the KinTale
 * composer's per-Kin rows (`getKin`), the Auntie Time avatars, the 411 lookup
 * on Android, the desktop Kin photos. No portal screen looks a Kin up by a
 * booking's ids at all; they read `kinNames`. The writers used to store
 * whichever id their caller happened to hold, so a visit a household asked
 * for carried ids the composer could not find. A Kin with no admin record yet
 * is stored under its household copy's id.
 *
 * WHOSE STATUS COUNTS. The household copy's, when there is one: an office
 * archive writes both copies (`lib/kinArchive.ts`), and a memorial is the
 * household's own. A Kin the office made that has no copy yet goes by its
 * admin record.
 *
 * When two household copies claim one admin record (a crossed link,
 * `lib/kinLink.ts`), the first keeps its id and the other is listed under its
 * own, so no id ever names two Kin.
 */
export async function readHouseholdKin(kinfolkId: string, firestore: Firestore = db()): Promise<KinRosterEntry[]> {
  const [familySnap, flatSnap] = await Promise.all([
    firestore.collection('families').doc(kinfolkId).collection('kin').get(),
    firestore.collection('kin').where('kinfolkId', '==', kinfolkId).get(),
  ]);
  const flatDocs = flatSnap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }));
  const flatIds = new Set(flatDocs.map((f) => f.id));
  /** Admin records a household copy accounts for. */
  const claimed = new Set<string>();
  const all: KinRosterEntry[] = [];
  for (const doc of familySnap.docs) {
    const data = doc.data() as Record<string, unknown>;
    const stamped = textOf(data['legacyKinId']);
    const pointed = flatDocs.find((f) => textOf(f.data['familyKinPath']) === `families/${kinfolkId}/kin/${doc.id}`);
    const linked =
      stamped !== '' && flatIds.has(stamped) ? stamped : pointed ? pointed.id : flatIds.has(doc.id) ? doc.id : null;
    const own = linked !== null && !claimed.has(linked) ? linked : null;
    if (own !== null) claimed.add(own);
    all.push({
      id: own ?? doc.id,
      householdId: doc.id,
      name: nameOf(data),
      active: !isInactiveKinStatus(data['status']),
    });
  }
  for (const flat of flatDocs) {
    if (claimed.has(flat.id)) continue;
    all.push({
      id: flat.id,
      householdId: null,
      name: nameOf(flat.data),
      active: !isInactiveKinStatus(flat.data['status']),
    });
  }
  return all;
}

/**
 * The household's ACTIVE Kin. THE one roster: every booking writer, and the
 * `getHouseholdKinRoster` callable both admin apps, the desktop console and
 * both portal apps draw their Kin list from, read it here (#1862).
 *
 * The three surfaces used to count different Kin. The admin wizard listed the
 * admin records and sent their ids, the server named only the ids that
 * happened to be household copies too, and the portal listed the household
 * copies with a memorial Kin among them. One booking read six Kin, three and
 * four. And a household whose only Kin the office had typed in had no roster
 * at all, so its visits covered nobody (#1822).
 *
 * Inactive means [isInactiveKinStatus]: the memorial state plus the legacy
 * AuntieOS `inactive`/`archived` spellings. A pet who is no longer with us is
 * still LISTED in the portal (that is a visibility question), but is not
 * receiving care, so putting them on a future visit would put a name on a
 * roster the Auntie cannot act on. A doc with no `status` counts as active,
 * per `kinStatus.ts`.
 */
export async function readHouseholdKinRoster(kinfolkId: string): Promise<KinRosterEntry[]> {
  return (await readHouseholdKin(kinfolkId)).filter((k) => k.active);
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
 * The household Kin [id] names, by either of its two ids, or undefined. The
 * id a Kin is stored under wins over a household card id that happens to
 * match, so an id never resolves to a second Kin.
 */
export function rosterEntryFor(all: readonly KinRosterEntry[], id: string): KinRosterEntry | undefined {
  return all.find((k) => k.id === id) ?? all.find((k) => k.householdId === id);
}

/**
 * #2350: household card id -> the id a visit stores for that Kin, for every
 * Kin whose two ids differ. Read from [readHouseholdKin], memorial and
 * archived Kin included: an old visit may carry a Kin that has since passed.
 * A card id that is also some Kin's stored id is left out, so an alias never
 * points one Kin's visits at another.
 */
export function kinIdAliases(all: readonly KinRosterEntry[]): Map<string, string> {
  const stored = new Set(all.map((k) => k.id));
  const aliases = new Map<string, string>();
  for (const k of all) {
    if (k.householdId === null || k.householdId === k.id || stored.has(k.householdId)) continue;
    aliases.set(k.householdId, k.id);
  }
  return aliases;
}

/**
 * Resolves the `kinIds` + `kinNames` pair for a booking that ALREADY EXISTS,
 * from the ids stored on it: an approval, or a visit getting its booking
 * record. A new visit goes through [kinRosterForNewVisit] instead.
 *
 * - The record names specific Kin: an existing booking keeps the Kin it was
 *   made for. A stored id may be either of a Kin's two ids (older writers
 *   stored whichever they were sent). #2350: each is written back as the id
 *   the admin screens look the Kin up by (its admin record's, see
 *   [readHouseholdKin]), de-duplicated, and named. A household request made
 *   before #2347 carries household card ids, and an approval that kept them
 *   booked a visit whose Kin no admin screen could find. An id this household
 *   no longer has is kept as it is, looked up the old way and, failing that,
 *   contributes no name.
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
  const named = [...new Set(kinIds ?? [])].filter((id) => id.length > 0);
  const all = await readHouseholdKin(kinfolkId);
  if (named.length === 0) return rosterPair(all.filter((k) => k.active));
  const known = (id: string) => rosterEntryFor(all, id);
  // #2350: one Kin named under both of its ids is one Kin, stored once.
  const stated = [...new Set(named.map((id) => known(id)?.id ?? id))];
  const unknown = stated.filter((id) => known(id) === undefined);
  // One batched read for the ids no current Kin answers to, in stated order.
  const strays = unknown.length > 0 ? await resolveKinNames(kinfolkId, unknown) : [];
  const kinNames: string[] = [];
  for (const id of stated) {
    const name = known(id)?.name;
    if (typeof name === 'string') kinNames.push(name);
  }
  return { kinIds: stated, kinNames: [...kinNames, ...strays] };
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
 * named id may be either of a Kin's two ids: an older admin app lists admin
 * records and an older portal app lists household copies, and both mean the
 * same animal. An id that is not an active Kin of this household is dropped.
 * Naming none, or none that is on the roster, means the whole home: a visit
 * for nobody is not a thing the business sells.
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
  const chosen = roster.filter((k) => named.has(k.id) || (k.householdId !== null && named.has(k.householdId)));
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
