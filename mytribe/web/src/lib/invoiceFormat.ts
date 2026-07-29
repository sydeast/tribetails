/**
 * Pure display-formatting helpers for the Invoices/InvoiceDetail screens.
 * Kept separate from portalFormat.ts (not touched by this session — see
 * DEVELOPMENT_PLAN_2026-07-10.md S3 file-scope rules) so the mapping logic
 * has direct vitest coverage, same pattern as portalFormat.test.ts.
 */
import type { InvoiceDto } from '../contracts/invoiceContracts.generated';
import { calTile } from './portalFormat';

/**
 * The stored Invoice State Stamp's vocabulary (ADR-0002), read off the
 * generated DTO instead of spelled out again. An alias for readability, not a
 * declaration: writing the eight states out here would be one more copy to
 * keep in step, which is the drift ADR-0001 ends. A state renamed server-side
 * now lands as a compile error on the switch below.
 */
type InvoiceStatus = InvoiceDto['status'];

/** "$36.00" / "-$12.50" from a dollars-denominated amount. */
export function formatUsd(dollars: number): string {
  const sign = dollars < 0 ? '-' : '';
  return `${sign}$${Math.abs(dollars).toFixed(2)}`;
}

/** "$36.00" from a cents-denominated amount (creditAmountCents, accountBalanceCents). */
export function formatCentsUsd(cents: number): string {
  return formatUsd(cents / 100);
}

/** Parses an opaque backend date string to epoch ms, or null if unparseable/absent. */
export function parseDateMs(raw: string | null): number | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * "Jun 2" (no zero-pad) for the invoice-row `.amt .due` line ("Due Jun 14" /
 * "Paid Jun 2"). Falls back to the raw string as-is when it can't be parsed
 * as a date, rather than hiding backend-provided text.
 */
export function shortDateLabel(raw: string | null): string | null {
  if (!raw) return null;
  const ms = parseDateMs(raw);
  if (ms === null) return raw;
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** "Jun 01, 2026" (zero-padded day) for the detail page's meta-strip Date/Due Date cells. */
export function longDateLabel(raw: string | null): string | null {
  if (!raw) return null;
  const ms = parseDateMs(raw);
  if (ms === null) return raw;
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
}

/** The `.cal` tile (month + zero-padded day). Falls back to an em-dash tile when unparseable. */
export function calTileFor(raw: string | null): { month: string; day: string } {
  const ms = parseDateMs(raw);
  if (ms === null) return { month: '—', day: '--' };
  return calTile(ms);
}

export interface InvoiceStatusInfo {
  /** Friendly label, e.g. for the detail page's meta-strip Status cell. */
  label: string;
  /** Uppercased chip text, matching the list's chip styling. */
  chipLabel: string;
  /** CSS class for `.chip.<cssClass>` (draft/pending/paid/cancelled/creditc/redeemed). */
  cssClass: string;
  /** CSS class for the `.inv.<invClass>` row wrapper (`''` = no modifier). */
  invClass: string;
}

/**
 * Friendly status label + chip/row CSS classes, shared by the list and
 * detail screens. Covers all eight states of the stored Invoice State Stamp
 * (ADR-0002) — LABELS ONLY, no classification: the server decides what an
 * invoice IS, this decides only what each state is called on screen. Open ->
 * "Pending" mirrors InvoicesScreen.kt's `invoiceStatusLabel` (the
 * already-implemented Kotlin reference); quote/zero/redeemed mirror the
 * admin's `invoiceStateInfo` labels (auntieos-admin/src/lib/invoiceFormat.ts).
 */
export function invoiceStatusInfo(status: InvoiceStatus, creditRedeemedAtMs: number | null): InvoiceStatusInfo {
  switch (status) {
    case 'quote':
      // A proposal, not a bill: no "due" row treatment and (via the screens'
      // status === 'open' gate) no Pay button.
      return { label: 'Quote', chipLabel: 'QUOTE', cssClass: 'quote', invClass: 'draft' };
    case 'draft':
      return { label: 'Draft', chipLabel: 'DRAFT', cssClass: 'draft', invClass: 'draft' };
    case 'open':
      return { label: 'Pending', chipLabel: 'PENDING', cssClass: 'pending', invClass: 'due' };
    case 'zero':
      // A genuinely $0 invoice. Not "Paid": nothing was collected.
      return { label: 'Zero balance', chipLabel: 'ZERO', cssClass: 'zero', invClass: '' };
    case 'paid':
      return { label: 'Paid', chipLabel: 'PAID', cssClass: 'paid', invClass: '' };
    case 'cancelled':
      return { label: 'Cancelled', chipLabel: 'CANCELLED', cssClass: 'cancelled', invClass: '' };
    case 'redeemed':
      return { label: 'Redeemed', chipLabel: 'REDEEMED', cssClass: 'redeemed', invClass: 'credit' };
    case 'credit':
      // The stamp writes `redeemed` once `creditRedeemedAt` is set, so a
      // stamped doc reaches the case above. This refinement stays for the
      // fail-soft path (an unstamped doc can still say `credit` while
      // carrying a redemption time) so a spent credit is never re-offered.
      return creditRedeemedAtMs !== null
        ? { label: 'Redeemed', chipLabel: 'REDEEMED', cssClass: 'redeemed', invClass: 'credit' }
        : { label: 'Credit', chipLabel: 'CREDIT', cssClass: 'creditc', invClass: 'credit' };
  }
}

/**
 * "Saved to Account Balance" / "Redeemed", per InvoicesScreen.kt's targetLabel.
 * The old "Returned to Original Payment Method" case is gone: credits are NOT
 * refundable, so account balance is the only target a credit can carry.
 */
export function creditTargetLabel(target: InvoiceDto['creditTarget']): string {
  return target === 'accountBalance' ? 'Saved to Account Balance' : 'Redeemed';
}
/**
 * The chip and label for a PART-PAID invoice: money has come in and it does not
 * cover the bill.
 *
 * A DISPLAY REFINEMENT OF `open`, NOT A NINTH STATUS. `InvoiceStatus` is the
 * backend's own enum and a part-paid invoice is genuinely open, so it keeps its
 * bucket, its Pay button and its due-date treatment. What changes is only what
 * the household is TOLD, and that matters here more than anywhere else in this
 * codebase: this is the screen a paying customer looks at. "PENDING" alone hides
 * the $20 they already sent, and "PAID" hides the $20 they still owe. Neither is
 * a small inaccuracy when it is about someone's money.
 */
export function partPaidStatusInfo(): InvoiceStatusInfo {
  return { label: 'Part paid', chipLabel: 'PART PAID', cssClass: 'partpaid', invClass: 'due' };
}
/**
 * "$20.00 of $40.00 paid" for a part-paid invoice, or null when it is not one.
 * Spelled out rather than left to a bare chip: the two numbers together are the
 * whole point, and a chip alone would still leave the household adding up.
 */
export function partPaidSummary(
  invoice: { partiallyPaid: boolean; paidCents: number; total: number },
): string | null {
  if (!invoice.partiallyPaid) return null;
  return `${formatCentsUsd(invoice.paidCents)} of ${formatUsd(invoice.total)} paid`;
}
