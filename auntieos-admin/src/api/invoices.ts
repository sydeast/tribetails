import { type CollectionSpec } from '../lib/firestore';
import type { PagedCollectionSpec } from '../lib/usePagedCollection';
import type { Timestamp } from 'firebase/firestore';
import type {
  CreateInvoiceArgsLineItem,
  LinkInvoiceSessionsResult,
} from '../contracts/invoiceContracts.generated';

/**
 * One `invoices` row. Mirrors the wasm `Invoice` data class in FirestoreClient.kt
 * (commonMain/kotlin/com/tribetails/auntieos/web/data/FirestoreClient.kt:2181),
 * the same flat top-level collection the admin, the kinfolk portal
 * (getMyInvoices.ts), and the Stripe webhook all read/write, confirmed against
 * createInvoice.ts, postInvoiceEvent.ts, and onInvoicesWrite.ts.
 *
 * `status` and `editScope` are the Invoice State Classifier STAMP (ADR-0002):
 * every server-side invoice writer persists the classifier's output onto the
 * doc in the same write, a backfill stamped the pre-existing docs, and
 * firestore.rules denies all client invoice writes. Clients render the
 * persisted state and never classify — read them through `invoiceStamp` below,
 * never by re-deriving state from the money fields.
 *
 * `date` / `dueDate` are `YYYY-MM-DD` day STRINGS, never Firestore Timestamps.
 * All three server writers now enforce that shape or blank
 * (functions/src/lib/invoiceDay.ts), but a document written before that still
 * holds whatever text was sent, so nothing here may assume it: read them through
 * `invoiceDayMs` when the answer is an ordering or a window, and through
 * `lib/invoiceFormat.ts` when the answer is what to print. `createdAt` IS a real
 * server Timestamp (`FieldValue.serverTimestamp()` in createInvoice.ts /
 * createQuote.ts), which is why it is the query's sort key below rather than
 * `date`.
 *
 * `creditTarget` / `creditRedeemedAt` are stamped by redeemCredit.ts's
 * transaction (`FieldValue.serverTimestamp()` for the latter), present only on
 * a credit invoice that has been redeemed. Absent, never blank/null, so both are
 * optional here rather than defaulted (same convention as NotificationEntry.readAt).
 */

/**
 * The Invoice State Classifier's two halves, TAKEN FROM THE CONTRACTS MODULE
 * (ADR-0001) rather than transcribed from `invoiceEditPolicy.ts` as they were
 * until now. `linkInvoiceSessions` is the callable that returns both side by
 * side and un-widened, which is why its result is the source here.
 *
 *   InvoiceState      the 8 states the stamp can write, lowercase
 *   InvoiceEditScope  what an edit may still change
 *                       all           every field, line items and discounts
 *                       metadataOnly  the descriptive fields, money frozen
 *                       none          nothing
 *
 * Nothing in this app decides which member applies; it reads what the server
 * already decided.
 */
export type InvoiceState = LinkInvoiceSessionsResult['status'];
export type InvoiceEditScope = LinkInvoiceSessionsResult['editScope'];

/**
 * The same vocabulary as a RUNTIME value, which is the one thing the type above
 * cannot give `invoiceStamp`: it has to test a string it was handed against the
 * members, and a type erases.
 *
 * `satisfies` pins the list to the contract, so a member this array holds and
 * the server does not is a typecheck failure here. The reverse (a state added
 * server-side and not added here) is NOT a compile error. It lands as the
 * documented fail-soft below: an unrecognized stamp reads as no stamp, which
 * hides the money affordances rather than guessing at them.
 */
export const INVOICE_STATES = [
  'quote',
  'draft',
  'cancelled',
  'credit',
  'redeemed',
  'paid',
  'zero',
  'open',
] as const satisfies readonly InvoiceState[];

