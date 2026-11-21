// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Invoices } from './Invoices';
import type { GetMyInvoicesResult } from '../contracts/invoiceContracts.generated';
import { SaveNoticeLine } from '../components/SaveNotice';

/**
 * The payInvoice and redeemCredit mutations had no onError handler, so a
 * rejected callable just stopped the button spinner with nothing telling the
 * kinfolk why (the same "swallowed error" bug InvoiceDetail and KinTales'
 * comment-post had before they were fixed). These pin that each surfaces a
 * distinct, visible message.
 */

// #1381: the business footnote reads the name from getMyHome; no network in a unit test.
vi.mock('../api/portal', () => ({ getMyHome: vi.fn().mockResolvedValue({ businessName: '' }) }));
vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => <a {...props}>{children}</a>,
  useNavigate: () => vi.fn(),
}));

vi.mock('../lib/activeTribe', () => ({
  getActiveKinfolkId: () => 'kin-fam-1',
}));

// #1039: the row-level "declined this" wording compares the stored actor
// with the signed-in viewer, so the viewer is a fixture here.
const authState = vi.hoisted(() => ({ uid: 'viewer-1' }));
vi.mock('../lib/auth', () => ({
  useSignOut: () => ({ signOut: vi.fn(), signingOut: false }),
  useAuth: () => ({ status: 'signedIn', user: { uid: authState.uid } }),
}));

const payInvoice = vi.fn();
const redeemCredit = vi.fn();

vi.mock('../api/invoicesApi', async () => {
  const actual = await vi.importActual<typeof import('../api/invoicesApi')>('../api/invoicesApi');
  return {
    ...actual,
    getMyInvoices: vi.fn(),
    payInvoice: (...args: unknown[]) => payInvoice(...args),
    redeemCredit: (...args: unknown[]) => redeemCredit(...args),
    // Q6: covered by CreditHistorySection.test.tsx; empty here.
    getAccountCreditHistory: vi.fn().mockResolvedValue({ ok: true, kinfolkId: 'kin-fam-1', accountBalanceCents: 0, credits: [], uses: [] }),
  };
});

const OPEN_INVOICE: GetMyInvoicesResult['open'][number] = {
  id: 'inv-open-1', invoiceNumber: '1042',
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
  subtotalCents: null,
  invoiceDiscountCents: null,
  // #2410: null on an invoice that can be paid.
  payBlockedReason: null,
  // Issue #409: how this bill can be paid, resolved server-side off the
  // options it was issued with. The card needs nothing configured, so a
  // believable invoice always carries at least this one.
  payMethods: [{ id: 'stripe', label: 'Pay with Credit Card', kind: 'checkout', url: null, instructions: null }],
};

const CREDIT_INVOICE: GetMyInvoicesResult['credits'][number] = {
  ...OPEN_INVOICE,
  status: 'credit',
  creditAmountCents: 2000,
  creditRedeemedAtMs: null,
  writtenOffCents: null,
  subtotalCents: null,
  invoiceDiscountCents: null,
  // Issue #409: how this bill can be paid, resolved server-side off the
  // options it was issued with. The card needs nothing configured, so a
  // believable invoice always carries at least this one.
  payMethods: [{ id: 'stripe', label: 'Pay with Credit Card', kind: 'checkout', url: null, instructions: null }],
};

