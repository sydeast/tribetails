// @vitest-environment jsdom
import { type ReactNode } from 'react';
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

/**
 * The router's `Link`, rendered as the anchor it becomes. Same stub the rest of
 * this suite uses (`Invites.test.tsx`, `HouseholdMembers.test.tsx`): these
 * components are unit-rendered without a router, and the assertion worth making
 * is WHERE the link points.
 */
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    search,
    children,
    ...rest
  }: {
    to: string;
    search?: Record<string, string>;
    children: ReactNode;
  }) => (
    <a href={search ? `${to}?${new URLSearchParams(search).toString()}` : to} {...rest}>
      {children}
    </a>
  ),
}));

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

/**
 * #408: a line drawn from a visit is BOUND to it. Editing the money means
 * editing the visit, and the invoice follows, so the row offers the route to
 * the visit rather than fields to type over its price with.
 */
describe('bound line items', () => {
  it('carries the binding through a parse, so an edit cannot cut it loose', () => {
    // `lineItems` is replaced wholesale by updateInvoice's patch. A parse that
    // dropped this would unbind every line on any invoice the operator edited.
    const res = parseDraftLines([draft({ sessionId: 'vis_1' })], '');
    expect(res.lines![0]!.sessionId).toBe('vis_1');
  });
  it('keeps the binding when a stored line is opened for editing', () => {
    const d = draftFromLineItem({ description: 'Dog walk', qty: 1, unitCents: 2500, sessionId: 'vis_1' });
    expect(d.sessionId).toBe('vis_1');
  });
  it('leaves a hand-typed line unbound rather than inventing an empty binding', () => {
    expect(draftFromLineItem({ description: 'Mileage', qty: 1, unitCents: 1000 })).not.toHaveProperty(
      'sessionId',
    );
    expect(parseDraftLines([draft()], '').lines![0]).not.toHaveProperty('sessionId');
  });
  it('shows a bound row read-only, with the route to its visit', () => {
    render(
      <InvoiceLineItemsEditor
        drafts={[draft({ sessionId: 'vis_1' })]}
        onChange={vi.fn()}
        invoiceDiscountText=""
        onInvoiceDiscountChange={vi.fn()}
      />,
    );
    // No fields to type over the visit's money with.
    expect(screen.queryByLabelText('Line 1 unit price in dollars')).toBeNull();
    expect(screen.queryByLabelText('Line 1 description')).toBeNull();
    expect(screen.getByRole('link', { name: /open this visit/i })).toHaveAttribute(
      'href',
      '/sessions?sessionId=vis_1',
    );
    expect(screen.getByText(/its price is the visit's/i)).toBeInTheDocument();
  });
  it('still lets a bound line be taken OFF the invoice', async () => {
    // Removing work from an invoice is a different decision from rewriting what
    // that work cost, and only the second one belongs to the visit.
    const onChange = vi.fn();
    render(
      <InvoiceLineItemsEditor
        drafts={[draft({ sessionId: 'vis_1' })]}
        onChange={onChange}
        invoiceDiscountText=""
        onInvoiceDiscountChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /remove line 1/i }));
    expect(onChange).toHaveBeenCalledWith([]);
  });
  it('offers the same route from the read-only table', () => {
    render(
      <InvoiceLineItemsTable
        lines={[
          { description: 'Dog walk', qty: 1, unitCents: 2500, sessionId: 'vis_1' },
          { description: 'Mileage', qty: 1, unitCents: 1000 },
        ]}
      />,
    );
    const links = screen.getAllByRole('link', { name: /open this visit/i });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/sessions?sessionId=vis_1');
  });
  it('takes a caller\'s own empty hint, so extra charges do not read as "nothing was billed"', () => {
    render(
      <InvoiceLineItemsEditor
        drafts={[]}
        onChange={vi.fn()}
        invoiceDiscountText=""
        onInvoiceDiscountChange={vi.fn()}
        emptyHint="No extra charges."
      />,
    );
    expect(screen.getByText('No extra charges.')).toBeInTheDocument();
  });
});