export interface InvoiceEntry {
  _id: string;
  kinfolkId: string;
  kinfolkName: string;
  client: string;
  invoiceNumber: string;
  date: string;
  dueDate: string;
  total: number;
  amountDue: number;
  /**
   * What has been collected against this invoice, in integer cents, written by
   * `markInvoicePaid` and by the partial-payment repair pass.
   *
   * ABSENT on every invoice that predates 2026-07-25, which is why it is
   * optional (an absent value is "no record of a payment", never a real
   * zero, see `invoicePartialPayment`). Deliberately NOT derived from
   * `total - amountDue`: those are float dollars, and on every invoice the old
   * partial-payment write touched `amountDue` reads 0 while a real balance is
   * owed, so that subtraction would report the whole total as collected on
   * exactly the invoices that are wrong.
   */
  paidCents?: number;
  /** Collected beyond the total, in integer cents. Present only after an overpayment. */
  overpaidCents?: number;
  /**
   * The persisted Invoice State Classifier verdict (ADR-0002), stamped by the
   * server in the same write as every money change. Typed as the union because
   * that is what the server writes; the interface is still a cast over raw
   * Firestore data, so read it through `invoiceStamp`, which verifies at
   * runtime instead of trusting the cast.
   */
  status: InvoiceState;
  /** The stamp's other half: how much of this invoice the server will let an edit change. */
  editScope: InvoiceEditScope;
  sessionIds: string[];
  creditTarget?: 'accountBalance' | 'originalPaymentMethod';
  creditRedeemedAt?: Timestamp;
  /**
   * WHAT THE HOUSEHOLD SAID ABOUT A QUOTE, written by `acceptQuote` /
   * `denyQuote` (issue #385). Absent on every invoice that was never a quote,
   * and on every quote nobody has answered yet.
   *
   * IT IS NOT REDUNDANT WITH `status`, in either direction. An accepted quote
   * is stamped `open` and is indistinguishable from an ordinary invoice without
   * this field. A DECLINED quote keeps `status: 'quote'`, deliberately, since
   * `cancelled` means the operator withdrew the bill and this is the household
   * turning it down, so without this field a dead quote sits in the Quote
   * filter looking like one still waiting for an answer.
   */
  quoteDecision?: 'accepted' | 'denied';
  /** When they answered. Absent alongside the field above, never a zero. */
  quoteDecidedAt?: Timestamp;
  createdAt: Timestamp | null;
  /**
   * Stamped by Task 5.1's `archiveInvoice` callable, cleared by `unarchiveInvoice`.
   *
   * ABSENT ON EVERY INVOICE THAT PREDATES 5.1, and that does not change now that
   * the field is finally being written: writing it onto new archives does NOT
   * retroactively give it to the invoices already in the collection. That is
   * precisely why `isArchivedInvoice` below is a PRESENCE check applied to rows
   * already loaded, and not a `where('archivedAt', '==', null)` predicate.
   * Firestore's equality-to-null matches only documents that HAVE the field set
   * to null, so a server-side exclusion would return ZERO invoices, and it would
   * do it silently. The deployed `invoices (archivedAt ASC, date DESC)` index
   * stays unused for this purpose until a backfill runs, which is a migration
   * and not this task. `unarchiveInvoice` writes `archivedAt: null` rather than
   * deleting the field, so a restored invoice already carries the shape such a
   * backfill would converge on.
   */
  archivedAt?: Timestamp;
  /**
   * The itemization, written by `createInvoice` and `updateInvoice`.
   *
   * ABSENT IS NOT THE SAME AS EMPTY, and the distinction is load-bearing rather
   * than pedantic. Absent means nobody has ever itemized this invoice, which is
   * true of every invoice created before Task 5.1. Empty means somebody itemized
   * it as billing nothing. `updateInvoice` REFUSES to recompute an un-itemized
   * invoice for exactly this reason: "the sum of zero lines" is not the same
   * statement as "this invoice is worth nothing", and treating them alike would
   * rewrite a real $40 invoice to $0 the next time an operator corrected its due
   * date. Nothing in this app may flatten the two into `lineItems ?? []`; read
   * them through `invoiceLineItems` below.
   */
  lineItems?: InvoiceLineItem[];
  /** Whole-invoice reduction, integer cents. Only meaningful alongside `lineItems`. */
  invoiceDiscountCents?: number;
  /** Sum of the line amounts before the invoice discount, integer cents. Server-derived. */
  subtotalCents?: number;
  /** The exact total in integer cents. `total` above is its rounded dollar projection. */
  totalCents?: number;
  /** The exact balance in integer cents. `amountDue` above is its dollar projection. */
  amountDueCents?: number;
  /**
   * WHERE THE CHARGEBACK CONTEST STANDS, mirrored from Stripe's own Dispute
   * `status` by `functions/src/billing/stripeDispute.ts`: `needs_response`,
   * `under_review`, `won`, `lost`, and whatever else Stripe adds.
   *
   * `string`, not a union, on purpose. This is Stripe's vocabulary rather than
   * ours, it grows without asking, and the webhook writes through whatever
   * arrived. A union here would turn an unfamiliar status into a compile-time
   * fiction instead of the runtime fact it is; `invoiceDispute` verifies at
   * runtime and the screens print the raw text.
   *
   * `| null` because the lifecycle write sets it UNCONDITIONALLY, so a dispute
   * event whose payload carried no status leaves an explicit null on the doc
   * rather than no key at all.
   *
   * NOTHING EVER CLEARS IT — the contest did happen — so a won invoice keeps
   * the field for good. That is exactly why no screen may read "non-empty" as
   * "on fire". See `invoiceDispute`.
   */
  disputeStatus?: string | null;
  /**
   * WHETHER THE MONEY ACTUALLY MOVED. A different fact from the one above, and
   * it routinely disagrees: a dispute sits at `needs_response` for weeks with
   * the balance already debited, and a `won` dispute is not reinstated the
   * instant it closes. Written by the funds lane
   * (`charge.dispute.funds_withdrawn` / `funds_reinstated`).
   *
   * That lane writes this WITHOUT `disputeStatus`, and Stripe promises no
   * ordering between the two lanes, so a doc really can hold a withdrawal and
   * no status at all.
   */
  disputeFundsState?: 'withdrawn' | 'reinstated' | null;
  /**
   * The DISPUTED amount in integer cents, Stripe's `Dispute.amount`. Null when
   * the event carried no number, never 0: a zero would claim the bank pulled
   * nothing back.
   *
   * IT IS NOT THE DEBIT. What leaves the Stripe balance is this plus Stripe's
   * dispute fee, and the fee is not on the object, so no screen may add the two
   * up or present this figure as the sum that left.
   */
  disputeAmountCents?: number | null;
  /** Stripe's `dp_…` id, the key of the `stripeDisputes/{id}` operator record. */
  disputeId?: string | null;
  /**
   * WHEN THE EVIDENCE IS DUE, epoch MILLISECONDS, or null for "there is none".
   *
   * The time-critical fact of the whole dispute feature: a chargeback you fail
   * to answer by this moment is lost by default. Written on the lifecycle lane
   * only, mirrored from `stripeDisputes/{id}.evidenceDueByMs`.
   *
   * MILLISECONDS, not seconds. `stripeDispute.ts#evidenceDueByMsOf` multiplies
   * Stripe's epoch-seconds `due_by` by 1000 before storing, matching
   * `lastEventCreatedMs`. Nothing on the client divides it back.
   *
   * NULL IS NEITHER ZERO NOR AN ERROR. Stripe sends `due_by: 0` deliberately,
   * meaning "the customer's bank or credit card company doesn't allow a
   * response for this particular dispute" (pinned SDK, Disputes.d.ts:210), and
   * the webhook maps that, a null `due_by`, an absent `evidence_details` and
   * anything non-finite all to null. A screen that fell back to 0 would print a
   * chargeback fifty-five years overdue.
   */
  disputeEvidenceDueByMs?: number | null;
  /**
   * WHY THE CARDHOLDER IS DISPUTING, Stripe's raw snake_case token.
   *
   * `string` and not a union, exactly like `disputeStatus` and for the same
   * reason: the SDK types `Dispute.reason` as a plain `string`
   * (Disputes.d.ts:89) and the docstring's category list — `fraudulent`,
   * `product_not_received`, `duplicate`, … — is prose rather than a type.
   * Stripe adds categories on its own schedule and the webhook stores whatever
   * arrived with no allowlist, so a category this build has never heard of
   * reaches the screen and is shown as sent. See `invoiceDisputeReasonGloss`.
   */
  disputeReason?: string | null;
}

