import type { Firestore } from 'firebase-admin/firestore';
import { db } from './firestoreAdmin';
import { kinIdAliases, readHouseholdKin } from './kinRoster';
import { isInactiveKinStatus } from './kinStatus';
import { logEvent } from './logger';

/**
 * #2350. A visit or KinTale that names a Kin by its household card id, put
 * back on the id every admin screen looks the Kin up by.
 *
 * A Kin lives in two places, the household's card (`families/{id}/kin/{cardId}`)
 * and the admin record (`kin/{id}`), and the two ids differ for every Kin a
 * household adds itself (`lib/kinRoster.ts#readHouseholdKin`). Every admin
 * reader (Home care flags, the KinTale composer, Auntie Time, visit detail,
 * the 411 on a visit, a Kin's own page) looks a visit's Kin up by the admin
 * record id. A visit that stored the card id showed that Kin nowhere.
 *
 * WHO STORED A CARD ID:
 *   - every visit and household request made before #2347, and the approval
 *     of such a request (fixed in `materializeKinRoster`);
 *   - a visit booked while the Kin had no admin record yet. The record comes
 *     later and the Kin's stored id moves to it: the record is minted for a
 *     card the household just added (`onFamilyKinWrite`), an office record is
 *     tied to an unlinked card by name (`adoptFlatKin`,
 *     `adoptUnlinkedFlatKinByName`), or a crossed card is given a record of its
 *     own (`healKinLink`).
 *
 * WHO WRITES: only the operator's script, `scripts/rewriteVisitKinIds.ts`,
 * after its dry run has been read. The link events above call
 * [recordVisitKinIdsAfterLink], which plans the household and logs what the
 * script would change (`kin.visitIds.planned`) and writes nothing. A trigger
 * that rewrote stored visits on its own would change history before anyone
 * read the plan.
 *
 * WHAT THE SCRIPT WRITES, and only this: `kinIds` (each card id replaced in
 * place by the Kin's stored id, a Kin then named twice kept once) and the
 * legacy single `kinId`, on `kin_care_sessions` and `kin_care_reports`. Order
 * is kept, so `kinNames` (paired by position on the admin side,
 * `visitFacts.ts`) still lines up; a dropped duplicate drops its name too
 * when the two lists are the same length. Nothing a person hears follows: the
 * visit triggers react to `status` and the calendar fields, the KinTale
 * triggers to a send, its body or its media. A sent KinTale with no care-task
 * copy yet gets one from `onKinTaleUpdate` on the write.
 *
 * NOT WRITTEN:
 *   - the household's own copies (`families/{id}/bookings/...`). No portal
 *     screen looks a Kin up by a booking's ids (they read `kinNames`), the
 *     approval maps the ids it copies (`materializeKinRoster`), and a write
 *     there would make `onBookingsWrite` tell the household its visit changed.
 *   - a document that names the card id anywhere else (a per-Kin checklist
 *     answer, a mood, a care-task copy). Moving `kinIds` alone would cut those
 *     answers off from their Kin, so the document is left as it is and listed.
 *   - a document that names a card in a CROSSED pair: two cards that claim
 *     one admin record ([crossedCardIds]). The roster reader gives the record
 *     to whichever card it reads first, while `lib/kinLink.ts` gives it to the
 *     card created first, so the record may be the other Kin's. The same holds
 *     for a live card tied to an archived or memorial record (#1912). Listed,
 *     left for after `healKinLink` has given each card a record of its own.
 *   - a card id that is also some Kin's stored id, or one no Kin of the
 *     household answers to.
 *
 * IDEMPOTENT. After one pass no document names a card id that has an alias,
 * so a second pass plans nothing. The write reads the household's Kin again
 * first and leaves the household alone if its links changed since the plan;
 * each document is then re-read in a transaction and planned again, so a
 * visit edited meanwhile is judged on what it holds then.
 */

export const VISIT_KIN_ID_COLLECTIONS = ['kin_care_sessions', 'kin_care_reports'] as const;
export type VisitKinIdCollection = (typeof VISIT_KIN_ID_COLLECTIONS)[number];

