// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';
import type { Async } from '../lib/async';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    search,
    className,
    children,
  }: {
    to: string;
    search?: Record<string, string>;
    className?: string;
    children: ReactNode;
  }) => {
    const q = new URLSearchParams(search ?? {}).toString();
    return (
      <a href={q === '' ? to : `${to}?${q}`} className={className}>
        {children}
      </a>
    );
  },
}));

const useCollection = vi.fn();
vi.mock('../lib/firestore', async (orig) => ({
  ...(await orig<typeof import('../lib/firestore')>()),
  useCollection: (spec: unknown) => useCollection(spec),
}));

import {
  RecentKinTalesPanel,
  UpcomingVisitsPanel,
  HouseholdInvoicesPanel,
} from './KinfolkProfileFeeds';

function ready<T>(data: T[]): Async<T[]> {
  return { status: 'ready', data };
}

beforeEach(() => {
  useCollection.mockReset();
});

describe('RecentKinTalesPanel', () => {
  it('lists sent tales newest first, each linking to its own report', () => {
    useCollection.mockReturnValue(
      ready([
        { _id: 'r1', kinfolkId: 'k1', status: 'SENT', title: 'Trail day', bodyCopy: 'One stick.', sentAt: '2026-08-10T09:42:00Z' },
        { _id: 'r2', kinfolkId: 'k1', status: 'SENT', title: 'Bath day', bodyCopy: 'Tolerated it.', sentAt: '2026-08-01T09:00:00Z' },
        { _id: 'r3', kinfolkId: 'k1', status: 'DRAFT', title: 'Not sent', bodyCopy: '', sentAt: '' },
      ]),
    );
    render(<RecentKinTalesPanel kinfolkId="k1" />);

    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(2);
    expect(within(links[0] as HTMLElement).getByText('Trail day')).toBeInTheDocument();
    expect(links[0]).toHaveAttribute('href', '/kintales?kinTaleId=r1');
    expect(screen.queryByText('Not sent')).toBeNull();
  });

  it('counts only the sent ones, and says "total" while the read is under its cap', () => {
    useCollection.mockReturnValue(
      ready([
        { _id: 'r1', kinfolkId: 'k1', status: 'SENT', sentAt: '2026-08-10T09:00:00Z' },
        { _id: 'r2', kinfolkId: 'k1', status: 'DRAFT', sentAt: '' },
      ]),
    );
    render(<RecentKinTalesPanel kinfolkId="k1" />);
    expect(screen.getByText('1 total')).toBeInTheDocument();
  });

  /**
   * The subset trap: the card counts SENT tales, the cap applies to the raw
   * read. A read that came back holding every row it was allowed is truncated
   * however few of them were sent, so the meta must not call itself a total.
   */
  it('refuses to call a capped read a total, even when few of its rows are sent', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      _id: `r${i}`,
      kinfolkId: 'k1',
      status: i < 150 ? 'SENT' : 'DRAFT',
      sentAt: `2026-08-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
    }));
    useCollection.mockReturnValue(ready(rows));
    render(<RecentKinTalesPanel kinfolkId="k1" />);
    expect(screen.getByText('5 of 150+ loaded')).toBeInTheDocument();
  });
  it('says nothing about a count while the read is still in flight', () => {
    useCollection.mockReturnValue({ status: 'loading' });
    const { container } = render(<RecentKinTalesPanel kinfolkId="k1" />);
    expect(container.textContent).not.toMatch(/total/);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('surfaces a failed read fail-loud instead of an empty feed', () => {
    useCollection.mockReturnValue({ status: 'error', message: 'permission-denied' });
    render(<RecentKinTalesPanel kinfolkId="k1" />);
    expect(screen.getByRole('alert')).toHaveTextContent('permission-denied');
    expect(screen.queryByText(/No KinTales sent/i)).toBeNull();
  });

  it('says the household has none when the read really is empty', () => {
    useCollection.mockReturnValue(ready([]));
    render(<RecentKinTalesPanel kinfolkId="k1" />);
    expect(screen.getByText('No KinTales sent to this household yet.')).toBeInTheDocument();
  });
});

describe('UpcomingVisitsPanel', () => {
  const now = new Date('2026-08-17T12:00:00Z');

  it('shows the booked visits inside the window and links each to its session', () => {
    useCollection.mockReturnValue(
      ready([
        { _id: 's1', kinfolkId: 'k1', status: 'SCHEDULED', startTime: '2026-08-19T09:00:00Z', serviceType: 'Walk' },
        { _id: 's2', kinfolkId: 'k1', status: 'COMPLETED', startTime: '2026-08-20T09:00:00Z', serviceType: 'Walk' },
      ]),
    );
    render(<UpcomingVisitsPanel kinfolkId="k1" now={now} />);

    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/sessions?sessionId=s1');
    expect(screen.getByText('Walk')).toBeInTheDocument();
  });

  it('says how far ahead it is looking, and drops a visit beyond that', () => {
    useCollection.mockReturnValue(
      ready([{ _id: 'far', kinfolkId: 'k1', status: 'SCHEDULED', startTime: '2026-09-30T09:00:00Z' }]),
    );
    render(<UpcomingVisitsPanel kinfolkId="k1" now={now} />);
    expect(screen.getByText('next 7 days')).toBeInTheDocument();
    expect(screen.getByText('No visits booked in the next 7 days.')).toBeInTheDocument();
  });
});

describe('HouseholdInvoicesPanel', () => {
  function invoice(over: Record<string, unknown> = {}) {
    return {
      _id: 'i1',
      kinfolkId: 'k1',
      invoiceNumber: 'TT-2048',
      date: '2026-08-01',
      total: 280,
      amountDue: 0,
      status: 'paid',
      editScope: 'none',
      sessionIds: [],
      ...over,
    };
  }

  it('heads the card with what is really outstanding', () => {
    useCollection.mockReturnValue(
      ready([invoice(), invoice({ _id: 'i2', status: 'open', amountDue: 40, invoiceNumber: 'TT-2049' })]),
    );
    render(<HouseholdInvoicesPanel kinfolkId="k1" />);
    expect(screen.getByText('$40.00 outstanding')).toBeInTheDocument();
  });

  it('carries the state the server stamped, not a two-value paid/unpaid guess', () => {
    useCollection.mockReturnValue(
      ready([
        invoice({ _id: 'c', status: 'cancelled', invoiceNumber: 'TT-1', date: '2026-08-03' }),
        invoice({ _id: 'q', status: 'quote', invoiceNumber: 'TT-2', date: '2026-08-02' }),
        invoice({ _id: 'o', status: 'open', amountDue: 40, invoiceNumber: 'TT-3', date: '2026-08-01' }),
      ]),
    );
    render(<HouseholdInvoicesPanel kinfolkId="k1" />);
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.getByText('Quote')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    // A cancelled bill is never dressed up as paid.
    expect(screen.queryByText('Paid')).toBeNull();
  });

  it('shows the balance while one is owed and the total once it is settled', () => {
    useCollection.mockReturnValue(
      ready([
        invoice({ _id: 'o', status: 'open', amountDue: 40, total: 280, invoiceNumber: 'TT-3', date: '2026-08-02' }),
        invoice({ _id: 'p', status: 'paid', amountDue: 0, total: 280, invoiceNumber: 'TT-4', date: '2026-08-01' }),
      ]),
    );
    render(<HouseholdInvoicesPanel kinfolkId="k1" />);
    expect(screen.getByText('$40.00')).toBeInTheDocument();
    expect(screen.getByText('$280.00')).toBeInTheDocument();
  });

  it('links each row to the invoice it names', () => {
    useCollection.mockReturnValue(ready([invoice()]));
    render(<HouseholdInvoicesPanel kinfolkId="k1" />);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/invoices?invoiceId=i1');
    expect(screen.getByText('TT-2048 · Aug 1, 2026')).toBeInTheDocument();
  });
});
