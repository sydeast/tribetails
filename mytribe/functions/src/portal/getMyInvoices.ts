import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { INVOICE_STATES, type InvoiceState, type InvoiceEditScope } from '../lib/invoiceEditPolicy';

interface GetMyInvoicesRequest {
  kinfolkId?: string;
}

/**
 * The stored Invoice State Stamp's vocabulary (ADR-0002), all eight states.
 * This callable used to keep its own 5-state `resolveStatus` with a money
 * fallback; that classifier is retired. The doc's stamped `status` is the
 * truth and this handler only READS it — see `statusFromStamp`.
 */
type Status = InvoiceState;

export interface InvoiceLineItemDto {
  /**
   * Stable key for one row, unique within an invoice. NOT the session id: a
   * stored line has no session behind it, so keying on `sessionId` would collapse
   * every stored row onto one empty key in the household's table.
   */
  lineId: string;
  /**
   * Where the row came from, so nothing downstream has to guess.
   *
   *   stored   the invoice's OWN `lineItems`, which is what the operator billed
   *   session  derived from `sessionIds`, for a legacy invoice carrying no lines
   */
  source: 'stored' | 'session';
  /** The session behind a derived row. Empty on a stored line. */
  sessionId: string;
  /** The billed description, or the visit's service type on a derived row. */
  label: string;
  /** Visit date on a derived row. Null on a stored line, which carries no date. */
  dateIso: string | null;
  amountCents: number | null;
  /** Stored lines only, so a household sees 3 x $20 rather than an unexplained $60. */
  qty: number | null;
  unitCents: number | null;
}