type Data = Record<string, unknown>;

export type KinIdRefusalReason = 'card-id-elsewhere' | 'crossed-link';

export type KinIdPlan =
  | { kind: 'none' }
  /**
   * `card-id-elsewhere`: the card id is named somewhere other than `kinIds` /
   * `kinId`. `crossed-link`: the document names a card that shares its admin
   * record with another card.
   */
  | { kind: 'refuse'; reason: KinIdRefusalReason; cardIds: string[] }
  | { kind: 'rewrite'; update: Data };

function stringList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter((x): x is string => typeof x === 'string');
}

function textOf(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Every string anywhere inside [v], walked without a JSON round trip. */
function collectStrings(v: unknown, into: Set<string>, depth = 0): void {
  if (depth > 12 || v === null || v === undefined) return;
  if (typeof v === 'string') {
    into.add(v);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) collectStrings(x, into, depth + 1);
    return;
  }
  if (typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Data)) {
      into.add(k);
      for (const part of k.split(/[|:]/)) into.add(part);
      collectStrings(x, into, depth + 1);
    }
  }
}

/**
 * The household cards whose admin record may not be their own. PURE.
 *
 * Two kinds: a card that shares its record with another card, and a live card
 * tied to an archived or memorial record (see below).
 *
 * Reads each card's record exactly as `readHouseholdKin` does (its
 * `legacyKinId` when that record exists, else the record whose
 * `familyKinPath` names the card, else a record under the card's own id), and
 * returns every card whose record another card also reads as its own. For
 * such a pair the roster reader keeps the record for whichever card it meets
 * first, which is not always the card `lib/kinLink.ts` says owns it, so no
 * alias from either card can be trusted until the pair is healed.
 */
export function crossedCardIds(
  kinfolkId: string,
  cards: ReadonlyArray<{ id: string; data: Data }>,
  records: ReadonlyArray<{ id: string; data: Data }>,
): Set<string> {
  const recordIds = new Set(records.map((r) => r.id));
  const recordStatus = new Map(records.map((r) => [r.id, r.data['status']]));
  const byRecord = new Map<string, string[]>();
  const crossed = new Set<string>();
  for (const card of cards) {
    const stamped = textOf(card.data['legacyKinId']);
    const pointed = records.find((r) => textOf(r.data['familyKinPath']) === `families/${kinfolkId}/kin/${card.id}`);
    const linked =
      stamped !== '' && recordIds.has(stamped) ? stamped : pointed ? pointed.id : recordIds.has(card.id) ? card.id : null;
    if (linked === null) continue;
    byRecord.set(linked, [...(byRecord.get(linked) ?? []), card.id]);
    // #1912: a live Kin tied to an archived or memorial record. `kinLink.ts`
    // reads that as crossed with no owner (`adoptedWhileHidden`): the record
    // was another Kin's of the same name. A memorial being restored looks the
    // same for a moment; holding it only lists its visits.
    if (!isInactiveKinStatus(card.data['status']) && isInactiveKinStatus(recordStatus.get(linked))) crossed.add(card.id);
  }
  for (const claimants of byRecord.values()) {
    if (claimants.length > 1) for (const id of claimants) crossed.add(id);
  }
  return crossed;
}

/** A household's card id -> stored id map, with the crossed cards taken out of it. */
export interface HouseholdKinIdMap {
  aliases: Map<string, string>;
  crossed: Set<string>;
}

/** Reads one household's Kin and works out [HouseholdKinIdMap]. Writes nothing. */
export async function readHouseholdKinIdMap(
  kinfolkId: string,
  firestore: Firestore = db(),
): Promise<HouseholdKinIdMap> {
  const [entries, cardSnap, recordSnap] = await Promise.all([
    readHouseholdKin(kinfolkId, firestore),
    firestore.collection('families').doc(kinfolkId).collection('kin').get(),
    firestore.collection('kin').where('kinfolkId', '==', kinfolkId).get(),
  ]);
  const crossed = crossedCardIds(
    kinfolkId,
    cardSnap.docs.map((d) => ({ id: d.id, data: (d.data() ?? {}) as Data })),
    recordSnap.docs.map((d) => ({ id: d.id, data: (d.data() ?? {}) as Data })),
  );
  const aliases = kinIdAliases(entries);
  for (const id of crossed) aliases.delete(id);
  return { aliases, crossed };
}