/**
 * One billed line: `description`, a `qty` that may be fractional (2.5 hours), a
 * `unitCents` that is an INTEGER count of cents, and an optional per-line
 * `discountCents`.
 *
 * AN ALIAS OF THE CONTRACT, not a transcription of it. The stored array is
 * whatever `createInvoice` was handed or whatever `updateInvoice`'s patch
 * replaced it with, written through verbatim (`updateInvoice.ts:253`), so the
 * request shape IS the stored shape and there is no second thing to describe.
 * `UpdateInvoiceArgsPatchLineItem` is the identical type on the edit side; the
 * codegen emits one per callable, and this app needs one name.
 *
 * There is NO stored per-line amount, deliberately. It is always derived through
 * `lib/invoiceMath.ts#lineAmountCents`, so the lines shown and the total shown
 * can only ever come from one rule.
 */
export type InvoiceLineItem = CreateInvoiceArgsLineItem;

/**
 * The stored lines, or null when this invoice has never been itemized.
 *
 * The single place the absent-versus-empty distinction above is read, so no
 * screen has to remember it. Returns null for absent, `[]` for empty, and drops
 * any row that is not a usable line: `InvoiceEntry` is a cast over raw Firestore
 * data rather than a validation of it, and `firestore.rules` grants
 * `allow update: if isAuntie()` over this collection, so a malformed row can
 * genuinely be sitting on a doc. Dropping one bad line beats letting it blank
 * the whole panel through the error boundary, which is the failure the
 * `normalizeInvoice` note below records happening twice on live data.
 */
export function invoiceLineItems(row: Pick<InvoiceEntry, 'lineItems'>): InvoiceLineItem[] | null {
  if (!Array.isArray(row.lineItems)) return null;
  const out: InvoiceLineItem[] = [];
  for (const entry of row.lineItems as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const li = entry as Record<string, unknown>;
    const qty = li['qty'];
    const unitCents = li['unitCents'];
    if (typeof qty !== 'number' || !Number.isFinite(qty)) continue;
    if (typeof unitCents !== 'number' || !Number.isFinite(unitCents)) continue;
    const discountCents = li['discountCents'];
    out.push({
      description: typeof li['description'] === 'string' ? li['description'] : '',
      qty,
      unitCents,
      ...(typeof discountCents === 'number' && Number.isFinite(discountCents) ? { discountCents } : {}),
    });
  }
  return out;
}

/**
 * The stamp as this doc actually carries it, verified rather than trusted.
 *
 * `state: null` means the doc carries NO recognizable stamp. Per ADR-0002 that
 * should be impossible now — every writer stamps, the backfill stamped the
 * backlog, and the rules deny every client write — so this is the deliberate
 * fail-soft for the impossible doc, NOT a second classifier:
 *
 *   - the state is null, never re-derived from the money fields. The screens
 *     render a neutral chip from the raw `status` text and say nothing they
 *     cannot prove;
 *   - the editScope is 'none', the SAFE affordance: no editing offered on an
 *     unknown state. This is the one place the old mirror's "fail toward
 *     offering the control" ruling inverts, on purpose: that ruling existed
 *     because the mirror was a courtesy in front of a server that would refuse;
 *     an unstamped doc means the write path itself is not what we think it is,
 *     and offering money controls against it would be a guess.
 *
 * Recognition is EXACT match against the stamp's own vocabulary (lowercase, no
 * padding), because that is what the server writes. A legacy spelling like
 * 'PAID' is not "obviously paid", it is evidence the doc was never stamped,
 * and normalizing it here would be re-classification through the back door.
 */
