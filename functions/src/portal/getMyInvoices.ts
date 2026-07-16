import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

interface GetMyInvoicesRequest {
  kinfolkId?: string;
}

type Status = 'draft' | 'open' | 'paid' | 'credit' | 'cancelled';

export interface InvoiceLineItemDto {
  sessionId: string;
  /** Service type of the visit, e.g. "30Minute". */
  label: string;
  /** Session start (ISO string) or its date field; null when the session carries neither. */
  dateIso: string | null;
  amountCents: number | null;
}

interface InvoiceDto {
  id: string;
  kinfolkId: string;
  kinfolkName: string | null;
  client: string | null;
  total: number;
  amountDue: number;
  isPaid: boolean;
  status: Status;
  date: string | null;
  dueDate: string | null;
  discount: string | null;
  terms: string | null;
  paymentsHistory: string | null;
  address: string | null;
  viewed: boolean;
  // Credit-specific (only meaningful when status === 'credit')
  creditAmountCents: number | null;
  creditTarget: 'accountBalance' | 'originalPaymentMethod' | null;
  creditRedeemedAtMs: number | null;
  originalPaymentIntentId: string | null;
  /**
   * Per-visit line items resolved from the invoice's `sessionIds` (AuntieOS
   * `kin_care_sessions` docs). OPTIONAL: absent when the invoice carries no
   * sessionIds or when the session lookups fail — never fails the whole call.
   */
  lineItems?: InvoiceLineItemDto[];
}

interface GetMyInvoicesResult {
  open: InvoiceDto[];
  paid: InvoiceDto[];
  credits: InvoiceDto[];
  accountBalanceCents: number;
}

/**
 * Returns the signed-in kinfolk's invoices, split into three buckets.
 *
 * Status resolution (precedence):
 *   1. explicit `invoiceStatus` field set by AuntieOS, canonical
 *   2. fallback heuristic from amountDue / total:
 *        amountDue > 0           → open
 *        amountDue == 0 + total > 0 (no draft tag) → paid
 *        amountDue < 0 OR total < 0 → credit
 *        amountDue + total both missing → open (draft-like)
 *
 * Buckets:
 *   open   , payable now (also includes draft)
 *   paid   , fully settled
 *   credits, refunds awaiting redemption (Save to Account Balance OR Return to OPM)
 *
 * Account balance is a family-scoped flat field at `families/{kinfolkId}.accountBalanceCents`.
 */
export async function getMyInvoicesHandler(
  req: CallableRequest<GetMyInvoicesRequest>,
): Promise<GetMyInvoicesResult> {
  initSentry();

  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const firestore = db();
  const { kinfolkId } = await resolveKinfolkAccess(uid, req.data?.kinfolkId, req.auth?.token?.admin === true, 'getMyInvoices');

  const [invoiceSnap, familySnap] = await Promise.all([
    firestore.collection('invoices').where('kinfolkId', '==', kinfolkId).get(),
    firestore.collection('families').doc(kinfolkId).get(),
  ]);

  const accountBalanceCents = numericFrom(familySnap.data()?.accountBalanceCents);

  const sessionIdsByInvoice = new Map<string, string[]>();

  const all: InvoiceDto[] = invoiceSnap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    const sessionIds = sessionIdsFrom(data);
    if (sessionIds.length > 0) sessionIdsByInvoice.set(d.id, sessionIds);
    const amountDuePresent = data['amountDue'] != null;
    const totalPresent = data['total'] != null;
    const amountDue = numericFrom(data['amountDue']);
    const total = numericFrom(data['total']);
    const status: Status = resolveStatus(data['invoiceStatus'], amountDuePresent, totalPresent, amountDue, total);
    const isPaid = status === 'paid';
    const isCredit = status === 'credit';
    return {
      id: d.id,
      kinfolkId,
      kinfolkName: stringOrNull(data['kinfolkName']),
      client: stringOrNull(data['client']),
      total,
      amountDue,
      isPaid,
      status,
      date: stringOrNull(data['date']),
      dueDate: stringOrNull(data['dueDate']),
      discount: stringOrNull(data['discount']),
      terms: stringOrNull(data['terms']),
      paymentsHistory: stringOrNull(data['paymentsHistory']),
      address: stringOrNull(data['address']),
      viewed: boolFrom(data['viewed']),
      creditAmountCents: isCredit ? Math.round(Math.abs(amountDue !== 0 ? amountDue : total) * 100) : null,
      creditTarget: isCredit
        ? (data['creditTarget'] === 'accountBalance' || data['creditTarget'] === 'originalPaymentMethod'
            ? (data['creditTarget'] as 'accountBalance' | 'originalPaymentMethod')
            : null)
        : null,
      creditRedeemedAtMs: isCredit ? tsMillis(data['creditRedeemedAt']) : null,
      originalPaymentIntentId: stringOrNull(data['originalPaymentIntentId']),
    };
  });

  // Resolve visit line items from kin_care_sessions. Best-effort: a lookup
  // failure returns the invoices WITHOUT lineItems rather than failing the call.
  if (sessionIdsByInvoice.size > 0) {
    try {
      const uniqueIds = [...new Set([...sessionIdsByInvoice.values()].flat())];
      const refs = uniqueIds.map((id) => firestore.collection('kin_care_sessions').doc(id));
      const snaps = await firestore.getAll(...refs);
      const sessionDataById = new Map<string, Record<string, unknown>>();
      snaps.forEach((s, i) => {
        const data = s.exists ? (s.data() as Record<string, unknown>) : null;
        if (data) sessionDataById.set(uniqueIds[i], data);
      });
      const invoiceById = new Map(all.map((i) => [i.id, i]));
      for (const [invoiceId, sessionIds] of sessionIdsByInvoice) {
        const invoice = invoiceById.get(invoiceId);
        if (!invoice) continue;
        const lineItems = sessionIds
          .filter((id) => sessionDataById.has(id))
          .map((id) => mapSessionToLineItem(id, sessionDataById.get(id)!));
        if (lineItems.length > 0) invoice.lineItems = lineItems;
      }
    } catch (err) {
      logEvent({
        severity: 'warn',
        function: 'getMyInvoices',
        event: 'portal.invoices.lineItems.failed',
        uid,
        errorMessage: (err as Error)?.message,
        extra: { kinfolkId, invoiceCount: sessionIdsByInvoice.size },
      });
    }
  }

  const open = all
    .filter((i) => i.status === 'open' || i.status === 'draft')
    .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''));
  const paid = all
    .filter((i) => i.status === 'paid')
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  const credits = all
    .filter((i) => i.status === 'credit')
    .sort((a, b) => (b.creditRedeemedAtMs ?? 0) - (a.creditRedeemedAtMs ?? 0));

  logEvent({
    severity: 'info',
    function: 'getMyInvoices',
    event: 'portal.invoices.resolved',
    uid,
    extra: { kinfolkId, openCount: open.length, paidCount: paid.length, creditCount: credits.length },
  });

  return { open, paid, credits, accountBalanceCents };
}

