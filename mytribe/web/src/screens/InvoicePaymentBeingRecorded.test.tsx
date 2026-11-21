// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Invoices } from './Invoices';
import { InvoiceDetail } from './InvoiceDetail';
import {
  PAYMENT_BEING_RECORDED,
  PAYMENT_BEING_RECORDED_CODE,
  PAYMENT_CHECK_EVERY_MS,
  PAYMENT_CHECK_FOR_MS,
  paymentBeingRecorded,
} from '../lib/checkoutReturn';
import type { GetMyInvoicesResult } from '../contracts/invoiceContracts.generated';

/**
 * #2437: A PAYMENT ON THIS INVOICE HAS FINISHED AT STRIPE AND IS NOT RECORDED
 * YET, and the household presses Pay again from a screen that does not know:
 * a second window, a reload, or a return by hand. `payInvoice` opens no
 * checkout and answers with a sentence. Both screens put that sentence where
 * Pay was, once, and read the bill again until the payment shows.
 */

vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
  useParams: () => ({ invoiceId: 'inv-open-1' }),
}));

vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => 'kin-fam-1' }));

vi.mock('../lib/auth', async () => {
  const actual = await vi.importActual<typeof import('../lib/auth')>('../lib/auth');
  return {
    ...actual,
    useSignOut: () => ({ signOut: vi.fn(), signingOut: false }),
    useAuth: () => ({ status: 'signedIn', user: { uid: 'viewer-1' } }),
  };
});

const announceSaved = vi.fn();
vi.mock('../lib/saveNotice', async () => {
  const actual = await vi.importActual<typeof import('../lib/saveNotice')>('../lib/saveNotice');
  return { ...actual, announceSaved: (...args: unknown[]) => announceSaved(...args) };
});

const payInvoice = vi.fn();
const getMyInvoices = vi.fn();
vi.mock('../api/invoicesApi', async () => {
  const actual = await vi.importActual<typeof import('../api/invoicesApi')>('../api/invoicesApi');
  return {
    ...actual,
    getMyInvoices: (...args: unknown[]) => getMyInvoices(...args),
    payInvoice: (...args: unknown[]) => payInvoice(...args),
    getAccountCreditHistory: vi.fn().mockResolvedValue({ ok: true, kinfolkId: 'kin-fam-1', accountBalanceCents: 0, credits: [], uses: [] }),
  };
});

const CARD = { id: 'stripe', label: 'Pay with Credit Card', kind: 'checkout', url: null, instructions: null } as const;

vi.mock('../api/portal', () => ({
  getBusinessContact: vi.fn().mockResolvedValue({ name: 'Tribe Tails', address: '123 Main St', email: 'e2e-admin@tribetails.com' }),
  getMyHome: vi.fn().mockResolvedValue({
    kinfolkId: 'kin-fam-1',
    displayName: 'The Test Family',
    businessLogoUrl: '',
    businessName: 'Tribe Tails',
    portal: { logoUrl: '', themeId: 'default', banner: { enabled: false, message: '', tone: 'info', dismissMode: 'none', id: '' }, home: [], chat: { enabled: true, awayMessage: '', hoursEnabled: false, hours: {}, maxMessageLength: 2000, rateLimitPerHour: 0 } },
    bannerDismissedByUser: false,
    payMethods: [{ id: 'stripe', label: 'Pay with Credit Card', kind: 'checkout', url: null, instructions: null }],
  }),
}));

const OPEN_INVOICE: GetMyInvoicesResult['open'][number] = {
  id: 'inv-open-1',
  invoiceNumber: '1042',
  kinfolkId: 'kin-fam-1',
  kinfolkName: 'The Test Family',
  client: 'The Test Family',
  total: 50,
  amountDue: 50,
  isPaid: false,
  status: 'open',
  editScope: null,
  paidCents: 0,
  partiallyPaid: false,
  date: '2026-07-01',
  dueDate: '2026-07-15',
  discount: null,
  terms: null,
  paymentsHistory: null,
  address: null,
  viewed: true,
  quoteDecision: null,
  quoteDecidedAtMs: null,
  quoteDecidedByUid: null,
  quoteDecidedByName: null,
  creditAmountCents: null,
  creditTarget: null,
  creditRedeemedAtMs: null,
  writtenOffCents: null,
  payBlockedReason: null,
  payments: [],
  payMethods: [CARD],
};
const PAID_INVOICE: GetMyInvoicesResult['paid'][number] = { ...OPEN_INVOICE, amountDue: 0, isPaid: true, status: 'paid', paidCents: 5000, payMethods: [] };
const openRead = { open: [OPEN_INVOICE], paid: [], credits: [], accountBalanceCents: 0 };
const paidRead = { open: [], paid: [PAID_INVOICE], credits: [], accountBalanceCents: 0 };