export interface InvoiceStamp {
  state: InvoiceState | null;
  editScope: InvoiceEditScope;
}

export function invoiceStamp(row: Pick<InvoiceEntry, 'status' | 'editScope'>): InvoiceStamp {
  const status: unknown = row.status;
  const state =
    typeof status === 'string' && (INVOICE_STATES as readonly string[]).includes(status)
      ? (status as InvoiceState)
      : null;
  if (state === null) return { state: null, editScope: 'none' };
  const scope: unknown = row.editScope;
  return {
    state,
    editScope:
      scope === 'all' || scope === 'metadataOnly' || scope === 'none' ? scope : 'none',
  };
}

/**
 * The household's answer to a quote, verified at runtime rather than trusted
 * off the cast. Same rule as `invoiceStamp` above: an unrecognized value is
 * evidence something wrote this field that should not have, and reads as no
 * answer rather than being normalized into one.
 */
export function invoiceQuoteDecision(
  row: Pick<InvoiceEntry, 'quoteDecision'>,
): 'accepted' | 'denied' | null {
  const raw: unknown = row.quoteDecision;
  return raw === 'accepted' || raw === 'denied' ? raw : null;
}
/** The two values the funds lane writes. Anything else is not a funds state. */
export const INVOICE_DISPUTE_FUNDS_STATES = ['withdrawn', 'reinstated'] as const;
export type InvoiceDisputeFundsState = (typeof INVOICE_DISPUTE_FUNDS_STATES)[number];

/**
 * The chargeback as this doc actually carries it: two independent facts, plus
 * the one verdict every screen needs and none of them may re-derive.
 */
export interface InvoiceDispute {
  /**
   * `disputeStatus` verbatim, or null when the doc holds none. Not normalized
   * and not translated: an unfamiliar status is shown as it was written, and a
   * label invented for it would be a guess about money.
   */
  status: string | null;
  /** Verified against the two the funds lane writes. Unrecognized reads as absent. */
  fundsState: InvoiceDisputeFundsState | null;
  /** The disputed amount, integer cents. Null is null; it is never a zero. */
  amountCents: number | null;
  disputeId: string | null;
  /**
   * The evidence deadline in epoch milliseconds, or null for "no deadline is
   * stated". A stored 0 comes out null here too: see `disputeEvidenceDueByMs`
   * above for why Stripe's zero is a real value that is not a date.
   *
   * This is the raw fact. What the operator is shown about it is
   * `invoiceDisputeDeadline`, which is where the urgency gate lives.
   */
  evidenceDueByMs: number | null;
  /**
   * `disputeReason` verbatim, or null when the doc holds none. Not normalized
   * and not translated, for the same reason `status` is not: it is Stripe's
   * vocabulary and it grows without asking.
   */
  reason: string | null;
  /**
   * DOES THIS STILL WANT THE OPERATOR? The whole point of the type.
   *
   * `false` for exactly one status, `won`, and `true` for everything else
   * including a status this build has never heard of.
   *
   *  - It has to be false for `won` because nothing ever clears the flag. The
   *    contest happened and stays on record, so an invoice disputed once carries
   *    `disputeStatus` forever. A screen that alarmed on any non-empty value
   *    would show every previously-disputed invoice as permanently on fire, and
   *    an alarm that is always on is an alarm nobody reads.
   *  - It has to be true for everything else, including the unknown, because
   *    this is money that may have left the balance. `lost` is closed and still
   *    wants a human: where contested money ends up is the operator's call.
   *    Downgrading a status we cannot interpret would be the one failure mode
   *    this whole lane exists to prevent — quiet.
   *
   * A won dispute whose funds are still out stays `false`. Reinstatement lags
   * the ruling as a matter of course; the panel says so in words instead of
   * raising an alarm about a normal delay.
   */
  open: boolean;
}

/**
 * The chargeback flags, verified rather than trusted, or null when this invoice
 * has never been disputed.
 *
 * PRESENCE IS ANY OF THE THREE. The lifecycle lane
 * (`charge.dispute.created`/`closed`) writes `disputeStatus`, and the funds lane
 * (`funds_withdrawn`/`funds_reinstated`) writes `disputeFundsState` and
 * deliberately does NOT write a status, "because the balance moving says nothing
 * about where the contest stands". Stripe guarantees no ordering between the
 * lanes, so a withdrawal landing first leaves a doc with moved money and no
 * status — which is the single most urgent shape there is, and a status-only
 * presence test would render it as no dispute at all.
 *
 * Same runtime-verification contract as `invoiceStamp` above: `InvoiceEntry` is
 * a cast over raw document data, not a validation of it.
 */
