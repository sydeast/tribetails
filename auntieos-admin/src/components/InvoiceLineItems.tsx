import { useMemo } from 'react';
import type { InvoiceLineItem } from '../api/invoices';
import { computeInvoiceTotals, lineAmountCents, validateInvoiceMoney } from '../lib/invoiceMath';
import { formatCentsUsd } from '../lib/invoiceReconcile';
import {
  parseDollarsToCents,
  parseQty,
  centsToInputDollars,
  qtyToInput,
  MAX_QTY,
  MAX_UNIT_CENTS,
} from '../lib/invoiceMoneyInput';
import { GhostButton } from './Buttons';
import './InvoiceLineItems.css';

/**
 * The invoice itemization, read-only and editable.
 *
 * NO TOTAL IS EVER HAND-ENTERED, here or anywhere else in this feature. Every
 * figure below, per line and in aggregate, is derived through
 * `lib/invoiceMath.ts`, the same module the server recomputes from. An operator
 * cannot type a total that disagrees with the lines because there is nowhere to
 * type one.
 *
 * WHY THE DRAFT ROWS HOLD STRINGS AND NOT NUMBERS. A half-typed price is not a
 * number: "12." and "" and "1,2" are all states an input passes through on the
 * way to a real figure. Parsing on every keystroke and storing the result would
 * turn a blank field into a real 0, which is exactly the silent-zero failure
 * this feature is built to refuse. So the draft is text, the parse happens once
 * at the boundary, and an unparseable field is reported rather than coerced.
 */

/* ------------------------------------------------------------------ read-only */

interface InvoiceLineItemsTableProps {
  lines: readonly InvoiceLineItem[];
  /** Whole-invoice reduction in cents, rendered as its own row when non-zero. */
  invoiceDiscountCents?: number;
}

/**
 * The billed detail as the operator reads it back.
 *
 * The caller decides whether to render this at all: an invoice that was NEVER
 * itemized must not reach here, because an empty items table reads as "nothing
 * was billed", which is a different and much worse claim than saying nothing.
 * `InvoiceDetail` makes that call explicitly.
 */
