// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  InvoiceLineItemsTable,
  InvoiceLineItemsEditor,
  parseDraftLines,
  blankDraftLine,
  draftFromLineItem,
  type DraftLine,
} from './InvoiceLineItems';

function draft(over: Partial<DraftLine> = {}): DraftLine {
  return { description: 'Dog walk', qtyText: '3', unitText: '25.00', discountText: '', ...over };
}

describe('parseDraftLines', () => {
  it('parses a sound set into cents', () => {
    const res = parseDraftLines([draft()], '');
    expect(res.error).toBeNull();
    expect(res.lines).toEqual([{ description: 'Dog walk', qty: 3, unitCents: 2500 }]);
    expect(res.invoiceDiscountCents).toBe(0);
  });

  it('omits discountCents entirely when there is no discount, rather than sending 0', () => {
    // Keeps the stored shape minimal and matches what the server's optional
    // field means: absent is "no discount", not "a discount of nothing".
    expect(parseDraftLines([draft()], '').lines![0]).not.toHaveProperty('discountCents');
  });

  it('carries a per-line discount through', () => {
    const res = parseDraftLines([draft({ discountText: '5.00' })], '');
    expect(res.lines![0]!.discountCents).toBe(500);
  });

  it('REFUSES the whole set when one price cannot be read, naming the row', () => {
    // Never partially salvaged. Dropping the bad row would quietly bill less
    // than the operator entered; submitting it as 0 would bill nothing for it.
    const res = parseDraftLines([draft(), draft({ description: 'Stay', unitText: '' })], '');
    expect(res.lines).toBeNull();
    expect(res.error).toContain('Stay');
    expect(res.error).toMatch(/dollar amount/i);
  });

  it('names the row by NUMBER when it has no description to name it by', () => {
    const res = parseDraftLines([draft({ description: '' })], '');
    expect(res.error).toContain('Line 1');
  });

  it('refuses a zero or unreadable quantity', () => {
    expect(parseDraftLines([draft({ qtyText: '0' })], '').error).toMatch(/greater than zero/i);
    expect(parseDraftLines([draft({ qtyText: 'two' })], '').error).toMatch(/greater than zero/i);
  });

  it('enforces the SERVER bounds client-side, as a courtesy that saves a round trip', () => {
    expect(parseDraftLines([draft({ qtyText: '1000' })], '').error).toMatch(/cannot be more than 999/i);
    expect(parseDraftLines([draft({ unitText: '100000.01' })], '').error).toMatch(/cannot be more than/i);
  });

  it('runs the same money validator the server does, so a bad discount is caught here', () => {
    const res = parseDraftLines([draft({ unitText: '10.00', qtyText: '1', discountText: '50.00' })], '');
    expect(res.error).toMatch(/larger than the line itself/i);
  });

  it('refuses an invoice discount larger than the subtotal', () => {
    expect(parseDraftLines([draft()], '999.00').error).toMatch(/larger than the subtotal/i);
  });

  it('treats a blank invoice discount as none, not as unreadable', () => {
    expect(parseDraftLines([draft()], '   ').invoiceDiscountCents).toBe(0);
  });

  it('parses an empty set as a legitimate empty itemization', () => {
    const res = parseDraftLines([], '');
    expect(res.error).toBeNull();
    expect(res.lines).toEqual([]);
  });
});

describe('draftFromLineItem', () => {
  it('round-trips a stored line back through the parser unchanged', () => {
    const original = { description: 'Stay', qty: 2.5, unitCents: 8000, discountCents: 500 };
    const res = parseDraftLines([draftFromLineItem(original)], '');
    expect(res.lines).toEqual([original]);
  });

  it('leaves the discount field blank when there is no discount', () => {
    expect(draftFromLineItem({ description: 'x', qty: 1, unitCents: 100 }).discountText).toBe('');
  });
});