export function invoiceDispute(
  row: Pick<
    InvoiceEntry,
    | 'disputeStatus'
    | 'disputeFundsState'
    | 'disputeAmountCents'
    | 'disputeId'
    | 'disputeEvidenceDueByMs'
    | 'disputeReason'
  >,
): InvoiceDispute | null {
  const rawStatus: unknown = row.disputeStatus;
  const status = typeof rawStatus === 'string' && rawStatus.trim() !== '' ? rawStatus : null;

  const rawFunds: unknown = row.disputeFundsState;
  const fundsState =
    typeof rawFunds === 'string' &&
    (INVOICE_DISPUTE_FUNDS_STATES as readonly string[]).includes(rawFunds)
      ? (rawFunds as InvoiceDisputeFundsState)
      : null;

  const rawId: unknown = row.disputeId;
  const disputeId = typeof rawId === 'string' && rawId.trim() !== '' ? rawId : null;

  // PRESENCE IS STILL THESE THREE AND ONLY THESE THREE. The reason and the
  // deadline ride the same lifecycle write as `disputeStatus`, so a document
  // carrying one of them and none of the three below is a corrupt document
  // rather than a dispute, and admitting it here would let a stray field
  // conjure a chargeback banner onto a clean invoice.
  if (status === null && fundsState === null && disputeId === null) return null;

  // Absent, null, and NaN all mean "no figure arrived". None of them mean zero.
  const rawAmount: unknown = row.disputeAmountCents;
  const amountCents =
    typeof rawAmount === 'number' && Number.isFinite(rawAmount) ? rawAmount : null;

  // THE SECOND LOCK ON STRIPE'S ZERO. `stripeDispute.ts` already refuses to
  // store a `due_by` of 0, because Stripe sends that to mean the issuing bank
  // allows no response at all rather than to mean 1 January 1970. This repeats
  // the refusal on the read side for the same reason `invoiceStamp` verifies
  // rather than trusts: `InvoiceEntry` is a cast over raw document data, and a
  // 0 that ever reached this field must not become `new Date(0)`.
  const rawDueBy: unknown = row.disputeEvidenceDueByMs;
  const evidenceDueByMs =
    typeof rawDueBy === 'number' && Number.isFinite(rawDueBy) && rawDueBy > 0 ? rawDueBy : null;

  const rawReason: unknown = row.disputeReason;
  const reason = typeof rawReason === 'string' && rawReason.trim() !== '' ? rawReason : null;

  return {
    status,
    fundsState,
    amountCents,
    disputeId,
    evidenceDueByMs,
    reason,
    open: status !== 'won',
  };
}

/**
 * THE ONE STATUS THAT MAKES A DEADLINE ACTIONABLE.
 *
 * Stripe's `Dispute.status` docstring (pinned SDK, Disputes.d.ts:93) lists
 * `warning_needs_response`, `warning_under_review`, `warning_closed`,
 * `needs_response`, `under_review`, `won`, `lost` and `prevented`. Exactly one
 * of them is a chargeback awaiting the operator's answer, and the countdown is
 * gated on an exact match against it.
 *
 * Everything else keeps whatever alarm `open` gave it and gets no countdown:
 *
 *  - `won` and `lost` are settled and still carry their deadline, because
 *    nothing ever clears any of these fields. Counting down to it would send
 *    the operator to fight a contest that is already over.
 *  - `under_review` means the evidence is already in. There is nothing left to
 *    submit by the date.
 *  - a status this build has never heard of gets no countdown for the same
 *    reason it gets no relabelling: we cannot prove it is answerable.
 *
 * `warning_needs_response` is the known candidate for widening this and is
 * deliberately not here. It is an inquiry rather than a chargeback, it can
 * carry its own `due_by`, and whether an inquiry deserves the same red clock is
 * an operator's ruling rather than this file's guess.
 */
const INVOICE_DISPUTE_ANSWERABLE_STATUS = 'needs_response';

/**
 * What the operator is told about the response deadline.
 *
 * Four states, because there are genuinely four different things to say and
 * three of them are refusals:
 *
 *  - `due`: an answerable dispute with a deadline still ahead. Count it down.
 *  - `passed`: an answerable dispute whose deadline is behind us. NOT a
 *    negative countdown and NOT a verdict — see `invoiceDisputeDeadline`.
 *  - `unstated`: an answerable dispute with no deadline on the document at all.
 *  - `none`: nothing to count down to, because the dispute is not answerable.
 */
export type InvoiceDisputeDeadline =
  | { state: 'due'; dueByMs: number; msRemaining: number }
  | { state: 'passed'; dueByMs: number }
  | { state: 'unstated' }
  | { state: 'none' };

/**
 * The deadline as the screen must present it, from the document and the clock.
 *
 * Pure, and `nowMs` is a parameter rather than a `Date.now()` inside, for the
 * same reason `invoiceDisputeTone` on Android is a function rather than an
 * inline `if`: the branch that decides whether an operator sees a red clock is
 * the branch a test has to be able to call.
 *
 * A DEADLINE THAT HAS PASSED IS ITS OWN STATE. `disputeStatus` is a webhook
 * mirror of Stripe's, so it can still read `needs_response` after Stripe has
 * shut the window — the `charge.dispute.closed` event may not have landed, or
 * may never land if the dispute was answered elsewhere. So the past-deadline
 * case says the window closed and points at Stripe, and does not claim the
 * dispute is lost. Rendering `-2 days left` would be the arithmetic being
 * correct and the sentence being nonsense.
 *
 * The exact instant counts as passed. At `dueByMs` there is no time left to
 * submit anything, and "0 days left" reads as a day.
 */
export function invoiceDisputeDeadline(
  dispute: Pick<InvoiceDispute, 'status' | 'evidenceDueByMs'>,
  nowMs: number,
): InvoiceDisputeDeadline {
  if (dispute.status !== INVOICE_DISPUTE_ANSWERABLE_STATUS) return { state: 'none' };
  const dueByMs = dispute.evidenceDueByMs;
  if (dueByMs === null) return { state: 'unstated' };
  if (dueByMs <= nowMs) return { state: 'passed', dueByMs };
  return { state: 'due', dueByMs, msRemaining: dueByMs - nowMs };
}