describe('Invoices — mutation error surfacing', () => {
  it('pay failure shows a visible error instead of just stopping the spinner', async () => {
    const invoicesApi = await import('../api/invoicesApi');
    vi.mocked(invoicesApi.getMyInvoices).mockResolvedValue({
      open: [OPEN_INVOICE],
      paid: [],
      credits: [],
      accountBalanceCents: 0,
    });
    payInvoice.mockRejectedValue(new Error('Card declined by Stripe.'));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <Invoices />
      </QueryClientProvider>,
    );

    const payButton = await screen.findByRole('button', { name: /Pay now/ });
    await userEvent.click(payButton);

    await waitFor(() => expect(screen.getByText('Card declined by Stripe.')).toBeInTheDocument());
  });

  it('credit redemption failure shows a visible error instead of just stopping the spinner', async () => {
    const invoicesApi = await import('../api/invoicesApi');
    vi.mocked(invoicesApi.getMyInvoices).mockResolvedValue({
      open: [],
      paid: [],
      credits: [CREDIT_INVOICE],
      accountBalanceCents: 0,
    });
    redeemCredit.mockRejectedValue(new Error('Credit already redeemed.'));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <Invoices />
      </QueryClientProvider>,
    );

    const redeemButton = await screen.findByRole('button', { name: /Save to Account Balance/ });
    await userEvent.click(redeemButton);

    await waitFor(() => expect(screen.getByText('Credit already redeemed.')).toBeInTheDocument());
  });
});
describe('Invoices: a PAID invoice has no Pay now button (docket Q5)', () => {
  async function renderWith(res: GetMyInvoicesResult) {
    const invoicesApi = await import('../api/invoicesApi');
    vi.mocked(invoicesApi.getMyInvoices).mockResolvedValue(res);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <Invoices />
      </QueryClientProvider>,
    );
  }
  it('a paid row in the open bucket, balance still showing, carries no Pay now', async () => {
    await renderWith({
      open: [{ ...OPEN_INVOICE, id: 'inv-stale', isPaid: true, amountDue: 40 }],
      paid: [{ ...OPEN_INVOICE, id: 'inv-paid', status: 'paid', isPaid: true, amountDue: 0 }],
      credits: [],
      accountBalanceCents: 0,
    });
    expect(await screen.findAllByText(/The Test Family/)).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Pay now/ })).toBeNull();
    expect(payInvoice).not.toHaveBeenCalled();
  });
  it('an open row still does', async () => {
    await renderWith({ open: [OPEN_INVOICE], paid: [], credits: [], accountBalanceCents: 0 });
    expect(await screen.findByRole('button', { name: /Pay now/ })).toBeInTheDocument();
  });
  // #2090: a written-off invoice sits in the history, says so, and asks for nothing.
  it('a written-off row reads Written off, nothing to pay, with no Pay now and no Receipt', async () => {
    await renderWith({
      open: [],
      paid: [{ ...OPEN_INVOICE, id: 'inv-wo', status: 'written_off', amountDue: 0, writtenOffCents: 5000, payMethods: [] }],
      credits: [],
      accountBalanceCents: 0,
    });
    expect(await screen.findByText('WRITTEN OFF')).toBeInTheDocument();
    expect(screen.getAllByText('Written off, nothing to pay').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Pay now/ })).toBeNull();
    expect(screen.queryByText('Receipt')).toBeNull();
    expect(screen.queryByText('PAID')).toBeNull();
  });
});
// #1039: a SECONDARY with billing access can decline a quote too
// (D-2026-09-28-BILLING-ACCESS-PAYS), so the row names whoever did.
describe('Invoices: a declined quote row names who declined it (#1039)', () => {
  async function renderQuote(by: { uid: string | null; name: string | null }) {
    const invoicesApi = await import('../api/invoicesApi');
    vi.mocked(invoicesApi.getMyInvoices).mockResolvedValue({
      open: [
        {
          ...OPEN_INVOICE,
          id: 'q1',
          status: 'quote',
          quoteDecision: 'denied',
          quoteDecidedAtMs: 1_755_000_000_000,
          quoteDecidedByUid: by.uid,
          quoteDecidedByName: by.name,
        },
      ],
      paid: [],
      credits: [],
      accountBalanceCents: 0,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <Invoices />
      </QueryClientProvider>,
    );
  }
  it('says "You declined this" to the person who declined it', async () => {
    await renderQuote({ uid: 'viewer-1', name: 'Alicia' });
    expect(await screen.findByText('You declined this')).toBeInTheDocument();
  });
  it('names the household member who declined it to everyone else', async () => {
    await renderQuote({ uid: 'secondary-1', name: 'Sam' });
    expect(await screen.findByText('Sam declined this')).toBeInTheDocument();
    expect(screen.queryByText('You declined this')).toBeNull();
  });
  it('reads a bare "Declined" when no name was stored for someone else', async () => {
    await renderQuote({ uid: 'secondary-1', name: null });
    expect(await screen.findByText('Declined')).toBeInTheDocument();
    expect(screen.queryByText(/declined this/)).toBeNull();
  });
});
// #1294: credit is admin-chosen and only counts once it is saved, so nothing
// on this screen may say a credit was applied automatically.
describe('Invoices: the balance hero says which number can be spent (#1294)', () => {
  async function renderWith(res: GetMyInvoicesResult) {
    const invoicesApi = await import('../api/invoicesApi');
    vi.mocked(invoicesApi.getMyInvoices).mockResolvedValue(res);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <Invoices />
      </QueryClientProvider>,
    );
  }
  // #1872: after the admin applies $25.00 of a $120.00 balance to a $100.00
  // invoice, the server returns one payload. The balance, the part-paid line,
  // the pay button and the open total must all read from it and agree.
  it('agrees with itself after an admin applies credit to an open invoice', async () => {
    await renderWith({
      open: [{ ...OPEN_INVOICE, total: 100, amountDue: 75, paidCents: 2500, partiallyPaid: true }],
      paid: [],
      credits: [],
      accountBalanceCents: 9500,
    });
    expect(await screen.findByText('ACCOUNT BALANCE')).toBeInTheDocument();
    // $120.00 less the $25.00 applied.
    expect(screen.getByText('$95.00')).toBeInTheDocument();
    // The invoice says what was paid, and asks only for what is left.
    expect(screen.getByText('$25.00 of $100.00 paid')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Pay now/ })).toBeInTheDocument();
    expect(screen.getAllByText('$75.00').length).toBeGreaterThan(0);
    expect(screen.queryByText('$100.00')).toBeNull();
  });

  it('shows the invoice as paid and the rest of the balance once credit covers it', async () => {
    await renderWith({
      open: [],
      paid: [{ ...OPEN_INVOICE, total: 100, amountDue: 0, paidCents: 10000, isPaid: true, status: 'paid' }],
      credits: [],
      accountBalanceCents: 2000,
    });
    expect(await screen.findByText('ACCOUNT BALANCE')).toBeInTheDocument();
    expect(screen.getByText('$20.00')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pay now/ })).toBeNull();
  });

  it('drops the AUTO APPLIED chip and labels an unsaved credit as waiting', async () => {
    await renderWith({ open: [], paid: [], credits: [CREDIT_INVOICE], accountBalanceCents: 1500 });
    expect(await screen.findByText('ACCOUNT BALANCE')).toBeInTheDocument();
    expect(screen.queryByText(/AUTO APPLIED/i)).toBeNull();
    expect(screen.getByText('What you can spend. Your Auntie applies it to an invoice for you.')).toBeInTheDocument();
    // #1872: credit is never spent automatically, so nothing here may say it is.
    expect(screen.queryByText(/next invoice|automatically/i)).toBeNull();
    expect(screen.getByText('Credits to save')).toBeInTheDocument();
    expect(screen.getByText(/Save it to your account balance to spend it\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save to Account Balance/ })).toBeInTheDocument();
  });
  it('shows no waiting-credit cell once every credit is saved', async () => {
    await renderWith({
      open: [],
      paid: [],
      credits: [{ ...CREDIT_INVOICE, creditRedeemedAtMs: 1_760_000_000_000, creditTarget: 'accountBalance' }],
      accountBalanceCents: 3500,
    });
    expect(await screen.findByText('ACCOUNT BALANCE')).toBeInTheDocument();
    expect(screen.queryByText('Credits to save')).toBeNull();
    expect(screen.queryByText(/AUTO APPLIED/i)).toBeNull();
  });
});
// #1330: a paid history that spans New Year must say which year each is.
describe('Invoices: paid dates carry the year (#1330)', () => {
  it('prints "Paid Dec 17, 2025", not "Paid Dec 17"', async () => {
    const invoicesApi = await import('../api/invoicesApi');
    vi.mocked(invoicesApi.getMyInvoices).mockResolvedValue({
      open: [],
      paid: [{ ...OPEN_INVOICE, id: 'inv-dec', status: 'paid', isPaid: true, amountDue: 0, date: '2025-12-17' }],
      credits: [],
      accountBalanceCents: 0,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <Invoices />
      </QueryClientProvider>,
    );
    expect((await screen.findAllByText(/Paid Dec 17, 2025/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Paid Dec 17$/)).toBeNull();
  });
});

/**
 * #1281 (F50): "Save to Account Balance" showed Working… for about 12s, then
 * went back to the button with the balance unchanged. The credit had applied;
 * the list was stale, and households pressed again. The button now stays busy
 * until the reloaded list shows the credit, and the save is confirmed in words.
 */
describe('Invoices — #1281 a credit save waits for the fresh list', () => {
  it('stays on Working… until the reloaded list arrives, then shows the new balance and "Credit saved"', async () => {
    const invoicesApi = await import('../api/invoicesApi');
    let answer!: (r: GetMyInvoicesResult) => void;
    vi.mocked(invoicesApi.getMyInvoices)
      .mockReset()
      .mockResolvedValueOnce({ open: [], paid: [], credits: [CREDIT_INVOICE], accountBalanceCents: 0 })
      .mockReturnValueOnce(new Promise((r) => { answer = r; }));
    redeemCredit.mockReset().mockResolvedValue({ ok: true, redeemedAmountCents: 2000, target: 'accountBalance', newAccountBalanceCents: 2000 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <SaveNoticeLine />
        <Invoices />
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: /Save to Account Balance/ }));
    await waitFor(() => expect(redeemCredit).toHaveBeenCalledTimes(1));
    // The credit applied, but the list has not come back: still busy, not reset.
    expect(await screen.findByRole('button', { name: 'Working…' })).toBeDisabled();
    expect(screen.queryByText('Credit saved')).toBeNull();
    answer({
      open: [],
      paid: [],
      credits: [{ ...CREDIT_INVOICE, creditRedeemedAtMs: 1_780_000_000_000, creditTarget: 'accountBalance' }],
      accountBalanceCents: 2000,
    });
    expect(await screen.findByText('Credit saved')).toBeInTheDocument();
    expect(document.querySelector('.bnum')?.textContent).toBe('$20.00');
    expect(screen.queryByRole('button', { name: /Save to Account Balance/ })).toBeNull();
    expect(redeemCredit).toHaveBeenCalledTimes(1);
  });
});
/**
 * #2400: "Pay now" on a list row started its own checkout and sent Stripe the
 * bare invoice page for both return addresses, with no checkout key. A
 * household who paid from the list came back with no marker, so no payment
 * check ran: a live Pay button and nothing saying a payment was on its way,
 * for the seconds the card webhook takes to land.
 */
describe('Invoices: Pay now sends the same return addresses and checkout key as the invoice page (#2400)', () => {
  const KEY = /^chk_\d{10,16}_[a-z0-9]{1,16}$/;
  const SECOND: GetMyInvoicesResult['open'][number] = { ...OPEN_INVOICE, id: 'inv-open-2', client: 'The Second Bill' };
  async function renderList(open: GetMyInvoicesResult['open']) {
    const invoicesApi = await import('../api/invoicesApi');
    vi.mocked(invoicesApi.getMyInvoices).mockReset().mockResolvedValue({ open, paid: [], credits: [], accountBalanceCents: 0 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <Invoices />
      </QueryClientProvider>,
    );
  }
  beforeEach(() => {
    payInvoice.mockReset();
  });
  it('comes back to the invoice with the marker on success, and to the bare invoice on cancel', async () => {
    payInvoice.mockRejectedValue(new Error('stop before the redirect'));
    await renderList([OPEN_INVOICE]);
    await userEvent.click(await screen.findByRole('button', { name: /Pay now/ }));
    await waitFor(() => expect(payInvoice).toHaveBeenCalledTimes(1));
    const [invoiceId, successUrl, cancelUrl, kinfolkId, key] = payInvoice.mock.calls[0]!;
    expect(invoiceId).toBe('inv-open-1');
    expect(successUrl).toBe(`${window.location.origin}/invoices/inv-open-1?checkout=done`);
    expect(cancelUrl).toBe(`${window.location.origin}/invoices/inv-open-1`);
    expect(kinfolkId).toBe('kin-fam-1');
    expect(key).toMatch(KEY);
  });
  it('writes the invoice id into the address encoded', async () => {
    payInvoice.mockRejectedValue(new Error('stop before the redirect'));
    await renderList([{ ...OPEN_INVOICE, id: 'INV 2027/1' }]);
    await userEvent.click(await screen.findByRole('button', { name: /Pay now/ }));
    await waitFor(() => expect(payInvoice).toHaveBeenCalledTimes(1));
    expect(payInvoice.mock.calls[0]![1]).toBe(`${window.location.origin}/invoices/INV%202027%2F1?checkout=done`);
    expect(payInvoice.mock.calls[0]![2]).toBe(`${window.location.origin}/invoices/INV%202027%2F1`);
  });
  it('holds one checkout key across a re-tap after a failure', async () => {
    payInvoice.mockRejectedValue(new Error('Card declined by Stripe.'));
    await renderList([OPEN_INVOICE]);
    await userEvent.click(await screen.findByRole('button', { name: /Pay now/ }));
    await waitFor(() => expect(payInvoice).toHaveBeenCalledTimes(1));
    await userEvent.click(await screen.findByRole('button', { name: /Pay now/ }));
    await waitFor(() => expect(payInvoice).toHaveBeenCalledTimes(2));
    const firstKey = payInvoice.mock.calls[0]![4];
    expect(firstKey).toMatch(KEY);
    expect(payInvoice.mock.calls[1]![4]).toBe(firstKey);
  });
  it("never carries one invoice's key to another invoice's checkout", async () => {
    payInvoice.mockRejectedValue(new Error('Card declined by Stripe.'));
    await renderList([OPEN_INVOICE, SECOND]);
    const buttons = await screen.findAllByRole('button', { name: /Pay now/ });
    expect(buttons).toHaveLength(2);
    await userEvent.click(buttons[0]!);
    await waitFor(() => expect(payInvoice).toHaveBeenCalledTimes(1));
    await userEvent.click((await screen.findAllByRole('button', { name: /Pay now/ }))[1]!);
    await waitFor(() => expect(payInvoice).toHaveBeenCalledTimes(2));
    await userEvent.click((await screen.findAllByRole('button', { name: /Pay now/ }))[0]!);
    await waitFor(() => expect(payInvoice).toHaveBeenCalledTimes(3));
    const [first, second, firstAgain] = payInvoice.mock.calls.map((c) => ({ id: c[0], key: c[4] }));
    expect(first!.id).toBe('inv-open-1');
    expect(second!.id).toBe('inv-open-2');
    expect(second!.key).toMatch(KEY);
    expect(second!.key).not.toBe(first!.key);
    // The first bill's own key was kept for its own re-tap.
    expect(firstAgain!.id).toBe('inv-open-1');
    expect(firstAgain!.key).toBe(first!.key);
  });
  it('drops the key once a checkout has opened, so a later payment mints a new one', async () => {
    // No address to go to, so the test stays on the page; the key is dropped all the same.
    payInvoice.mockResolvedValue({ checkoutUrl: '', sessionId: 'cs_test_1', amountCents: 5000, currency: 'usd' });
    await renderList([OPEN_INVOICE]);
    await userEvent.click(await screen.findByRole('button', { name: /Pay now/ }));
    await waitFor(() => expect(payInvoice).toHaveBeenCalledTimes(1));
    await userEvent.click(await screen.findByRole('button', { name: /Pay now/ }));
    await waitFor(() => expect(payInvoice).toHaveBeenCalledTimes(2));
    expect(payInvoice.mock.calls[1]![4]).toMatch(KEY);
    expect(payInvoice.mock.calls[1]![4]).not.toBe(payInvoice.mock.calls[0]![4]);
  });
});

/**
 * #1848: every row names its invoice by the number a Kinfolk can quote. The
 * stored id (`inv_<13 digits>_<6 characters>`) used to stand after the "#".
 */
describe('Invoices: a row prints the invoice number, never the stored id (#1848)', () => {
  const ID = 'inv_1731000000000_ab12cd';
  async function renderWith(res: GetMyInvoicesResult) {
    const invoicesApi = await import('../api/invoicesApi');
    vi.mocked(invoicesApi.getMyInvoices).mockResolvedValue(res);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <Invoices />
      </QueryClientProvider>,
    );
  }
  const noIdOnScreen = () => expect(document.body.textContent ?? '').not.toContain(ID);

  it('an open row', async () => {
    await renderWith({ open: [{ ...OPEN_INVOICE, id: ID, invoiceNumber: '1042' }], paid: [], credits: [], accountBalanceCents: 0 });
    expect(await screen.findByText(/^Invoice #1042 · /)).toBeInTheDocument();
    noIdOnScreen();
  });

  it('an open row with no number', async () => {
    await renderWith({ open: [{ ...OPEN_INVOICE, id: ID, invoiceNumber: null }], paid: [], credits: [], accountBalanceCents: 0 });
    expect(await screen.findByText(/^Invoice with no number · /)).toBeInTheDocument();
    noIdOnScreen();
  });

  it('an open row with no client name takes the invoice name as its title', async () => {
    await renderWith({
      open: [{ ...OPEN_INVOICE, id: ID, invoiceNumber: '1042', client: null }],
      paid: [],
      credits: [],
      accountBalanceCents: 0,
    });
    expect(await screen.findByText('Invoice #1042')).toBeInTheDocument();
    noIdOnScreen();
  });

  it('a quote row', async () => {
    await renderWith({
      open: [{ ...OPEN_INVOICE, id: ID, invoiceNumber: 'Q-7', status: 'quote' }],
      paid: [],
      credits: [],
      accountBalanceCents: 0,
    });
    expect(await screen.findByText(/^Quote #Q-7/)).toBeInTheDocument();
    noIdOnScreen();
  });

  it('a paid row, with and without a number', async () => {
    await renderWith({
      open: [],
      paid: [
        { ...OPEN_INVOICE, id: ID, invoiceNumber: '1042', status: 'paid', isPaid: true, amountDue: 0 },
        { ...OPEN_INVOICE, id: `${ID}2`, invoiceNumber: null, status: 'paid', isPaid: true, amountDue: 0 },
      ],
      credits: [],
      accountBalanceCents: 0,
    });
    expect(await screen.findByText(/^Invoice #1042 · /)).toBeInTheDocument();
    expect(screen.getByText(/^Invoice with no number · /)).toBeInTheDocument();
    noIdOnScreen();
  });

  it('a row in the CREDITS panel, with and without a number', async () => {
    await renderWith({
      open: [],
      paid: [],
      credits: [
        { ...CREDIT_INVOICE, id: ID, invoiceNumber: '1042' },
        { ...CREDIT_INVOICE, id: `${ID}2`, invoiceNumber: null },
      ],
      accountBalanceCents: 0,
    });
    expect(await screen.findByText(/^Invoice #1042\. /)).toBeInTheDocument();
    expect(screen.getByText(/^Invoice with no number\. /)).toBeInTheDocument();
    noIdOnScreen();
  });
});
