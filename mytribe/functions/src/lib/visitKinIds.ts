import type { Firestore } from 'firebase-admin/firestore';
import { db } from './firestoreAdmin';
import { kinIdAliases, readHouseholdKin } from './kinRoster';
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
 *     own (`healKinLink`). Each of those calls [rewriteHouseholdVisitKinIds]
 *     for the household once the link is written.
 *
 * WHAT IS WRITTEN, and only this: `kinIds` (each card id replaced in place by
 * the Kin's stored id, a Kin then named twice kept once) and the legacy
 * single `kinId`, on `kin_care_sessions` and `kin_care_reports`. Order is
 * kept, so `kinNames` (paired by position on the admin side,
 * `visitFacts.ts`) still lines up; a dropped duplicate drops its name too
 * when the two lists are the same length. Nothing else on the document
 * changes, so no trigger on either collection sends anything: the visit
 * triggers react to `status` and the calendar fields, the KinTale triggers to
 * a send, its body or its media.
 *
 * NOT WRITTEN:
 *   - the household's own copies (`families/{id}/bookings/...`). No portal
 *     screen looks a Kin up by a booking's ids (they read `kinNames`), the
 *     approval maps the ids it copies (`materializeKinRoster`), and a write
 *     there would make `onBookingsWrite` tell the household its visit changed.
 *   - a document that names the card id anywhere else (a per-Kin checklist
 *     answer, a mood, a care-task copy). Moving `kinIds` alone would cut those
 *     answers off from their Kin, so the document is left as it is and listed.
 *   - a card id that is also some Kin's stored id, or one no Kin of the
 *     household answers to.
 *
 * IDEMPOTENT. After one pass no document names a card id that has an alias,
 * so a second pass plans nothing. Each write re-reads its document in a
 * transaction and plans again, so a visit edited meanwhile is judged on what
 * it holds then.
 */

export const VISIT_KIN_ID_COLLECTIONS = ['kin_care_sessions', 'kin_care_reports'] as const;
export type VisitKinIdCollection = (typeof VISIT_KIN_ID_COLLECTIONS)[number];

type Data = Record<string, unknown>;

export type KinIdPlan =
  | { kind: 'none' }
  /** The card id is named somewhere other than `kinIds` / `kinId`. */
  | { kind: 'refuse'; reason: 'card-id-elsewhere'; cardIds: string[] }
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

/**
 * The decision for ONE document. PURE. [aliases] is card id -> stored id, from
 * [kinIdAliases].
 */
export function planVisitKinIds(data: Data, aliases: ReadonlyMap<string, string>): KinIdPlan {
  if (aliases.size === 0) return { kind: 'none' };
  const kinIds = stringList(data['kinIds']);
  const kinId = typeof data['kinId'] === 'string' ? data['kinId'] : null;
  const named = [...(kinIds ?? []), ...(kinId !== null ? [kinId] : [])].filter((id) => aliases.has(id));
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
}

export interface HouseholdKinIdPlan {
  kinfolkId: string;
  aliases: Map<string, string>;
  scanned: number;
  writes: PlannedKinIdWrite[];
  refusals: KinIdRefusal[];
}

/** Reads one household's Kin, visits and KinTales and plans the rewrite. Writes nothing. */
export async function planHouseholdVisitKinIds(
  kinfolkId: string,
  firestore: Firestore = db(),
): Promise<HouseholdKinIdPlan> {
  const aliases = kinIdAliases(await readHouseholdKin(kinfolkId, firestore));
  const plan: HouseholdKinIdPlan = { kinfolkId, aliases, scanned: 0, writes: [], refusals: [] };
  if (aliases.size === 0) return plan;
  for (const collection of VISIT_KIN_ID_COLLECTIONS) {
    const snap = await firestore.collection(collection).where('kinfolkId', '==', kinfolkId).get();
    for (const doc of snap.docs) {
      plan.scanned += 1;
      const decided = planVisitKinIds((doc.data() ?? {}) as Data, aliases);
      if (decided.kind === 'rewrite') plan.writes.push({ collection, docId: doc.id, update: decided.update });
      else if (decided.kind === 'refuse') plan.refusals.push({ collection, docId: doc.id, cardIds: decided.cardIds });
    }
  }
  return plan;
}

export interface KinIdApplyOutcome {
  written: number;
  /** Changed between the plan and the write and found to need nothing, or refused on the re-read. */
  skippedOnRecheck: number;
}

/** Applies [plan] one transaction per document, each re-reading and re-planning. */
export async function applyHouseholdVisitKinIds(
  plan: HouseholdKinIdPlan,
  firestore: Firestore = db(),
): Promise<KinIdApplyOutcome> {
  const outcome: KinIdApplyOutcome = { written: 0, skippedOnRecheck: 0 };
  for (const w of plan.writes) {
    const ref = firestore.collection(w.collection).doc(w.docId);
    const wrote = await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const data = (snap.data() ?? {}) as Data;
      if (typeof data['kinfolkId'] !== 'string' || data['kinfolkId'] !== plan.kinfolkId) return false;
      const again = planVisitKinIds(data, plan.aliases);
      if (again.kind !== 'rewrite') return false;
      tx.update(ref, again.update);
      return true;
    });
    if (wrote) outcome.written += 1;
    else outcome.skippedOnRecheck += 1;
  }
  return outcome;
}

/**
 * Plans and applies the rewrite for one household. Called once a Kin's link
 * is written (see the header), and by `scripts/rewriteVisitKinIds.ts` for the
 * rows already stored.
 */
export async function rewriteHouseholdVisitKinIds(
  kinfolkId: string,
  firestore: Firestore = db(),
): Promise<HouseholdKinIdPlan & KinIdApplyOutcome> {
  const plan = await planHouseholdVisitKinIds(kinfolkId, firestore);
  const outcome = plan.writes.length > 0 ? await applyHouseholdVisitKinIds(plan, firestore) : { written: 0, skippedOnRecheck: 0 };
  return { ...plan, ...outcome };
}

/**
 * The trigger-side call: best effort, never throws, logs what it did. A link
 * that was written stands whether or not its visits could be moved; a failure
 * here is put right by the next link event or by the script.
 */
export async function rewriteVisitKinIdsAfterLink(kinfolkId: string, source: string): Promise<void> {
  try {
    const done = await rewriteHouseholdVisitKinIds(kinfolkId);
    if (done.writes.length === 0 && done.refusals.length === 0) return;
    logEvent({
      severity: done.refusals.length > 0 ? 'warn' : 'info',
      function: source,
      event: 'kin.visitIds.rewritten',
      extra: {
        kinfolkId,
        written: done.written,
        skippedOnRecheck: done.skippedOnRecheck,
        refused: done.refusals.map((r) => `${r.collection}/${r.docId}`),
      },
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: source,
      event: 'kin.visitIds.rewrite_failed',
      extra: { kinfolkId, err: (err as Error)?.message },
    });
  }
}