interface InvoiceDto {
  id: string;
  kinfolkId: string;
  kinfolkName: string | null;
  client: string | null;
  total: number;
  amountDue: number;
  isPaid: boolean;
  /**
   * The stored Invoice State Stamp (ADR-0002): one of the eight lowercase
   * `INVOICE_STATES`, persisted by every money-touching callable in the same
   * write that moves the money and backfilled across every pre-stamp doc.
   * READ off the doc, never re-derived here. See the bucket table on the
   * handler for how the eight states land in open/paid/credits.
   */
  status: Status;
  /**
   * The stamp's second half: how much of this invoice may still change
   * (`all` | `metadataOnly` | `none`). Null when the doc carries no stored
   * scope (pre-backfill sandbox seeds); the portal offers no edit UI, so this
   * ships for parity with the stamp, not because a screen branches on it yet.
   */
  editScope: InvoiceEditScope | null;
  /**
   * What has been collected against this invoice, in cents, read from the
   * `paidCents` field the payment path writes.
   *
   * NOT re-derived from `total - amountDue`. Those are float dollars, and on
   * every invoice touched by the pre-2026-07-25 partial-payment write
   * `amountDue` reads 0 while a real balance is owed, so that subtraction would
   * report the entire total as collected on exactly the invoices that are
   * wrong. 0 on an invoice that predates the field, which is honest rather than
   * flattering: the portal does not claim a payment it has no record of.
   */
  paidCents: number;
  /**
   * Money has come in and it does NOT cover this invoice.
   *
   * A part-paid invoice is neither paid nor untouched, and rendering it as
   * either is a lie to the household: "unpaid" hides the $20 they already sent,
   * "paid" hides the $20 they still owe. `status` stays `open` so the invoice
   * keeps its payable behaviour and its bucket; this is the flag that lets the
   * screen say what is actually true about it.
   */
  partiallyPaid: boolean;
  date: string | null;
  dueDate: string | null;
  discount: string | null;
  terms: string | null;
  paymentsHistory: string | null;
  address: string | null;
  viewed: boolean;
  // Credit-specific (only meaningful when status is 'credit' or 'redeemed' —
  // 'redeemed' is what the stamp writes once `creditRedeemedAt` is set).
  // Account balance is the only redemption target: credits are NOT refundable.
  creditAmountCents: number | null;
  creditTarget: 'accountBalance' | null;
  creditRedeemedAtMs: number | null;
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
 * STATUS IS THE STORED STAMP, NOT A CLASSIFICATION. Every server-side invoice
 * writer persists the Invoice State Classifier's output (`status` +
 * `editScope`, ADR-0002) in the same write that moves the money, and a
 * one-shot backfill stamped every doc that predated it. This handler READS
 * that field; the 5-state `resolveStatus` money heuristic that used to live
 * here is retired (per CONTEXT.md: clients render the persisted state and
 * never classify — and this response builder is the portal's classifier of
 * record, so the same rule lands here).
 *
 * How the eight stamped states land in the three buckets:
 *
 *   open      → open     a real balance is owed, payable
 *   draft     → open     visible, not payable (unchanged: "Not sent yet")
 *   quote     → open     a PROPOSAL, not yet money owed. Previously the
 *                        5-state fallback misread quotes as `open`, which put
 *                        a Pay button on an unaccepted quote. It stays in the
 *                        open bucket so the household still sees it, but it
 *                        ships as `quote` so no client renders it payable
 *                        (the admin's rule: "a quote is not a bill").
 *   zero      → open     a genuinely $0 invoice. Nothing owed, but calling it
 *                        paid would claim a payment that never happened; it
 *                        keeps its previous open-bucket placement, non-payable
 *                        by money (amountDue is 0).
 *   paid      → paid     settled
 *   credit    → credits  owed TO the household, awaiting redemption
 *   redeemed  → credits  a SPENT credit. The stamp writes `redeemed` once
 *                        `creditRedeemedAt` is set (previously the money
 *                        fallback re-read these as `credit` and the clients
 *                        re-derived redemption from `creditRedeemedAtMs`).
 *                        Stays beside its unredeemed siblings, where every
 *                        client already renders it.
 *   cancelled → (none)   withdrawn; excluded from all three buckets, exactly
 *                        as the 5-state code excluded it. The household is
 *                        not shown a bill that no longer stands.
 *
 * An invoice with NO readable stamp (impossible post-backfill) fail-softs to
 * the raw stored status string lowercased — and to `open` when even that is
 * unreadable — NEVER to a money heuristic; see `statusFromStamp`. Such docs
 * are logged at warn so a stamping gap surfaces in monitoring instead of as a
 * silent re-classification.
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
  const unstampedIds: string[] = [];

  const all: InvoiceDto[] = invoiceSnap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    // THE INVOICE'S OWN LINES WIN. Until 2026-07-25 this callable ignored the
    // stored `lineItems` entirely and rebuilt a list from `sessionIds`, so an
    // itemized invoice showed the household a DIFFERENT set of rows from the one
    // the operator billed, with amounts read off the session (usually absent, so
    // usually blank). A bill that disagrees with itself is worse than a bill with
    // no breakdown at all, and the household is the party least able to tell
    // which figure to believe.
    const storedLines = storedLineItemsFrom(data['lineItems']);
    const sessionIds = sessionIdsFrom(data);
    // The session lookup is a FALLBACK, not a supplement. It runs only for an
    // invoice with no stored lines (every invoice predating the line-item
    // editor), and the two lists are never mixed: they answer different
    // questions and their amounts come from different places.
    if (storedLines.length === 0 && sessionIds.length > 0) sessionIdsByInvoice.set(d.id, sessionIds);
    const amountDue = numericFrom(data['amountDue']);
    const total = numericFrom(data['total']);
    const stamped = statusFromStamp(data);
    if (!stamped.stamped) unstampedIds.push(d.id);
    const status = stamped.status;
    const isPaid = status === 'paid';
    // The whole credit family: `redeemed` is what the stamp writes once
    // `creditRedeemedAt` is set, and a redeemed credit still carries every
    // credit field a client renders (amount, target, redemption time).
    const isCredit = status === 'credit' || status === 'redeemed';
    // Integer cents off the doc, never a subtraction of two floats. See the
    // InvoiceDto field note for why that subtraction is specifically unsafe on
    // the invoices this exists to describe.
    const paidCents = integerCentsFrom(data['paidCents']);
    const partiallyPaid = !isCredit && !isPaid && paidCents > 0 && amountDue > 0;
    return {
      id: d.id,
      kinfolkId,
      kinfolkName: stringOrNull(data['kinfolkName']),
      client: stringOrNull(data['client']),
      total,
      amountDue,
      isPaid,
      status,
      editScope: editScopeFrom(data['editScope']),
      paidCents,
      partiallyPaid,
      date: stringOrNull(data['date']),
      dueDate: stringOrNull(data['dueDate']),
      discount: stringOrNull(data['discount']),
      terms: stringOrNull(data['terms']),
      paymentsHistory: stringOrNull(data['paymentsHistory']),
      address: stringOrNull(data['address']),
      viewed: boolFrom(data['viewed']),
      creditAmountCents: isCredit ? Math.round(Math.abs(amountDue !== 0 ? amountDue : total) * 100) : null,
      creditTarget: isCredit && data['creditTarget'] === 'accountBalance' ? 'accountBalance' : null,
      creditRedeemedAtMs: isCredit ? tsMillis(data['creditRedeemedAt']) : null,
      // Set here when the invoice has its own lines. The session pass below then
      // skips this invoice entirely and cannot overwrite them.
      ...(storedLines.length > 0 ? { lineItems: storedLines.map(mapStoredLineItem) } : {}),
    };
  });

  // FALLBACK ONLY, for invoices with no stored lines. Best-effort: a lookup
  // failure returns those invoices WITHOUT lineItems rather than failing the call.
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

  // The 8→3 bucket map, decided FROM the stored status alone. See the handler
  // doc comment for the per-state reasoning; `cancelled` lands in no bucket.
  const open = all
    .filter((i) => i.status === 'open' || i.status === 'draft' || i.status === 'quote' || i.status === 'zero')
    .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''));
  const paid = all
    .filter((i) => i.status === 'paid')
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  const credits = all
    .filter((i) => i.status === 'credit' || i.status === 'redeemed')
    .sort((a, b) => (b.creditRedeemedAtMs ?? 0) - (a.creditRedeemedAtMs ?? 0));

  // Post-backfill this should never fire: every server writer stamps and the
  // backfill covered the rest. One aggregated warning per call, not one per
  // doc, so a legacy seed with many rows is one alert rather than a flood.
  if (unstampedIds.length > 0) {
    logEvent({
      severity: 'warn',
      function: 'getMyInvoices',
      event: 'portal.invoices.stampMissing',
      uid,
      extra: { kinfolkId, count: unstampedIds.length, invoiceIds: unstampedIds.slice(0, 20) },
    });
  }

  logEvent({
    severity: 'info',
    function: 'getMyInvoices',
    event: 'portal.invoices.resolved',
    uid,
    extra: { kinfolkId, openCount: open.length, paidCount: paid.length, creditCount: credits.length },
  });

  return { open, paid, credits, accountBalanceCents };
}

