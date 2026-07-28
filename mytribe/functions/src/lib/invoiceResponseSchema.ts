/**
 * The zod leaves shared by every invoice-surface response schema (ADR-0001
 * step W3-1).
 *
 * Kept here rather than repeated per callable so the eight-state vocabulary
 * and the three edit scopes appear ONCE on the response side, derived from the
 * classifier's own constants. `INVOICE_STATES` is the single list
 * (`invoiceEditPolicy.ts`) and `z.enum` reads it directly, so a ninth state
 * cannot be added to the classifier without every response schema that ships
 * one accepting it in the same commit, and cannot be added to a response
 * without the classifier.
 *
 * `invoiceEditPolicy.ts` itself stays zod-free on purpose: it is pure
 * classification logic reached from triggers, the backfill script and the
 * clients' twin, and none of those want a validator dependency.
 */
import { z } from 'zod';
import { INVOICE_STATES } from './invoiceEditPolicy';

/**
 * The Invoice State Stamp's `status` (ADR-0002): exactly the eight lowercase
 * states, no wider. A response that ships a raw stored string instead of the
 * classified one fails here, which is the whole point: the clients render
 * this field and never classify.
 */
export const InvoiceStateSchema = z.enum(INVOICE_STATES);

/** The stamp's `editScope` half. */
export const InvoiceEditScopeSchema = z.enum(['all', 'metadataOnly', 'none']);

/**
 * The stamp's `editScope` as the PORTAL ships it: nullable, because a doc
 * carrying no stored scope (a pre-backfill sandbox seed) fail-softs to null
 * rather than to a guessed scope. The kinfolk portal's mirror types it
 * `InvoiceEditScope | null` and every client tolerates the absent case.
 */
export const NullableInvoiceEditScopeSchema = InvoiceEditScopeSchema.nullable();

/**
 * Where an invoice stands after a payment (`invoiceMath.ts#settleInvoice`).
 * Four states, and `overpaid` is a distinct one rather than a settled invoice
 * with a note: the excess is money the operator has to act on.
 */
export const InvoiceSettlementStateSchema = z.enum(['unpaid', 'partial', 'settled', 'overpaid']);

/**
 * Integer cents, non-negative. Every cents field on this surface is an integer
 * by construction (`invoiceMath.ts` rounds once and never divides), so a float
 * here means a re-rounding crept in somewhere.
 */
export const CentsSchema = z.number().int().min(0);

/**
 * Integer cents that MAY be negative. `getMyInvoices` is the only shipper: a
 * credit's `creditAmountCents` is an absolute value, but the arithmetic that
 * produces the surrounding figures runs on a negative balance.
 */
export const SignedCentsSchema = z.number().int();

/**
 * Legacy DOLLARS as a float. `total` and `amountDue` on an invoice doc are
 * dollars, not cents. That is the collection's legacy shape, called out at the top of
 * the invoices section in `CALLABLE_CONTRACT.md`. Typed distinctly from
 * `CentsSchema` so a reader of a generated client type can tell the two units
 * apart without going back to the doc.
 */
export const DollarsSchema = z.number();

/**
 * `ok: true`, the literal, never a plain boolean. Half this surface answers
 * `{ ok: true, invoiceId }`, and a handler that could return `ok: false` would
 * be a second, undocumented failure channel beside `HttpsError`.
 */
export const OkSchema = z.literal(true);