function sameMap(a: HouseholdKinIdMap, b: HouseholdKinIdMap): boolean {
  if (a.aliases.size !== b.aliases.size || a.crossed.size !== b.crossed.size) return false;
  for (const [k, v] of a.aliases) if (b.aliases.get(k) !== v) return false;
  for (const id of a.crossed) if (!b.crossed.has(id)) return false;
  return true;
}

/**
 * The decision for ONE document. PURE. [aliases] is card id -> stored id, from
 * [readHouseholdKinIdMap]; [crossed] the cards it left out because they share
 * a record.
 */
export function planVisitKinIds(
  data: Data,
  aliases: ReadonlyMap<string, string>,
  crossed: ReadonlySet<string> = new Set(),
): KinIdPlan {
  if (aliases.size === 0 && crossed.size === 0) return { kind: 'none' };
  const kinIds = stringList(data['kinIds']);
  const kinId = typeof data['kinId'] === 'string' ? data['kinId'] : null;
  const all = [...(kinIds ?? []), ...(kinId !== null ? [kinId] : [])];
  const inCrossedPair = [...new Set(all.filter((id) => crossed.has(id)))];
  if (inCrossedPair.length > 0) return { kind: 'refuse', reason: 'crossed-link', cardIds: inCrossedPair };
  const named = all.filter((id) => aliases.has(id));
  if (named.length === 0) return { kind: 'none' };

  const rest: Data = { ...data };
  delete rest['kinIds'];
  delete rest['kinId'];
  const elsewhere = new Set<string>();
  collectStrings(rest, elsewhere);
  const cutOff = [...new Set(named)].filter((id) => elsewhere.has(id));
  if (cutOff.length > 0) return { kind: 'refuse', reason: 'card-id-elsewhere', cardIds: cutOff };

  const update: Data = {};
  if (kinIds !== null && kinIds.some((id) => aliases.has(id))) {
    const mapped = kinIds.map((id) => aliases.get(id) ?? id);
    const names = stringList(data['kinNames']);
    const pairedNames = names !== null && names.length === mapped.length;
    const seen = new Set<string>();
    const nextIds: string[] = [];
    const nextNames: string[] = [];
    mapped.forEach((id, i) => {
      if (seen.has(id)) return;
      seen.add(id);
      nextIds.push(id);
      if (pairedNames) nextNames.push(names[i] as string);
    });
    update['kinIds'] = nextIds;
    if (pairedNames && nextNames.length !== names.length) update['kinNames'] = nextNames;
  }
  if (kinId !== null && aliases.has(kinId)) update['kinId'] = aliases.get(kinId) as string;
  return { kind: 'rewrite', update };
}

export interface PlannedKinIdWrite {
  collection: VisitKinIdCollection;
  docId: string;
  update: Data;
}

export interface KinIdRefusal {
  collection: VisitKinIdCollection;
  docId: string;
  cardIds: string[];
  reason: KinIdRefusalReason;
}

export interface HouseholdKinIdPlan extends HouseholdKinIdMap {
  kinfolkId: string;
  scanned: number;
  writes: PlannedKinIdWrite[];
  refusals: KinIdRefusal[];
}

/** Plans the documents of one household against [map]. PURE. */
export function planHouseholdDocs(
  kinfolkId: string,
  map: HouseholdKinIdMap,
  rows: ReadonlyArray<{ collection: VisitKinIdCollection; docId: string; data: Data }>,
): HouseholdKinIdPlan {
  const plan: HouseholdKinIdPlan = { kinfolkId, ...map, scanned: rows.length, writes: [], refusals: [] };
  for (const row of rows) {
    const decided = planVisitKinIds(row.data, map.aliases, map.crossed);
    if (decided.kind === 'rewrite') plan.writes.push({ collection: row.collection, docId: row.docId, update: decided.update });
    else if (decided.kind === 'refuse') {
      plan.refusals.push({ collection: row.collection, docId: row.docId, cardIds: decided.cardIds, reason: decided.reason });
    }
  }
  return plan;
}