function isInvoiceState(s: string): s is Status {
  return (INVOICE_STATES as readonly string[]).includes(s);
}

/**
 * Reads the stored state stamp off a raw invoice doc. `stamped: false` means
 * the doc carried no readable stamp, which the caller reports to monitoring.
 *
 * `status` is the canonical field (every server writer stamps it, ADR-0002,
 * and the backfill covered every doc that predated the stamp); `invoiceStatus`
 * is the legacy spelling the sandbox seeds still write, kept as a read
 * fallback so a seeded sandbox renders rather than warns on every row.
 *
 * FAIL-SOFT IS STRING-ONLY, NEVER MONEY. A doc whose stored string is not one
 * of the eight states (or is absent entirely) routes to `open` — the same
 * terminal default the retired 5-state classifier used for a doc it could not
 * place, chosen because it keeps the invoice VISIBLE (a dropped invoice is
 * money a household cannot pay) while every payment affordance stays gated on
 * `amountDue` client-side and re-validated by `payInvoice` server-side. What
 * this deliberately does NOT do is re-derive a state from amountDue/total:
 * the classifier lives in `lib/invoiceEditPolicy.ts` and runs at write time;
 * a read-side re-derivation is exactly the divergence ADR-0002 retired.
 */
export function statusFromStamp(data: Record<string, unknown>): { status: Status; stamped: boolean } {
  const raw = data['status'] ?? data['invoiceStatus'];
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (isInvoiceState(s)) return { status: s, stamped: true };
  return { status: 'open', stamped: false };
}