export function InvoiceLineItemsTable({ lines, invoiceDiscountCents = 0 }: InvoiceLineItemsTableProps) {
  const totals = computeInvoiceTotals(lines, invoiceDiscountCents, 0);

  return (
    <table className="invoice-lines">
      <caption className="invoice-lines__caption">What was billed</caption>
      <thead>
        <tr>
          <th scope="col">Description</th>
          <th scope="col" className="invoice-lines__num">Qty</th>
          <th scope="col" className="invoice-lines__num">Unit</th>
          <th scope="col" className="invoice-lines__num">Amount</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((li, index) => (
          // Index key: line items have no id and are positional by nature. The
          // list is replaced wholesale on every save rather than reordered in
          // place here, so there is no identity for a stable key to preserve.
          <tr key={index}>
            <td>
              {li.description.trim() === '' ? (
                <span className="invoice-lines__missing">no description</span>
              ) : (
                li.description
              )}
              {(li.discountCents ?? 0) > 0 && (
                <span className="invoice-lines__line-discount">
                  includes {formatCentsUsd(li.discountCents ?? 0)} off
                </span>
              )}
            </td>
            <td className="invoice-lines__num">{qtyToInput(li.qty)}</td>
            <td className="invoice-lines__num">{formatCentsUsd(li.unitCents)}</td>
            <td className="invoice-lines__num">{formatCentsUsd(lineAmountCents(li))}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row" colSpan={3}>Subtotal</th>
          <td className="invoice-lines__num">{formatCentsUsd(totals.subtotalCents)}</td>
        </tr>
        {invoiceDiscountCents > 0 && (
          <tr>
            <th scope="row" colSpan={3}>Invoice discount</th>
            <td className="invoice-lines__num">-{formatCentsUsd(invoiceDiscountCents)}</td>
          </tr>
        )}
        <tr className="invoice-lines__total-row">
          <th scope="row" colSpan={3}>Total from these lines</th>
          <td className="invoice-lines__num">{formatCentsUsd(totals.totalCents)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

/* --------------------------------------------------------------------- editor */

/** One row mid-edit. Text, not numbers: see the module header. */
export interface DraftLine {
  description: string;
  qtyText: string;
  unitText: string;
  discountText: string;
}

/** An empty row, as the Add button produces it. */
export function blankDraftLine(): DraftLine {
  return { description: '', qtyText: '1', unitText: '', discountText: '' };
}

/** A stored line, opened for editing. */
export function draftFromLineItem(li: InvoiceLineItem): DraftLine {
  return {
    description: li.description,
    qtyText: qtyToInput(li.qty),
    unitText: centsToInputDollars(li.unitCents),
    discountText: (li.discountCents ?? 0) > 0 ? centsToInputDollars(li.discountCents ?? 0) : '',
  };
}

export interface DraftParseResult {
  /** The parsed lines, in order. Null when any row could not be read. */
  lines: InvoiceLineItem[] | null;
  /** Whole-invoice discount in cents. Null when the field could not be read. */
  invoiceDiscountCents: number | null;
  /** The first problem, as operator-facing text, or null when the set is sound. */
  error: string | null;
}

/**
 * Turns the draft rows into the shape the callable takes, or explains why it
 * cannot. The single boundary between text and money in the editor.
 *
 * A ROW IS NEVER PARTIALLY SALVAGED. If a price will not parse, the whole parse
 * fails and names the row. Dropping the bad row and submitting the rest would
 * quietly bill less than the operator entered, and submitting it as 0 would bill
 * nothing for it; both are worse than refusing and saying which row is wrong.
 *
 * The bounds checked here (`MAX_QTY`, `MAX_UNIT_CENTS`) are the SERVER's, from
 * its zod schema. Checking them client-side is a courtesy that saves a round
 * trip; the server still checks, because a UI rule is not a rule.
 */
export function parseDraftLines(drafts: readonly DraftLine[], invoiceDiscountText: string): DraftParseResult {
  const lines: InvoiceLineItem[] = [];

  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i]!;
    const where = d.description.trim() === '' ? `Line ${String(i + 1)}` : `"${d.description.trim()}"`;

    if (d.description.trim() === '') {
      return { lines: null, invoiceDiscountCents: null, error: `Line ${String(i + 1)} needs a description.` };
    }

    const qty = parseQty(d.qtyText);
    if (qty === null) {
      return {
        lines: null,
        invoiceDiscountCents: null,
        error: `Quantity for ${where} must be a number greater than zero.`,
      };
    }
    if (qty > MAX_QTY) {
      return {
        lines: null,
        invoiceDiscountCents: null,
        error: `Quantity for ${where} cannot be more than ${String(MAX_QTY)}.`,
      };
    }

    const unitCents = parseDollarsToCents(d.unitText);
    if (unitCents === null) {
      // Named explicitly rather than defaulted, which is the same rule
      // `listUninvoicedSessions` applies to an unpriceable visit: never invent a
      // number for a reading that failed.
      return {
        lines: null,
        invoiceDiscountCents: null,
        error: `Unit price for ${where} needs a dollar amount, for example 25.00.`,
      };
    }
    if (unitCents > MAX_UNIT_CENTS) {
      return {
        lines: null,
        invoiceDiscountCents: null,
        error: `Unit price for ${where} cannot be more than ${formatCentsUsd(MAX_UNIT_CENTS)}.`,
      };
    }

    // A blank discount is genuinely "no discount", not an unreadable figure, so
    // it is the one field where absence maps to zero.
    let discountCents = 0;
    if (d.discountText.trim() !== '') {
      const parsed = parseDollarsToCents(d.discountText);
      if (parsed === null) {
        return {
          lines: null,
          invoiceDiscountCents: null,
          error: `Discount for ${where} needs a dollar amount, or leave it empty.`,
        };
      }
      discountCents = parsed;
    }

    lines.push({ description: d.description.trim(), qty, unitCents, ...(discountCents > 0 ? { discountCents } : {}) });
  }

  let invoiceDiscountCents = 0;
  if (invoiceDiscountText.trim() !== '') {
    const parsed = parseDollarsToCents(invoiceDiscountText);
    if (parsed === null) {
      return { lines: null, invoiceDiscountCents: null, error: 'Invoice discount needs a dollar amount, or leave it empty.' };
    }
    invoiceDiscountCents = parsed;
  }

  // The SAME validator the server runs, from the mirrored module, so the
  // operator hears about a discount larger than its line here rather than after
  // a round trip. The server runs it again regardless.
  const moneyError = validateInvoiceMoney(lines, invoiceDiscountCents);
  if (moneyError) return { lines: null, invoiceDiscountCents: null, error: moneyError };

  return { lines, invoiceDiscountCents, error: null };
}

interface InvoiceLineItemsEditorProps {
  drafts: DraftLine[];
  onChange: (next: DraftLine[]) => void;
  invoiceDiscountText: string;
  onInvoiceDiscountChange: (next: string) => void;
  disabled?: boolean;
}

/**
 * The editable itemization: add, edit, remove, reorder, with a live derived
 * total the operator can watch while typing.
 *
 * The live total is computed from whatever currently PARSES. A row mid-typing
 * contributes nothing to it rather than contributing a zero, and the panel says
 * how many rows are not yet readable instead of showing a confident total that
 * silently excludes them. A total that quietly means less than it appears to is
 * the failure this whole feature is arranged against.
 */
export function InvoiceLineItemsEditor({
  drafts,
  onChange,
  invoiceDiscountText,
  onInvoiceDiscountChange,
  disabled = false,
}: InvoiceLineItemsEditorProps) {
  const preview = useMemo(() => {
    const readable: InvoiceLineItem[] = [];
    let unreadable = 0;
    for (const d of drafts) {
      const qty = parseQty(d.qtyText);
      const unitCents = parseDollarsToCents(d.unitText);
      if (qty === null || unitCents === null) {
        unreadable += 1;
        continue;
      }
      const discountCents = d.discountText.trim() === '' ? 0 : (parseDollarsToCents(d.discountText) ?? 0);
      readable.push({ description: d.description, qty, unitCents, discountCents });
    }
    const discount = invoiceDiscountText.trim() === '' ? 0 : (parseDollarsToCents(invoiceDiscountText) ?? 0);
    return { totals: computeInvoiceTotals(readable, discount, 0), unreadable };
  }, [drafts, invoiceDiscountText]);

  function patch(index: number, field: keyof DraftLine, value: string) {
    onChange(drafts.map((d, i) => (i === index ? { ...d, [field]: value } : d)));
  }

  function remove(index: number) {
    onChange(drafts.filter((_, i) => i !== index));
  }

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= drafts.length) return;
    const next = [...drafts];
    const moved = next[index]!;
    next[index] = next[target]!;
    next[target] = moved;
    onChange(next);
  }

  return (
    <div className="invoice-lines-editor">
      {drafts.length === 0 ? (
        <p className="invoice-lines-editor__empty">
          No line items yet. Add one to itemize this invoice, or leave it empty to bill nothing.
        </p>
      ) : (
        <ul className="invoice-lines-editor__list">
          {drafts.map((d, index) => {
            const qty = parseQty(d.qtyText);
            const unitCents = parseDollarsToCents(d.unitText);
            const discountCents = d.discountText.trim() === '' ? 0 : parseDollarsToCents(d.discountText);
            const amount =
              qty !== null && unitCents !== null
                ? formatCentsUsd(lineAmountCents({ description: d.description, qty, unitCents, discountCents: discountCents ?? 0 }))
                : null;

            return (
              <li className="invoice-lines-editor__row" key={index}>
                <div className="invoice-lines-editor__fields">
                  <label className="invoice-lines-editor__field invoice-lines-editor__field--desc">
                    <span className="invoice-lines-editor__label">Description</span>
                    <input
                      className="invoice-lines-editor__input"
                      value={d.description}
                      onChange={(e) => patch(index, 'description', e.target.value)}
                      disabled={disabled}
                      maxLength={200}
                      aria-label={`Line ${String(index + 1)} description`}
                    />
                  </label>
                  <label className="invoice-lines-editor__field invoice-lines-editor__field--qty">
                    <span className="invoice-lines-editor__label">Qty</span>
                    <input
                      className="invoice-lines-editor__input"
                      inputMode="decimal"
                      value={d.qtyText}
                      onChange={(e) => patch(index, 'qtyText', e.target.value)}
                      disabled={disabled}
                      aria-label={`Line ${String(index + 1)} quantity`}
                    />
                  </label>
                  <label className="invoice-lines-editor__field invoice-lines-editor__field--unit">
                    <span className="invoice-lines-editor__label">Unit ($)</span>
                    <input
                      className="invoice-lines-editor__input"
                      inputMode="decimal"
                      value={d.unitText}
                      onChange={(e) => patch(index, 'unitText', e.target.value)}
                      disabled={disabled}
                      placeholder="25.00"
                      aria-label={`Line ${String(index + 1)} unit price in dollars`}
                    />
                  </label>
                  <label className="invoice-lines-editor__field invoice-lines-editor__field--discount">
                    <span className="invoice-lines-editor__label">Off ($), optional</span>
                    <input
                      className="invoice-lines-editor__input"
                      inputMode="decimal"
                      value={d.discountText}
                      onChange={(e) => patch(index, 'discountText', e.target.value)}
                      disabled={disabled}
                      aria-label={`Line ${String(index + 1)} discount in dollars`}
                    />
                  </label>
                </div>
                <div className="invoice-lines-editor__row-foot">
                  {/* Derived, never typed. A row that cannot be read says so
                      rather than showing $0.00, which would be indistinguishable
                      from a line the operator meant to bill nothing for. */}
                  <span className="invoice-lines-editor__amount">
                    {amount ?? <span className="invoice-lines-editor__amount-pending">amount needs a qty and a unit price</span>}
                  </span>
                  <div className="invoice-lines-editor__row-actions">
                    <button
                      type="button"
                      className="invoice-lines-editor__icon"
                      onClick={() => move(index, -1)}
                      disabled={disabled || index === 0}
                      aria-label={`Move line ${String(index + 1)} up`}
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      className="invoice-lines-editor__icon"
                      onClick={() => move(index, 1)}
                      disabled={disabled || index === drafts.length - 1}
                      aria-label={`Move line ${String(index + 1)} down`}
                    >
                      Down
                    </button>
                    <button
                      type="button"
                      className="invoice-lines-editor__icon invoice-lines-editor__icon--remove"
                      onClick={() => remove(index)}
                      disabled={disabled}
                      aria-label={`Remove line ${String(index + 1)}`}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="invoice-lines-editor__foot">
        <GhostButton
          label="Add line"
          onClick={() => onChange([...drafts, blankDraftLine()])}
          disabled={disabled}
        />
        <label className="invoice-lines-editor__field invoice-lines-editor__field--invoice-discount">
          <span className="invoice-lines-editor__label">Invoice discount ($), optional</span>
          <input
            className="invoice-lines-editor__input"
            inputMode="decimal"
            value={invoiceDiscountText}
            onChange={(e) => onInvoiceDiscountChange(e.target.value)}
            disabled={disabled}
            aria-label="Whole invoice discount in dollars"
          />
        </label>
      </div>

      <dl className="invoice-lines-editor__totals">
        <div>
          <dt>Subtotal</dt>
          <dd>{formatCentsUsd(preview.totals.subtotalCents)}</dd>
        </div>
        <div className="invoice-lines-editor__totals-total">
          <dt>Total</dt>
          <dd>{formatCentsUsd(preview.totals.totalCents)}</dd>
        </div>
      </dl>

      {/* Says what the running total does NOT yet include, rather than showing a
          confident figure that quietly leaves rows out. */}
      {preview.unreadable > 0 && (
        <p className="invoice-lines-editor__pending" role="status">
          {preview.unreadable === 1
            ? 'This total leaves out 1 line that still needs a quantity and a unit price.'
            : `This total leaves out ${String(preview.unreadable)} lines that still need a quantity and a unit price.`}
        </p>
      )}
      <p className="invoice-lines-editor__note">
        Totals are worked out from the lines. There is nowhere to type one, so the invoice can never
        say a different number from the work it lists.
      </p>
    </div>
  );
}