/**
 * How much time is left, in words.
 *
 * A DURATION, never a calendar computation. The arithmetic runs on elapsed
 * milliseconds, so no timezone and no daylight-saving boundary can move the
 * answer — which matters because the absolute date beside it IS rendered in the
 * operator's zone, and the two must not be able to disagree.
 *
 * Rounds down at every step, toward the operator having less time than they
 * think. Stops at "less than an hour" rather than counting minutes: a minute
 * counter would be stale the moment it painted, since nothing here ticks.
 */
export function invoiceDisputeTimeLeft(msRemaining: number): string {
  const hours = Math.floor(msRemaining / 3_600_000);
  if (hours < 1) return 'less than an hour left';
  const days = Math.floor(hours / 24);
  if (days < 1) return `${hours} ${hours === 1 ? 'hour' : 'hours'} left`;
  return `${days} ${days === 1 ? 'day' : 'days'} left`;
}

/**
 * Plain English for a Stripe dispute reason, or null when this build has never
 * seen the token.
 *
 * THE TOKEN IS ALWAYS SHOWN; THIS IS A COURTESY ON TOP OF IT. `reason` is a
 * plain `string` in the pinned SDK (Disputes.d.ts:89), not a union, and the
 * docstring's list is prose that Stripe extends on its own schedule. Returning
 * null rather than "Unknown" is the difference between the screen saying
 * nothing about a category it does not know and the screen presenting this
 * build's ignorance as Stripe's answer.
 *
 * The wording carries a constraint from `InvoiceDetail.test.tsx`: the reason
 * renders on the closed-history banner too, and that banner is pinned never to
 * contain "respond", "deadline" or "evidence". Nothing here may use those
 * words, and a case in `invoices.test.ts` holds the table to it.
 */
const INVOICE_DISPUTE_REASON_GLOSS: Readonly<Record<string, string>> = {
  bank_cannot_process: 'their bank could not process the payment',
  check_returned: 'the check was returned unpaid',
  credit_not_processed: 'they say a refund they were promised never arrived',
  customer_initiated: 'the cardholder asked their bank to reverse it',
  debit_not_authorized: 'they say they never authorized the debit',
  duplicate: 'they say they were charged twice for the same thing',
  fraudulent: 'they say they did not authorize this charge at all',
  general: 'the bank filed it without naming a category',
  incorrect_account_details: 'the account details on the charge were wrong',
  insufficient_funds: 'the account did not have the funds',
  noncompliant: 'the charge broke a card network rule',
  product_not_received: 'they say the care was never delivered',
  product_unacceptable: 'they say the care was not what was agreed',
  subscription_canceled: 'they say the arrangement had already been canceled',
  unrecognized: 'they do not recognize the charge on their statement',
};

export function invoiceDisputeReasonGloss(reason: string): string | null {
  return Object.prototype.hasOwnProperty.call(INVOICE_DISPUTE_REASON_GLOSS, reason)
    ? (INVOICE_DISPUTE_REASON_GLOSS[reason] as string)
    : null;
}

/**
 * Has this invoice been archived?
 *
 * Presence, not truthiness: an archived invoice carries a Timestamp, an active
 * one carries nothing at all. `null` is accepted as "not archived" so that an
 * unarchive implemented as `archivedAt: null` (rather than a field delete) reads
 * the same way here.
 */
export function isArchivedInvoice(row: Pick<InvoiceEntry, 'archivedAt'>): boolean {
  return row.archivedAt !== undefined && row.archivedAt !== null;
}

/**
 * Fill the fields this interface CLAIMS are always present but Firestore does
 * not guarantee. The interface is a cast over raw document data, not a
 * validation of it, so a legacy or seeded doc missing a key crashes any
 * consumer that calls a method on it.
 *
 * Both failures below were found by driving the LIVE app on 2026-07-20, and
 * both blanked the ENTIRE invoices page via the error boundary rather than
 * degrading one row:
 *   - the 4 seeded sandbox invoices had no `status`  -> `.trim()` of undefined
 *     (in the since-deleted client classifier; `invoiceStamp` reads an absent
 *     or unrecognized `status` as "no stamp" without touching a method on it,
 *     so `status` no longer needs — or admits — a normalization default: ''
 *     is not a member of the stamped union, and inventing a member would be
 *     classification)
 *   - `test-kinfolk-001-invoice-1` has no `sessionIds` -> `.length` of undefined
 *
 * Normalize here, once, so no screen has to remember. Money fields are left
 * exactly as they arrive: coercing an absent `total` to 0 would invent a
 * financial fact the document never made.
 */
export function normalizeInvoice(row: InvoiceEntry): InvoiceEntry {
  return {
    ...row,
    client: row.client ?? '',
    kinfolkName: row.kinfolkName ?? '',
    invoiceNumber: row.invoiceNumber ?? '',
    date: row.date ?? '',
    dueDate: row.dueDate ?? '',
    sessionIds: Array.isArray(row.sessionIds) ? row.sessionIds : [],
  };
}