function resolveStatus(
  raw: unknown,
  amountDuePresent: boolean,
  totalPresent: boolean,
  amountDue: number,
  total: number,
): Status {
  if (typeof raw === 'string') {
    const s = raw.toLowerCase();
    if (s === 'paid' || s === 'open' || s === 'draft' || s === 'credit' || s === 'cancelled') {
      return s;
    }
  }
  if (amountDue < 0 || total < 0) return 'credit';
  if (amountDuePresent && amountDue > 0) return 'open';
  if (amountDuePresent && amountDue === 0 && totalPresent && total > 0) return 'paid';
  return 'open'; // missing-amountDue (draft-like) routes to open per Admin note.
}

/** Max sessions resolved per invoice; anything past the cap is dropped. */
export const MAX_LINE_ITEM_SESSIONS = 50;

/** Extracts a capped, string-only `sessionIds` list from a flat invoice doc. */
export function sessionIdsFrom(data: Record<string, unknown>): string[] {
  const raw = data['sessionIds'];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .slice(0, MAX_LINE_ITEM_SESSIONS);
}

/**
 * Maps a kin_care_sessions doc to an invoice line item. AuntieOS session shape:
 * `serviceType` (older docs: `type`), `startTime` as ISO string (older: `date`),
 * and a dollars-denominated `rate` (older: `price`/`amount`).
 */
export function mapSessionToLineItem(sessionId: string, data: Record<string, unknown>): InvoiceLineItemDto {
  const label = stringOrNull(data['serviceType']) ?? stringOrNull(data['type']) ?? 'Service';
  const dateIso = stringOrNull(data['startTime']) ?? stringOrNull(data['date']);
  const dollars = numericOrNull(data['rate']) ?? numericOrNull(data['price']) ?? numericOrNull(data['amount']);
  const amountCents = dollars != null ? Math.round(dollars * 100) : null;
  return { sessionId, label, dateIso, amountCents };
}

function numericOrNull(v: unknown): number | null {
  if (typeof v === 'number' && !isNaN(v) && isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  }
  return null;
}

function numericFrom(v: unknown): number {
  if (typeof v === 'number' && !isNaN(v) && isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function boolFrom(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() === 'yes' || v.toLowerCase() === 'true';
  return false;
}

function tsMillis(v: unknown): number | null {
  if (v && typeof (v as { toMillis?: () => number }).toMillis === 'function') {
    return (v as { toMillis(): number }).toMillis();
  }
  if (typeof v === 'number') return v;
  return null;
}

export const getMyInvoices = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('getMyInvoices', getMyInvoicesHandler),
);