/** Reads one household's Kin, visits and KinTales and plans the rewrite. Writes nothing. */
export async function planHouseholdVisitKinIds(
  kinfolkId: string,
  firestore: Firestore = db(),
): Promise<HouseholdKinIdPlan> {
  const map = await readHouseholdKinIdMap(kinfolkId, firestore);
  if (map.aliases.size === 0 && map.crossed.size === 0) return planHouseholdDocs(kinfolkId, map, []);
  const rows: Array<{ collection: VisitKinIdCollection; docId: string; data: Data }> = [];
  for (const collection of VISIT_KIN_ID_COLLECTIONS) {
    const snap = await firestore.collection(collection).where('kinfolkId', '==', kinfolkId).get();
    for (const doc of snap.docs) rows.push({ collection, docId: doc.id, data: (doc.data() ?? {}) as Data });
  }
  return planHouseholdDocs(kinfolkId, map, rows);
}

export interface KinIdApplyOutcome {
  written: number;
  /**
   * Left at write time: the document changed and needs nothing, or is refused
   * on the re-read, or the household's links changed since the plan was made.
   */
  skippedOnRecheck: number;
}

/**
 * Applies [plan]. The household's Kin are read again first: if any link
 * changed since the plan was read (a heal, a new record), nothing is written
 * for the household and the script is to be run again. Then one transaction
 * per document, each re-reading and re-planning.
 */
export async function applyHouseholdVisitKinIds(
  plan: HouseholdKinIdPlan,
  firestore: Firestore = db(),
): Promise<KinIdApplyOutcome> {
  const outcome: KinIdApplyOutcome = { written: 0, skippedOnRecheck: 0 };
  if (plan.writes.length === 0) return outcome;
  const now = await readHouseholdKinIdMap(plan.kinfolkId, firestore);
  if (!sameMap(now, plan)) {
    outcome.skippedOnRecheck = plan.writes.length;
    return outcome;
  }
  for (const w of plan.writes) {
    const ref = firestore.collection(w.collection).doc(w.docId);
    const wrote = await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const data = (snap.data() ?? {}) as Data;
      if (typeof data['kinfolkId'] !== 'string' || data['kinfolkId'] !== plan.kinfolkId) return false;
      const again = planVisitKinIds(data, now.aliases, now.crossed);
      if (again.kind !== 'rewrite') return false;
      tx.update(ref, again.update);
      return true;
    });
    if (wrote) outcome.written += 1;
    else outcome.skippedOnRecheck += 1;
  }
  return outcome;
}

/** How many document paths one `kin.visitIds.planned` line carries, so a large household stays one readable entry. */
export const PLANNED_LOG_LIMIT = 50;

/**
 * The link-event call: plans the household and logs what the script would
 * change. WRITES NOTHING. Best effort, never throws. A link that was written
 * stands whether or not this could read the household.
 */
export async function recordVisitKinIdsAfterLink(kinfolkId: string, source: string): Promise<void> {
  try {
    const plan = await planHouseholdVisitKinIds(kinfolkId);
    if (plan.writes.length === 0 && plan.refusals.length === 0) return;
    logEvent({
      severity: plan.refusals.length > 0 ? 'warn' : 'info',
      function: source,
      event: 'kin.visitIds.planned',
      extra: {
        kinfolkId,
        toWrite: plan.writes.length,
        refusedCount: plan.refusals.length,
        aliases: Object.fromEntries(plan.aliases),
        crossed: [...plan.crossed],
        docs: plan.writes.slice(0, PLANNED_LOG_LIMIT).map((w) => `${w.collection}/${w.docId}`),
        refused: plan.refusals.slice(0, PLANNED_LOG_LIMIT).map((r) => `${r.collection}/${r.docId} ${r.reason}`),
        runScript: 'backfill:visit-kin-ids',
      },
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: source,
      event: 'kin.visitIds.plan_failed',
      extra: { kinfolkId, err: (err as Error)?.message },
    });
  }
}
