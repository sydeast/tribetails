/**
 * Pure display-formatting helpers for the Invoices/InvoiceDetail screens.
 * Kept separate from portalFormat.ts (not touched by this session — see
 * DEVELOPMENT_PLAN_2026-07-10.md S3 file-scope rules) so the mapping logic
 * has direct vitest coverage, same pattern as portalFormat.test.ts.
 */
import type { InvoiceStatus } from '../api/invoicesApi';
import { calTile } from './portalFormat';

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
 * detail screens. Mirrors InvoicesScreen.kt's `invoiceStatusLabel` (Open ->
 * "Pending") — the already-implemented Kotlin reference, not the mockup's
 * literal "Due" example text, per S3 instructions (mirror data flow).
 */
export function invoiceStatusInfo(status: InvoiceStatus, creditRedeemedAtMs: number | null): InvoiceStatusInfo {
  switch (status) {
    case 'draft':
      return { label: 'Draft', chipLabel: 'DRAFT', cssClass: 'draft', invClass: 'draft' };
    case 'open':
      return { label: 'Pending', chipLabel: 'PENDING', cssClass: 'pending', invClass: 'due' };
    case 'paid':
      return { label: 'Paid', chipLabel: 'PAID', cssClass: 'paid', invClass: '' };
    case 'cancelled':
      return { label: 'Cancelled', chipLabel: 'CANCELLED', cssClass: 'cancelled', invClass: '' };
    case 'credit':
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
export function creditTargetLabel(target: 'accountBalance' | null): string {
  return target === 'accountBalance' ? 'Saved to Account Balance' : 'Redeemed';
}
