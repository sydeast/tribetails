// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FirebaseError } from 'firebase/app';
import type { GetAccountCreditHistoryResult } from '../contracts/invoiceContracts.generated';

const api = vi.hoisted(() => ({ getAccountCreditHistory: vi.fn() }));
vi.mock('../api/invoicesApi', () => api);

import {
  CreditHistorySection,
  creditApplicationLines,
  creditStatusLine,
  creditUseLine,
  earlierCreditStatusLine,
} from './CreditHistorySection';

/**
 * Q6: the PRIMARY, and a secondary the PRIMARY granted billing, see each
 * credit's amount, date, reason and date applied. Everyone else sees nothing:
 * the server answers `permission-denied` and the section does not render.
 */

const SEP_27 = new Date(2026, 8, 27, 12).getTime();
const OCT_3 = new Date(2026, 9, 3, 12).getTime();

const HISTORY: GetAccountCreditHistoryResult = {
  ok: true as const,
  kinfolkId: 'fam1',
  accountBalanceCents: 1000,
  credits: [
    {
      creditId: 'crd_2',
      amountCents: 1000,
      reason: 'Goodwill',
      givenAtMs: OCT_3,
      remainingCents: 1000,
      fullyAppliedAtMs: null,
      applications: [],
    },
    {
      creditId: 'crd_1',
      amountCents: 2500,
      reason: 'Missed visit on Sept 12',
      givenAtMs: SEP_27,
      remainingCents: 0,
      fullyAppliedAtMs: OCT_3,
      applications: [{ appliedAtMs: OCT_3, amountCents: 2500, invoiceId: 'inv9', invoiceNumber: 'INV-1009' }],
    },
  ],
  uses: [{ useId: 'draw_p1', usedAtMs: OCT_3, amountCents: 2500, invoiceId: 'inv9', invoiceNumber: 'INV-1009' }],
  earlierCredit: null,
};

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <CreditHistorySection kinfolkId="fam1" />
    </QueryClientProvider>,
  );
}

// No mockReset here: under this Vitest, a reset mock that later returns a
// rejected promise reports the rejection as the test failure. Each test sets
// its own implementation, and clearMocks (vitest.config.ts) clears the calls.

describe('CreditHistorySection', () => {
  it('shows each credit with its amount, date given, reason and date applied', async () => {
    api.getAccountCreditHistory.mockResolvedValue(HISTORY);
    renderSection();
    expect(await screen.findByText('Account credit history')).toBeInTheDocument();
    expect(screen.getByText('$25.00')).toBeInTheDocument();
    expect(screen.getByText('Given Sep 27, 2026')).toBeInTheDocument();
    expect(screen.getByText('Missed visit on Sept 12')).toBeInTheDocument();
    expect(screen.getByText('Applied Oct 3, 2026')).toBeInTheDocument();
    expect(screen.getByText('Not used yet')).toBeInTheDocument();
    expect(screen.getByText('$25.00 on INV-1009, Oct 3, 2026')).toBeInTheDocument();
    expect(api.getAccountCreditHistory).toHaveBeenCalledWith('fam1');
  });

  it('renders nothing at all for someone without billing access, and asks only once', async () => {
    const denied = new FirebaseError('functions/permission-denied', 'Billing access is required.');
    api.getAccountCreditHistory.mockImplementation(() => Promise.reject(denied));
    const { container } = renderSection();
    await waitFor(() => expect(api.getAccountCreditHistory).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
    expect(api.getAccountCreditHistory).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when there is no history yet', async () => {
    api.getAccountCreditHistory.mockResolvedValue({ ...HISTORY, credits: [], uses: [] });
    const { container } = renderSection();
    await waitFor(() => expect(api.getAccountCreditHistory).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it('#1969: the walk household adds up: earlier credit less the uses is the balance', async () => {
    api.getAccountCreditHistory.mockResolvedValue({
      ...HISTORY,
      accountBalanceCents: 95_700,
      credits: [],
      uses: [
        { useId: 'd3', usedAtMs: OCT_3, amountCents: 300, invoiceId: 'i23', invoiceNumber: '1023' },
        { useId: 'd2', usedAtMs: OCT_3, amountCents: 500, invoiceId: 'i21', invoiceNumber: '1021' },
        { useId: 'd1', usedAtMs: OCT_3, amountCents: 105_000, invoiceId: 'i20', invoiceNumber: '1020' },
      ],
      earlierCredit: { amountCents: 201_500, remainingCents: 95_700 },
    });
    renderSection();
    const row = await screen.findByTestId('ch-earlier');
    expect(screen.getByText('Credits given')).toBeInTheDocument();
    expect(within(row).getByText('$2,015.00')).toBeInTheDocument();
    expect(within(row).getByText('Earlier credit')).toBeInTheDocument();
    expect(within(row).getByText('$1,058.00 of $2,015.00 applied')).toBeInTheDocument();
  });

  it('#1969: a balance with no events still shows, as earlier credit not used yet', async () => {
    api.getAccountCreditHistory.mockResolvedValue({
      ...HISTORY,
      credits: [],
      uses: [],
      earlierCredit: { amountCents: 4200, remainingCents: 4200 },
    });
    renderSection();
    expect(within(await screen.findByTestId('ch-earlier')).getByText('Not used yet')).toBeInTheDocument();
  });

  it('#1969: an older server with no earlierCredit key shows no earlier row', async () => {
    const { earlierCredit: _omit, ...old } = HISTORY;
    api.getAccountCreditHistory.mockResolvedValue(old);
    renderSection();
    expect(await screen.findByText('Account credit history')).toBeInTheDocument();
    expect(screen.queryByTestId('ch-earlier')).not.toBeInTheDocument();
  });

  it('says it could not load for any other failure', async () => {
    api.getAccountCreditHistory.mockImplementation(() => Promise.reject(new Error('offline')));
    renderSection();
    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent(
      'Could not load account credit history.',
    );
  });
});

describe('credit history lines', () => {
  it('a partly used credit says how much, with each use', () => {
    const c = {
      ...HISTORY.credits[0]!,
      remainingCents: 400,
      applications: [{ appliedAtMs: OCT_3, amountCents: 600, invoiceId: 'i', invoiceNumber: null }],
    };
    expect(creditStatusLine(c)).toBe('$6.00 of $10.00 applied');
    expect(creditApplicationLines(c)).toEqual(['$6.00 on an invoice with no number, Oct 3, 2026']);
    // #1848: a number stored blank is no number either.
    const blank = { ...c, applications: [{ ...c.applications[0]!, invoiceNumber: '' }] };
    expect(creditApplicationLines(blank)).toEqual(['$6.00 on an invoice with no number, Oct 3, 2026']);
    expect(creditUseLine({ useId: 'u', usedAtMs: OCT_3, amountCents: 600, invoiceId: 'inv_1731000000000_ab12cd', invoiceNumber: null })).toBe(
      '$6.00 on an invoice with no number, Oct 3, 2026',
    );
  });

  it('#1969: earlier credit reads Not used yet, part applied, or All applied', () => {
    expect(earlierCreditStatusLine({ amountCents: 4200, remainingCents: 4200 })).toBe('Not used yet');
    expect(earlierCreditStatusLine({ amountCents: 201_500, remainingCents: 95_700 })).toBe(
      '$1,058.00 of $2,015.00 applied',
    );
    expect(earlierCreditStatusLine({ amountCents: 4200, remainingCents: 0 })).toBe('All applied');
  });

  it('a use line names the invoice when it has a number', () => {
    expect(creditUseLine(HISTORY.uses[0]!)).toBe('$25.00 on INV-1009, Oct 3, 2026');
  });
});
