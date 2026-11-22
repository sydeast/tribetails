// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InvoiceBillingFacts, invoiceBillingFacts } from './InvoiceBillingFacts';

const base = { kinfolkName: 'Dre East', client: '', address: '', discount: '' };

describe('invoiceBillingFacts (#1899)', () => {
  it('shows nothing when none is set', () => {
    expect(invoiceBillingFacts(base)).toEqual([]);
  });

  it('lists a saved name, address and discount note, in that order', () => {
    expect(
      invoiceBillingFacts({ ...base, client: 'Sam Lee', address: ' 12 Oak St ', discount: 'Neighbor rate' }),
    ).toEqual([
      { label: 'Kinfolk', value: 'Sam Lee' },
      { label: 'Address', value: '12 Oak St' },
      { label: 'Discount note', value: 'Neighbor rate' },
    ]);
  });

  it('leaves out a name that only repeats the household', () => {
    expect(invoiceBillingFacts({ ...base, client: ' dre east ' })).toEqual([]);
  });

  it('reads an invoice with these fields absent as nothing to show', () => {
    expect(invoiceBillingFacts({})).toEqual([]);
  });

  it('renders each as a label and a value', () => {
    render(
      <dl>
        <InvoiceBillingFacts invoice={{ ...base, address: '12 Oak St' }} />
      </dl>,
    );
    expect(screen.getByText('Address')).toBeInTheDocument();
    expect(screen.getByText('12 Oak St')).toBeInTheDocument();
  });
});