/** The refusal as the Firebase SDK hands it to the screen: the server's message and its `details`. */
function refusal(over: { details?: unknown; message?: string } = {}) {
  return Object.assign(new Error(over.message ?? PAYMENT_BEING_RECORDED), {
    code: 'functions/failed-precondition',
    details: 'details' in over ? over.details : { code: PAYMENT_BEING_RECORDED_CODE },
  });
}

function show(screenUnderTest: 'list' | 'detail') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>{screenUnderTest === 'list' ? <Invoices /> : <InvoiceDetail />}</QueryClientProvider>,
  );
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

beforeEach(() => {
  cleanup();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  window.history.pushState({}, '', '/invoices/inv-open-1');
  payInvoice.mockReset();
  getMyInvoices.mockReset();
  getMyInvoices.mockResolvedValue(openRead);
  announceSaved.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('#2437: reading the refusal', () => {
  it('knows it by its code and gives back the server sentence', () => {
    expect(paymentBeingRecorded(refusal())).toBe(PAYMENT_BEING_RECORDED);
    expect(paymentBeingRecorded(refusal({ message: 'A payment is being recorded.' }))).toBe('A payment is being recorded.');
  });

  it('still knows it when the details were lost on the way and only the sentence arrived', () => {
    expect(paymentBeingRecorded(refusal({ details: undefined }))).toBe(PAYMENT_BEING_RECORDED);
  });

  it('is null for every other failure', () => {
    expect(paymentBeingRecorded(null)).toBeNull();
    expect(paymentBeingRecorded(undefined)).toBeNull();
    expect(paymentBeingRecorded(new Error('Network down'))).toBeNull();
    expect(
      paymentBeingRecorded(refusal({ details: { code: 'invoice_already_paid' }, message: 'This invoice is already paid, so it cannot take another payment.' })),
    ).toBeNull();
  });
});

describe('#2437: the invoice page', () => {
  it('puts the sentence where Pay was, once, with the check running, and never as a failure', async () => {
    payInvoice.mockRejectedValue(refusal());
    const user = show('detail');

    await user.click(await screen.findByRole('button', { name: 'Pay with Credit Card' }));

    expect(await screen.findByTestId('payment-being-recorded')).toHaveTextContent(PAYMENT_BEING_RECORDED);
    expect(screen.getAllByText(PAYMENT_BEING_RECORDED)).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Pay with Credit Card' })).toBeNull();
    // The wait is visible, and the invoice still reads as the server left it.
    expect(screen.getByText('Checking payment…')).toBeInTheDocument();
    expect(screen.getByText('PENDING')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't open checkout. Try again.")).toBeNull();
    expect(payInvoice).toHaveBeenCalledTimes(1);
  });

  it('reads the bill again until the webhook has marked it paid, then shows PAID and says so', async () => {
    payInvoice.mockRejectedValue(refusal());
    const user = show('detail');
    await user.click(await screen.findByRole('button', { name: 'Pay with Credit Card' }));
    await screen.findByTestId('payment-being-recorded');
    const readsBefore = getMyInvoices.mock.calls.length;
    getMyInvoices.mockResolvedValue(paidRead);

    await vi.advanceTimersByTimeAsync(PAYMENT_CHECK_EVERY_MS + 100);

    await waitFor(() => expect(screen.getByText('PAID')).toBeInTheDocument());
    expect(getMyInvoices.mock.calls.length).toBeGreaterThan(readsBefore);
    expect(screen.queryByTestId('payment-being-recorded')).toBeNull();
    expect(screen.queryByTestId('payment-check')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pay with Credit Card' })).toBeNull();
    expect(announceSaved).toHaveBeenCalledWith('Payment received');
  });

  it('when the payment has not shown in time, offers Pay again beside Check again, and the server decides again', async () => {
    payInvoice.mockRejectedValue(refusal());
    const user = show('detail');
    await user.click(await screen.findByRole('button', { name: 'Pay with Credit Card' }));
    await screen.findByTestId('payment-being-recorded');

    await vi.advanceTimersByTimeAsync(PAYMENT_CHECK_FOR_MS + 100);

    expect(await screen.findByTestId('payment-not-seen')).toHaveTextContent('This payment has not shown up yet.');
    expect(screen.queryByTestId('payment-being-recorded')).toBeNull();
    expect(screen.queryByText(PAYMENT_BEING_RECORDED)).toBeNull();
    // A second press goes to the server, which refuses again while the payment is unrecorded.
    await user.click(screen.getByRole('button', { name: 'Pay with Credit Card' }));
    expect(await screen.findByTestId('payment-being-recorded')).toHaveTextContent(PAYMENT_BEING_RECORDED);
    expect(payInvoice).toHaveBeenCalledTimes(2);
  });

  it('any other refusal is still printed as a failure, with Pay still offered', async () => {
    payInvoice.mockRejectedValue(
      refusal({ details: { code: 'invoice_cannot_take_payment' }, message: 'This invoice cannot take a payment right now. Please ask your Auntie to check it.' }),
    );
    const user = show('detail');

    await user.click(await screen.findByRole('button', { name: 'Pay with Credit Card' }));

    expect(await screen.findByText('This invoice cannot take a payment right now. Please ask your Auntie to check it.')).toBeInTheDocument();
    expect(screen.queryByTestId('payment-being-recorded')).toBeNull();
    expect(screen.queryByTestId('payment-check')).toBeNull();
    expect(screen.getByRole('button', { name: 'Pay with Credit Card' })).toBeInTheDocument();
  });
});

describe('#2437: the invoices list', () => {
  it('takes Pay now off the row and prints the sentence under it, once, with the check running', async () => {
    payInvoice.mockRejectedValue(refusal());
    const user = show('list');

    await user.click(await screen.findByRole('button', { name: /Pay now/ }));

    expect(await screen.findByTestId('payment-being-recorded')).toHaveTextContent(PAYMENT_BEING_RECORDED);
    expect(screen.getAllByText(PAYMENT_BEING_RECORDED)).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Pay now/ })).toBeNull();
    expect(screen.getByText('View')).toBeInTheDocument();
    expect(screen.getByText('Checking payment…')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't open checkout. Try again.")).toBeNull();
  });

  it('reads the list again until the payment shows, then says so', async () => {
    payInvoice.mockRejectedValue(refusal());
    const user = show('list');
    await user.click(await screen.findByRole('button', { name: /Pay now/ }));
    await screen.findByTestId('payment-being-recorded');
    const readsBefore = getMyInvoices.mock.calls.length;
    getMyInvoices.mockResolvedValue(paidRead);

    await vi.advanceTimersByTimeAsync(PAYMENT_CHECK_EVERY_MS + 100);

    await waitFor(() => expect(screen.queryByTestId('payment-being-recorded')).toBeNull());
    expect(getMyInvoices.mock.calls.length).toBeGreaterThan(readsBefore);
    expect(screen.queryByRole('button', { name: /Pay now/ })).toBeNull();
    expect(announceSaved).toHaveBeenCalledWith('Payment received');
  });

  it('when the payment has not shown in time, the row offers Pay now again and prints no failure', async () => {
    payInvoice.mockRejectedValue(refusal());
    const user = show('list');
    await user.click(await screen.findByRole('button', { name: /Pay now/ }));
    await screen.findByTestId('payment-being-recorded');

    await vi.advanceTimersByTimeAsync(PAYMENT_CHECK_FOR_MS + 100);

    expect(await screen.findByRole('button', { name: /Pay now/ })).toBeInTheDocument();
    expect(screen.queryByTestId('payment-being-recorded')).toBeNull();
    expect(screen.queryByText(PAYMENT_BEING_RECORDED)).toBeNull();
    expect(announceSaved).not.toHaveBeenCalled();
  });

  it('any other refusal is still printed as a failure under the row, with Pay now still offered', async () => {
    payInvoice.mockRejectedValue(new Error('This invoice is already paid, so it cannot take another payment.'));
    const user = show('list');

    await user.click(await screen.findByRole('button', { name: /Pay now/ }));

    expect(await screen.findByText('This invoice is already paid, so it cannot take another payment.')).toBeInTheDocument();
    expect(screen.queryByTestId('payment-being-recorded')).toBeNull();
    expect(screen.getByRole('button', { name: /Pay now/ })).toBeInTheDocument();
  });
});

describe('#2437: a portal build from before this change', () => {
  it('printed whatever message the refusal carried, so it prints this sentence', async () => {
    // What an installed page does with it: `errorLine` prints the error's own
    // message. The sentence is that message, so no new code is needed to read it.
    const { errorLine } = await import('../lib/mutationState');
    const failed = { isPending: false, isPaused: false, isError: true, error: refusal() };
    expect(errorLine(failed, "Couldn't open checkout. Try again.")).toBe(PAYMENT_BEING_RECORDED);
  });
});