/**
 * The bounded, server-ordered invoices listener. Ordered by `createdAt`
 * descending, capped at 200 (the ActivityLog/Notifications convention).
 *
 * DELIBERATE IMPROVEMENT over the wasm reference, not a faithfully-ported
 * behavior: `FirestoreInterop.*.kt`'s `platformInvoicesStream()` is a plain
 * `collectionStream("invoices")`, an unbounded whole-collection listen, the
 * exact AO-29 pattern `useCollection` exists to close off by construction. This
 * spec is what makes that fix apply here too.
 *
 * Sorted by `createdAt` rather than the wasm's client-side sort on the
 * free-text `date`/`dueDate` fields: those two are unvalidated strings (a
 * draft can easily have neither set yet), where `createdAt` is a real
 * `FieldValue.serverTimestamp()` stamped by both real creation paths
 * (createInvoice.ts, createQuote.ts), so ordering by it can't silently drop or
 * misplace an undated draft the way sorting by `date` could.
 *
 * NO `filters`, a single-field orderBy needs no composite index (same note as
 * NOTIFICATIONS_QUERY). All status/date filtering in the screen happens
 * client-side over the already-streamed page, same as the wasm's own
 * `matchesFilter`.
 */
export const INVOICES_QUERY: CollectionSpec = {
  path: 'invoices',
  order: ['createdAt', 'desc'],
  max: 200,
};
/** The cap on the household profile's invoices read; `feedCountMeta` needs it by name. */
export const INVOICES_PROFILE_MAX = 200;
/**
 * Every invoice for ONE household, newest first, for the household profile's
 * Invoices card.
 *
 * ORDERED BY `date`, NOT `createdAt`, and that is deliberate. `invoices.date` is
 * the billing day an operator recognises, and it is the field the deployed
 * `invoices (kinfolkId ASC, date DESC)` index pairs with `kinfolkId` (see
 * `invoicesPageQuery`'s note). `createdAt` on this collection is a real
 * Firestore Timestamp with no such pair deployed, so ordering by it here would
 * need an index that does not exist.
 *
 * `date` is FREE TEXT (PR #241), so the sort is lexical and a row whose date was
 * typed in some other shape sorts where that string falls. The card labels each
 * row with the stored value through `kinfolkInvoiceFeedLabel`, so what an
 * operator reads is what is stored, never a guess.
 */
export function invoicesForKinfolkQuery(kinfolkId: string): CollectionSpec {
  return {
    path: 'invoices',
    order: ['date', 'desc'],
    max: INVOICES_PROFILE_MAX,
    filters: [['kinfolkId', '==', kinfolkId]],
  };
}

/** Rows per "Load more" on the Invoices list. Same reasoning as `KINTALES_PAGE_SIZE`. */
export const INVOICES_PAGE_SIZE = 25;

export interface InvoicesPageOptions {
  /**
   * Lower bound on the invoice `date`, as a `YYYY-MM-DD` DAY (not a full ISO
   * instant), or null for "All (archive)". Null adds NO predicate at all.
   */
  startDay: string | null;
  /** The household facet. Blank/undefined means every household. */
  kinfolkId?: string | undefined;
}

/**
 * The LIST screen's own paged query. `INVOICES_QUERY` above stays as it is:
 * `InvoiceDetail` is handed a row by value from whatever the list loaded, and
 * nothing else pages this collection.
 *
 * WHY THE WINDOW MOVED OFF `createdAt` ONTO `date`, which is the one substantive
 * change here and is not a preference:
 *
 *  - `createdAt` is a real Firestore Timestamp (`FieldValue.serverTimestamp()`
 *    in createInvoice.ts / createQuote.ts). `ListToolbar.rangeStartIso` produces
 *    an ISO STRING, and Firestore sorts every timestamp before every string, so
 *    `where('createdAt', '>=', '2026-07-18T...')` matches NOTHING. It does not
 *    throw; it returns an empty list. A window that silently empties the screen
 *    is the exact failure class this codebase is built to refuse.
 *  - Passing a real Timestamp instead is not available either: the paged hook
 *    keys and rebuilds its spec through `JSON.stringify`/`JSON.parse` (see
 *    `usePagedCollection`), which turns a Timestamp into a plain object the SDK
 *    rejects.
 *  - `date` is free text on the doc but it is what the row already displays and
 *    what the operator means by "an invoice from last week", and it is the field
 *    Phase 4's deployed indexes were built for: `invoices (kinfolkId ASC, date
 *    DESC)` and `invoices (archivedAt ASC, date DESC)`.
 *
 * THE COST, stated rather than hidden: `orderBy('date')` drops any invoice whose
 * `date` is missing, and a `date >= <day>` window also excludes an invoice whose
 * `date` is the empty string that `createInvoice`'s schema defaults to. Such an
 * invoice is reachable only under "All (archive)", where there is no predicate
 * and blank sorts last. `Invoices.tsx` says so on screen whenever a dated window
 * is selected, rather than letting an undated draft simply disappear.
 *
 * INDEXES. Range and order share `date`, so the plain window needs no composite
 * index. With the household facet, or a sandbox admin's automatic `kinfolkId ==`
 * scope, `invoices (kinfolkId ASC, date DESC)` covers it.
 *
 * THIS PREDICATE IS NOT SELF-SUFFICIENT, and pretending otherwise is what made
 * "Last 30 days" list invoices half a year old. Firestore compares this bound as
 * a STRING, byte by byte, and every letter outranks every digit, so a stored
 * `"Feb 12, 2026"` clears `>= '2026-07-05'` on its first character. It also
 * sorts ABOVE every real date under `orderBy('date','desc')`, which puts exactly
 * the wrong rows at the top of page one. `createInvoice`/`createQuote` now
 * refuse to write anything but a `YYYY-MM-DD` day (functions/src/lib/invoiceDay.ts),
 * but documents already in the collection still hold the old free text until the
 * backfill is run, so every row this query returns is re-tested against
 * `invoiceWithinWindow` below before it is shown.
 */