/** The stamp's stored edit scope, or null when the doc carries none. */
function editScopeFrom(raw: unknown): InvoiceEditScope | null {
  return raw === 'all' || raw === 'metadataOnly' || raw === 'none' ? raw : null;
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
  // Keyed by the session, which is unique within an invoice by construction:
  // `sessionIdsFrom` reads one array and the caller filters it to found docs.
  return {
    lineId: `session:${sessionId}`,
    source: 'session',
    sessionId,
    label,
    dateIso,
    amountCents,
    qty: null,
    unitCents: null,
  };
}

/** One stored line as it sits on the invoice doc, after validation. */
export interface StoredLineItem {
  description: string;
  qty: number;
  unitCents: number;
  discountCents: number;
}

/**
 * The invoice's OWN line items, read defensively.
 *
 * `firestore.rules` grants `allow update: if isAuntie()` over the whole invoice
 * collection and `postInvoiceEvent` merges an arbitrary payload, so neither the
 * presence nor the shape of this array is guaranteed by the callables that
 * normally write it. A malformed entry is DROPPED rather than rendered as a
 * zero-priced row: telling a household it was billed $0.00 for something is a
 * different lie from showing them one fewer row, and the invoice total shown
 * beside the table comes from the doc, not from this sum, so a dropped row is
 * visible as a table that does not add up rather than as a silently wrong bill.
 *
 * Bounded by the same cap the session path uses, so one bad doc cannot build an
 * unbounded response.
 */
export function storedLineItemsFrom(raw: unknown): StoredLineItem[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredLineItem[] = [];
  for (const entry of raw.slice(0, MAX_LINE_ITEM_SESSIONS)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const description = stringOrNull(e['description']);
    const qty = numericOrNull(e['qty']);
    const unitCents = numericOrNull(e['unitCents']);
    const discountCents = numericOrNull(e['discountCents']) ?? 0;
    if (description === null || description.trim() === '') continue;
    if (qty === null || !Number.isFinite(qty) || qty <= 0) continue;
    if (unitCents === null || !Number.isInteger(unitCents)) continue;
    if (!Number.isInteger(discountCents) || discountCents < 0) continue;
    out.push({ description: description.trim(), qty, unitCents, discountCents });
  }
  return out;
}

/**
 * A stored line, as the household sees it.
 *
 * The amount is computed the SAME WAY the server totals an invoice
 * (`invoiceMath.ts#lineAmountCents`): round `qty x unitCents` once, half-up, then
 * subtract the line discount. Any other arithmetic here would put a breakdown on
 * the household's screen that does not add up to the total printed under it.
 *
 * `dateIso` is null because a stored line carries no date. It describes what was
 * billed, not when a visit happened, and inventing the invoice date for it would
 * assert something nobody recorded.
 */
export function mapStoredLineItem(li: StoredLineItem, index: number): InvoiceLineItemDto {
  return {
    lineId: `stored:${index}`,
    source: 'stored',
    sessionId: '',
    label: li.description,
    dateIso: null,
    amountCents: Math.round(li.qty * li.unitCents) - li.discountCents,
    qty: li.qty,
    unitCents: li.unitCents,
  };
}

function numericOrNull(v: unknown): number | null {
  if (typeof v === 'number' && !isNaN(v) && isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  }
  return null;
}

/**
 * An integer count of cents, or 0. Strict about the integer part: `paidCents` is
 * written only by the server's own settlement pass, so a float or a string in
 * that field means something wrote it that should not have, and reading it as
 * money would launder that mistake into the household's screen.
 */
function integerCentsFrom(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0;
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
