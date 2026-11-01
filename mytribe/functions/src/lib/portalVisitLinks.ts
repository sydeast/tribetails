/**
 * #1303: what a completed visit points at, and where it happened.
 *
 * The visit detail page used to end at the visit. A household looking at a
 * completed Jul 2 walk could not get from it to the KinTale the Auntie wrote,
 * to the bill, or to the address, because the booking read model carried none
 * of them. These are the three joins, done once per `getMyBookings` call rather
 * than once per visit:
 *
 * - the ADDRESS is the household's own (a visit carries none; operator ruling
 *   2026-08-04, see `requestBooking.ts`), read off the family document with
 *   the same field priority every navigation affordance uses;
 * - the KINTALE is the SENT `kin_care_reports` row whose `sessionId` is the
 *   visit's session (drafts have no `sentAt` and never reach the household);
 * - the INVOICE is the `invoices` row whose `sessionIds`, or whose stored line
 *   items, name the visit's session. Money is billing-access only, so the
 *   caller passes whether this member has it and a member without it gets no
 *   invoice id at all.
 *
 * Every lookup is best effort. A failed read leaves that link null and never
 * fails the bookings list, which the whole portal depends on.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { pickHouseholdAddress } from './householdLocation';
export interface VisitExtras {
  /** The household's address, or null when none is on file. */
  address: string | null;
  /** sessionId -> KinTale (report) id. */
  kinTaleBySession: Map<string, string>;
  /** sessionId -> invoice id. Empty when the member has no billing access. */
  invoiceBySession: Map<string, string>;
}
export const NO_EXTRAS: VisitExtras = {
  address: null,
  kinTaleBySession: new Map(),
  invoiceBySession: new Map(),
};
/** The household address alone, for the write paths that hand a single visit back. */
export async function readHouseholdAddress(firestore: Firestore, kinfolkId: string): Promise<string | null> {
  try {
    const snap = await firestore.doc(`families/${kinfolkId}`).get();
    const addr = pickHouseholdAddress((snap.data() ?? {}) as Record<string, unknown>);
    return addr === '' ? null : addr;
  } catch {
    return null;
  }
}
/** Session ids an invoice is billed for: its `sessionIds` and any session a stored line is bound to. */
export function invoiceSessionIds(data: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const ids = data['sessionIds'];
  if (Array.isArray(ids)) for (const v of ids) if (typeof v === 'string' && v.length > 0) out.add(v);
  const lines = data['lineItems'];
  if (Array.isArray(lines)) {
    for (const l of lines) {
      const sid = (l as Record<string, unknown> | null)?.['sessionId'];
      if (typeof sid === 'string' && sid.length > 0) out.add(sid);
    }
  }
  return [...out];
}
/**
 * Loads all three joins for one household. `wantLinks` false (no completed
 * visit carries a session) skips the two collection reads entirely.
 */
export async function loadVisitExtras(
  firestore: Firestore,
  kinfolkId: string,
  opts: { wantLinks: boolean; billingAccess: boolean },
): Promise<VisitExtras> {
  const [address, kinTaleBySession, invoiceBySession] = await Promise.all([
    readHouseholdAddress(firestore, kinfolkId),
    opts.wantLinks ? readKinTales(firestore, kinfolkId) : Promise.resolve(new Map<string, string>()),
    opts.wantLinks && opts.billingAccess ? readInvoices(firestore, kinfolkId) : Promise.resolve(new Map<string, string>()),
  ]);
  return { address, kinTaleBySession, invoiceBySession };
}
async function readKinTales(firestore: Firestore, kinfolkId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const snap = await firestore
      .collection('kin_care_reports')
      .where('kinfolkId', '==', kinfolkId)
      .where('sentAt', '>', '')
      .get();
    for (const d of snap.docs) {
      const sid = (d.data() as Record<string, unknown>)['sessionId'];
      if (typeof sid === 'string' && sid.length > 0 && !out.has(sid)) out.set(sid, d.id);
    }
  } catch {
    /* best effort: no link */
  }
  return out;
}
async function readInvoices(firestore: Firestore, kinfolkId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const snap = await firestore.collection('invoices').where('kinfolkId', '==', kinfolkId).get();
    for (const d of snap.docs) {
      for (const sid of invoiceSessionIds(d.data() as Record<string, unknown>)) {
        if (!out.has(sid)) out.set(sid, d.id);
      }
    }
  } catch {
    /* best effort: no link */
  }
  return out;
}
