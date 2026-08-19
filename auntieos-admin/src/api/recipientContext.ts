import { doc, getDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { call } from '../lib/fns';
import { str } from '../lib/coerce';
import type { CollectionSpec } from '../lib/firestore';
import type { CommsChannel } from '../lib/recipientContext';

/**
 * The read surface behind the recipient context panel: each kinfolk's dossier,
 * the household's own bank, each pet's 411, and the four communication logs.
 *
 * ── EVERYTHING HERE IS ADMIN-READABLE DIRECTLY ──────────────────────────────
 * `dossiers`, `household_bank`, `the_411`, `sms_messages`, `emails`, `calls_log`
 * and `voicemails` are all `allow read: if isAuntie()` in firestore.rules, so no
 * callable is needed to read them. The one callable in this module,
 * `recap_recent_comms`, exists for a different reason: it summarizes with
 * Claude, and the Anthropic key cannot live in a browser.
 *
 * All three reconciled records are ADMIN-ONLY, a standing operator ruling.
 * Kinfolk never see a dossier, a 411, or a bank, and no portal callable projects
 * a field off any of them.
 */

// ── dossier ─────────────────────────────────────────────────────────────────

/**
 * The household dossier the reconciler maintains, narrowed to what the panel
 * renders. Every field is read through `str`: this is a cast over Firestore
 * data, not a validation of it, and a legacy doc missing `tldr` must not throw
 * inside a render.
 */
export interface Dossier {
  tldr: string;
  rawSummary: string;
  communicationStyle: string;
  householdNotes: string;
  relationshipWithAuntie: string;
}

/**
 * Point-read by document id, not a `where('kinfolkId','==',id)` query.
 *
 * The reconciler writes new dossiers at a deterministic id equal to the
 * kinfolkId (`upsert_dossier`), and `api/householdData.ts` already made and
 * documented this same call for the same collection. A collection query would
 * also be denied for a sandbox test admin, whose rule branch is keyed on the
 * DOC ID matching their tribe, which a query cannot prove.
 *
 * A missing dossier returns null. That is a household nobody has reconciled
 * yet, which is a normal state and not an error.
 */
export async function getDossier(kinfolkId: string): Promise<Dossier | null> {
  const id = kinfolkId.trim();
  if (id === '') return null;
  const snap = await getDoc(doc(db, 'dossiers', id));
  if (!snap.exists()) return null;
  const d = snap.data() as Record<string, unknown>;
  return {
    tldr: str(d['tldr']),
    rawSummary: str(d['rawSummary']),
    communicationStyle: str(d['communicationStyle']),
    householdNotes: str(d['householdNotes']),
    relationshipWithAuntie: str(d['relationshipWithAuntie']),
  };
}

// ── the household bank ──────────────────────────────────────────────────────

/**
 * The household's own reconciled record (issue #461), narrowed to what the panel
 * renders. The peer of the dossier above and the 411 below: same rawSummary,
 * same regenerated `tldr`, same `str`-defensive read for the same reason.
 *
 * Its five structured fields are DISJOINT from the dossier's and the 411's on
 * purpose. A dossier holds one person, a 411 holds one animal, and the bank
 * holds what is true of the home itself and of neither of them.
 */
export interface HouseholdBank {
  tldr: string;
  rawSummary: string;
  accessAndEntry: string;
  propertyNotes: string;
  householdRoutine: string;
  standingInstructions: string;
  schedulingNotes: string;
}

/**
 * Point-read at `household_bank/{householdId}`, the deterministic id
 * `upsert_household_bank` writes, where the household id is the anchoring
 * kinfolk id.
 *
 * Same call shape as `getDossier` and for all the same reasons, the sandbox one
 * included: `firestore.rules` scopes a test admin's read of this collection by
 * the DOC ID matching their tribe, which a collection query cannot prove.
 *
 * A missing bank returns null. That is a household nothing household-targeted
 * has been written about yet, which is normal and not an error.
 */
export async function getHouseholdBank(householdId: string): Promise<HouseholdBank | null> {
  const id = householdId.trim();
  if (id === '') return null;
  const snap = await getDoc(doc(db, 'household_bank', id));
  if (!snap.exists()) return null;
  const d = snap.data() as Record<string, unknown>;
  return {
    tldr: str(d['tldr']),
    rawSummary: str(d['rawSummary']),
    accessAndEntry: str(d['accessAndEntry']),
    propertyNotes: str(d['propertyNotes']),
    householdRoutine: str(d['householdRoutine']),
    standingInstructions: str(d['standingInstructions']),
    schedulingNotes: str(d['schedulingNotes']),
  };
}

// ── the 411 ─────────────────────────────────────────────────────────────────

/** One pet's 411, narrowed to what a kin card renders. */
export interface Kin411 {
  tldr: string;
  rawSummary: string;
  breed: string;
  personality: string;
  quirksAndPreferences: string;
  medicalNotes: string;
  dietaryDetails: string;
}

/**
 * Point-read at `the_411/411_{kinId}`, the deterministic id `upsert_kin411`
 * writes. Fetched lazily, only when a kin card is expanded: a household with
 * six pets should not cost six reads to render a collapsed list, and the
 * archive's own KinCard owned its 411 subscription for the same reason.
 */
export async function getKin411(kinId: string): Promise<Kin411 | null> {
  const id = kinId.trim();
  if (id === '') return null;
  const snap = await getDoc(doc(db, 'the_411', `411_${id}`));
  if (!snap.exists()) return null;
  const d = snap.data() as Record<string, unknown>;
  return {
    tldr: str(d['tldr']),
    rawSummary: str(d['rawSummary']),
    breed: str(d['breed']),
    personality: str(d['personality']),
    quirksAndPreferences: str(d['quirksAndPreferences']),
    medicalNotes: str(d['medicalNotes']),
    dietaryDetails: str(d['dietaryDetails']),
  };
}

// ── the four comms logs ─────────────────────────────────────────────────────

/**
 * Rows fetched per channel per household. Generous for one household's whole
 * history in one channel, and the same ceiling every other list in this app
 * uses. Documented rather than assumed: a household somehow past this in one
 * channel would have its oldest rows read and could miss the newest, since the
 * order below is by document id rather than by time. That is the price of not
 * requiring a composite index (see `commsQueries`), and it is the same trade the
 * Python recap backend makes deliberately.
 */
export const COMMS_MAX = 500;

/** Matches no document, ever. Used instead of dropping the filter for a blank id. */
const NO_RECIPIENT_SENTINEL = '__context-no-recipient-selected__';

export interface CommsQuery {
  channel: CommsChannel;
  spec: CollectionSpec;
}

/**
 * One bounded, server-filtered query per channel.
 *
 * ── WHY orderBy(__name__) AND NOT orderBy(timestamp) ────────────────────────
 * The panel wants the newest message, so `where('kinfolkId','==',id)` plus
 * `orderBy('timestamp','desc')` is the natural query. It also needs a composite
 * index on every one of these four collections, and none is deployed
 * (firestore.indexes.json has none for any of them). That query would fail
 * `failed-precondition` at runtime until somebody deployed four indexes, so the
 * panel would ship red.
 *
 * An equality filter plus `orderBy(__name__)` is served by the automatic
 * single-field index Firestore maintains, needs nothing deployed, and is still
 * bounded and still scoped to one household. The rows are then sorted by their
 * ISO `timestamp` in memory, which is exactly what `collect_recent_comms` in
 * reconcile_comms.py does, and for the same stated reason.
 *
 * The archive did something worse than either: it subscribed to all four
 * collections UNFILTERED, for every household at once, and filtered in the
 * client. That is the unbounded-listener pattern `lib/firestore.ts` exists to
 * make inexpressible.
 *
 * A blank recipient id resolves to a sentinel rather than dropping the filter,
 * because a dropped filter is a whole-collection read wearing a `max`.
 */
export function commsQueries(kinfolkId: string): CommsQuery[] {
  const id = kinfolkId.trim() === '' ? NO_RECIPIENT_SENTINEL : kinfolkId.trim();
  const spec = (path: string): CollectionSpec => ({
    path,
    filters: [['kinfolkId', '==', id]],
    order: ['__name__', 'asc'],
    max: COMMS_MAX,
  });
  return [
    { channel: 'sms', spec: spec('sms_messages') },
    { channel: 'email', spec: spec('emails') },
    { channel: 'call', spec: spec('calls_log') },
    { channel: 'voicemail', spec: spec('voicemails') },
  ];
}

// ── the AI recap ────────────────────────────────────────────────────────────

export interface CommsRecap {
  /** Blank when the household has nothing recent to summarize. Never an error. */
  recap: string;
  /** ISO timestamp of the newest source row the recap drew on. */
  lastAt: string;
  sourceCount: number;
}

/**
 * `recap_recent_comms`, an admin-gated Python callable in the `reconcile`
 * codebase (functions-python/main.py). It reads up to fifteen recent rows across
 * the same four collections and asks Claude for one or two sentences.
 *
 * Gated in the UI by `auntieos.communicate.commsRecap`, which is OFF by default.
 * A failure is never swallowed: the panel discloses it and falls back to the raw
 * latest message, which is a weaker answer but a true one.
 */
export async function recapRecentComms(kinfolkId: string): Promise<CommsRecap> {
  const res = await call<{ kinfolkId: string }, Partial<CommsRecap>>('recap_recent_comms', {
    kinfolkId: kinfolkId.trim(),
  });
  return {
    recap: str(res.recap),
    lastAt: str(res.lastAt),
    sourceCount: typeof res.sourceCount === 'number' ? res.sourceCount : 0,
  };
}
