import type { Firestore } from 'firebase-admin/firestore';
import { db } from './firestoreAdmin';
import { kinIdAliases, readHouseholdKinLinks } from './kinRoster';
import { logEvent } from './logger';

/** Lives with the roster reader it mirrors; re-exported for the script and the tests. */
export { crossedCardIds } from './kinRoster';

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
 * place by the Kin's stored id) and the legacy single `kinId`, on
 * `kin_care_sessions` and `kin_care_reports`. Order is kept, so `kinNames`
 * (paired by position on the admin side, `visitFacts.ts`) still lines up. The
 * same id listed twice is kept once, with its paired name. Nothing a person
 * hears follows: the visit triggers react to `status` and the calendar fields, the KinTale
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
 *   - a document where two different ids would become one record (a card id
 *     beside its own record id, or two cards mapped to one record). It may
 *     be two Kin booked while a crossed pair was open (#2530), and merging
 *     them would drop one from the visit. Listed and left.
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

export type KinIdRefusalReason = 'card-id-elsewhere' | 'crossed-link' | 'two-ids-one-record';

export type KinIdPlan =
  | { kind: 'none' }
  /**
   * `card-id-elsewhere`: the card id is named somewhere other than `kinIds` /
   * `kinId`. `crossed-link`: the document names a card whose admin record may
   * be another Kin's ([crossedCardIds]). `two-ids-one-record`: two different
   * ids on it would become the same record.
   */
  | { kind: 'refuse'; reason: KinIdRefusalReason; cardIds: string[] }
  | { kind: 'rewrite'; update: Data };

function stringList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter((x): x is string => typeof x === 'string');
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

/** A household's card id -> stored id map, with the crossed cards taken out of it. */
export interface HouseholdKinIdMap {
  aliases: Map<string, string>;
  crossed: Set<string>;
}

/** Reads one household's Kin, in one read, and works out [HouseholdKinIdMap]. Writes nothing. */
export async function readHouseholdKinIdMap(
  kinfolkId: string,
  firestore: Firestore = db(),
): Promise<HouseholdKinIdMap> {
  const { entries, crossed } = await readHouseholdKinLinks(kinfolkId, firestore);
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
    // Two different ids that would become one record: a card id and the
    // record it maps to, or two cards mapped to one record. That is one Kin
    // named twice, or two Kin booked while a crossed pair gave the newer one
    // the older one's record (#2530) and healed since. The ids cannot tell
    // the two apart, and the names cannot either (a crossing happened by
    // name), so merging could drop a Kin from the visit for good.
    const firstFrom = new Map<string, string>();
    const merging = new Set<string>();
    kinIds.forEach((from, i) => {
      const to = mapped[i] as string;
      const earlier = firstFrom.get(to);
      if (earlier === undefined) firstFrom.set(to, from);
      else if (earlier !== from) for (const id of [earlier, from]) if (aliases.has(id)) merging.add(id);
    });
    if (merging.size > 0) return { kind: 'refuse', reason: 'two-ids-one-record', cardIds: [...merging] };
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