export function invoicesPageQuery({ startDay, kinfolkId }: InvoicesPageOptions): PagedCollectionSpec {
  const filters: CollectionSpec['filters'] = [];
  if (kinfolkId !== undefined && kinfolkId !== '') filters.push(['kinfolkId', '==', kinfolkId]);
  if (startDay !== null) filters.push(['date', '>=', startDay]);

  return {
    path: 'invoices',
    order: ['date', 'desc'],
    pageSize: INVOICES_PAGE_SIZE,
    ...(filters.length > 0 ? { filters } : {}),
  };
}

/**
 * The stored `date` as an INSTANT, epoch milliseconds at UTC midnight of the
 * day it names, or null when the field does not name a day at all.
 *
 * A real parse, not a shape test, and the difference is the point. `lib/
 * invoiceFormat.ts#isoDatePrefixOrNull` answers "does this text LOOK like a
 * day", which is the right question for deciding whether to print it; this
 * answers "which day is it", which is the only question an ordering or a window
 * may be built on. `"2026-02-30"` passes the first and fails this one, because
 * `Date.parse` rolls it into March and the round-trip check catches the roll.
 *
 * UTC midnight for both ends, the same convention `invoiceDaysOverdue` already
 * uses: `date` is a calendar label rather than a moment, so comparing two labels
 * pinned to the same zero meridian cannot be shifted by a DST boundary falling
 * between them.
 */
export function invoiceDayMs(raw: string): number | null {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ms = Date.parse(`${s}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return null;
  // Rejects a day that does not exist. Date.parse resolves "2026-02-30" to
  // March 2 rather than failing, and a window that silently relabels a date is
  // the same class of lie as one that silently admits the wrong rows.
  return new Date(ms).toISOString().slice(0, 10) === s ? ms : null;
}

/**
 * Does this row REALLY fall inside the window the operator picked?
 *
 * The other half of `invoicesPageQuery`, and the half that cannot be fooled.
 * The server's `where('date','>=',startDay)` is a string comparison over a field
 * that legacy documents fill with free text; this re-asks the question as
 * arithmetic on two instants, so a row only survives if its `date` names a real
 * calendar day on or after the bound.
 *
 * A row whose `date` is blank or unreadable is OUT of every dated window rather
 * than in it. That is not a new exclusion. `orderBy('date')` already drops a
 * doc with no `date` field, and the screen already tells the operator that
 * undated invoices live under "All (archive)". It extends the same honest answer
 * to a doc whose `date` is present but is not a date.
 *
 * `startDay: null` is "All (archive)": no window, so nothing is excluded and
 * every row passes, including the undated ones.
 */
export function invoiceWithinWindow(
  row: Pick<InvoiceEntry, 'date'>,
  startDay: string | null,
): boolean {
  if (startDay === null) return true;
  const startMs = invoiceDayMs(startDay);
  // An unreadable BOUND is a caller bug, not a row's fault. Excluding every row
  // would empty the screen silently, which is the failure this whole function
  // exists to prevent, so the window simply does not narrow anything.
  if (startMs === null) return true;
  const rowMs = invoiceDayMs(row.date ?? '');
  return rowMs !== null && rowMs >= startMs;
}

/**
 * Does this invoice match the operator's search text?
 *
 * Client-side over the loaded rows, same contract and same disclosure as
 * `kinTaleMatchesSearch`. Number, household, client and the FORMATTED AMOUNT are
 * each tested on their own: an invoice is found by who it is for, by the number
 * written on it, or by what it is worth, and those are the things the row shows.
 *
 * THE AMOUNT IS MATCHED AS THE TEXT THE ROW PRINTS, not as a number. Android's
 * `matchesQuery` does the same, and it is why typing "$40" or "40.00" finds the
 * $40.00 invoice. Matching numerically instead would mean deciding what "40"
 * means (40? 40.00? 4000 cents? a prefix?) and every answer disagrees with what
 * the operator can see on the row. Formatting the stored figure and doing a
 * substring test over it keeps the search and the row describing one string.
 *
 * The formatting is inlined rather than imported from `lib/invoiceFormat.ts`
 * because nothing else in `api/` depends on `lib/`, and a two-line currency
 * format is not worth inverting that. `formatUsd`'s own tests pin the shape, and
 * `invoiceMatchesSearch`'s pin that this agrees with it.
 */
export function invoiceMatchesSearch(
  row: Pick<InvoiceEntry, 'invoiceNumber' | 'kinfolkName' | 'client' | 'total'>,
  search: string,
): boolean {
  const needle = search.trim().toLowerCase();
  if (needle === '') return true;
  const total = typeof row.total === 'number' && Number.isFinite(row.total) ? row.total : 0;
  const money = `${total < 0 ? '-' : ''}$${Math.abs(total).toFixed(2)}`;
  return [row.invoiceNumber ?? '', row.kinfolkName ?? '', row.client ?? '', money].some((field) =>
    field.toLowerCase().includes(needle),
  );
}