describe('InvoiceLineItemsTable', () => {
  it('derives each line amount rather than showing a stored one', () => {
    render(<InvoiceLineItemsTable lines={[{ description: 'Walk', qty: 3, unitCents: 2500 }]} />);
    // 3 x $25.00. Scoped to the row, because the same figure legitimately
    // repeats as the subtotal and the total on a single-line invoice.
    const row = screen.getByText('Walk').closest('tr') as HTMLElement;
    expect(row.textContent).toContain('$75.00');
    expect(row.textContent).toContain('$25.00');
  });

  it('marks a line with no description as missing rather than showing a blank cell', () => {
    render(<InvoiceLineItemsTable lines={[{ description: '', qty: 1, unitCents: 100 }]} />);
    expect(screen.getByText('no description')).toBeInTheDocument();
  });

  it('renders qty without money-style decimals', () => {
    render(<InvoiceLineItemsTable lines={[{ description: 'Walk', qty: 3, unitCents: 2500 }]} />);
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});

describe('InvoiceLineItemsEditor', () => {
  it('has NOWHERE to type a total', () => {
    // The structural guarantee behind the whole feature: an operator cannot
    // enter a figure that disagrees with the work listed, because no such field
    // exists.
    render(
      <InvoiceLineItemsEditor
        drafts={[draft()]}
        onChange={vi.fn()}
        invoiceDiscountText=""
        onInvoiceDiscountChange={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText(/^total/i)).toBeNull();
    expect(screen.getByText(/there is nowhere to type one/i)).toBeInTheDocument();
  });

  it('shows a live total derived from the lines', () => {
    render(
      <InvoiceLineItemsEditor
        drafts={[draft(), draft({ description: 'Stay', qtyText: '1', unitText: '80.00' })]}
        onChange={vi.fn()}
        invoiceDiscountText=""
        onInvoiceDiscountChange={vi.fn()}
      />,
    );
    expect(screen.getByText('Total').nextElementSibling).toHaveTextContent('$155.00');
  });

  it('says what the running total LEAVES OUT instead of counting a half-typed row as zero', () => {
    render(
      <InvoiceLineItemsEditor
        drafts={[draft(), draft({ description: 'Stay', unitText: '' })]}
        onChange={vi.fn()}
        invoiceDiscountText=""
        onInvoiceDiscountChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/leaves out 1 line/i)).toBeInTheDocument();
    expect(screen.getByText('Total').nextElementSibling).toHaveTextContent('$75.00');
  });

  it('shows a pending row as needing input, NOT as $0.00', () => {
    // $0.00 would be indistinguishable from a line the operator meant to bill
    // nothing for, which is exactly the silent-zero failure this refuses.
    render(
      <InvoiceLineItemsEditor
        drafts={[draft({ unitText: '' })]}
        onChange={vi.fn()}
        invoiceDiscountText=""
        onInvoiceDiscountChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/amount needs a qty and a unit price/i)).toBeInTheDocument();
  });

  it('adds, removes and reorders rows', async () => {
    const onChange = vi.fn();
    const drafts = [draft({ description: 'First' }), draft({ description: 'Second' })];
    render(
      <InvoiceLineItemsEditor
        drafts={drafts}
        onChange={onChange}
        invoiceDiscountText=""
        onInvoiceDiscountChange={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /add line/i }));
    expect(onChange).toHaveBeenLastCalledWith([...drafts, blankDraftLine()]);

    await userEvent.click(screen.getByLabelText('Remove line 1'));
    expect(onChange).toHaveBeenLastCalledWith([drafts[1]]);

    await userEvent.click(screen.getByLabelText('Move line 2 up'));
    expect(onChange).toHaveBeenLastCalledWith([drafts[1], drafts[0]]);
  });

  it('cannot move the first row up or the last row down', () => {
    render(
      <InvoiceLineItemsEditor
        drafts={[draft(), draft()]}
        onChange={vi.fn()}
        invoiceDiscountText=""
        onInvoiceDiscountChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Move line 1 up')).toBeDisabled();
    expect(screen.getByLabelText('Move line 2 down')).toBeDisabled();
  });

  it('invites the first line rather than showing an empty table', () => {
    render(
      <InvoiceLineItemsEditor
        drafts={[]}
        onChange={vi.fn()}
        invoiceDiscountText=""
        onInvoiceDiscountChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/no line items yet/i)).toBeInTheDocument();
  });
});
