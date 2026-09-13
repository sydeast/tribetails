// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { SLOW_WAIT_MS } from '../lib/slowWait';
import { InvoiceDetail } from './InvoiceDetail';

/**
 * #807 on the screen that matters most, with the REAL pause rather than a
 * stubbed one.
 *
 * What this proves that `mutationState.test.ts` cannot. That spec settles the
 * decision table as arithmetic. It says nothing about whether a mutation on a
 * real screen, with a real `QueryClient` and `onlineManager` driven offline,
 * actually reaches those phases — which depends on React Query's own pause
 * (`retryer.js` `canStart()` → `mutation.js:87`) for the HELD write and on the
 * preflight in `usePortalMutation` for the ABANDONED one. If either stopped
 * working this spec would stop testing anything, and would say so: the redeem
 * case asserts the callable was never invoked, and the pay case asserts the
 * same.
 *
 * The two cases are deliberately the two POLICIES, on one screen, at once:
 *
 *   redeemCredit   HOLD. Guarded by a Firestore transaction, so a late arrival
 *                  is safe. It must read as queued, not as saving.
 *   payInvoice     ABANDON. A non-idempotent create at the Stripe end, and a
 *                  redirect on success. It must be refused outright and must
 *                  NOT be offered a re-send, at any point, however long the
 *                  wait runs.
 */

const mocks = vi.hoisted(() => ({
  getMyInvoices: vi.fn(),
  payInvoice: vi.fn(),
  redeemCredit: vi.fn(),
  getMyInvoicePdf: vi.fn(),
  acceptQuote: vi.fn(),
  denyQuote: vi.fn(),
  getMyHome: vi.fn(),
  getBusinessContact: vi.fn(),
}));

vi.mock('../api/invoicesApi', () => ({
  getMyInvoices: (...a: unknown[]) => mocks.getMyInvoices(...a),
  payInvoice: (...a: unknown[]) => mocks.payInvoice(...a),
  redeemCredit: (...a: unknown[]) => mocks.redeemCredit(...a),
  getMyInvoicePdf: (...a: unknown[]) => mocks.getMyInvoicePdf(...a),
  acceptQuote: (...a: unknown[]) => mocks.acceptQuote(...a),
  denyQuote: (...a: unknown[]) => mocks.denyQuote(...a),
}));
vi.mock('../api/portal', () => ({
  getMyHome: (...a: unknown[]) => mocks.getMyHome(...a),
  getBusinessContact: (...a: unknown[]) => mocks.getBusinessContact(...a),
}));
vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => 'fam1' }));
vi.mock('../lib/auth', () => ({ useSignOut: () => ({ signOut: vi.fn(), signingOut: false }) }));
vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));
/** Which invoice the route is on. Set per test; the two policies live on
    different rows of the same screen. */
const route = vi.hoisted(() => ({ invoiceId: 'inv1' }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
  useParams: () => ({ invoiceId: route.invoiceId }),
}));

/** One open bill and one unredeemed credit, so both buttons are on screen. */
function invoices() {
  return {
    open: [
      {
        id: 'inv1',
        client: 'The Danvers',
        status: 'open',
        total: 120,
        amountDue: 120,
        amountDueCents: 12_000,
        paidCents: 0,
        date: '2026-09-01',
        dueDate: '2026-09-15',
        creditRedeemedAtMs: null,
        creditAmountCents: null,
        creditTarget: null,
        quoteDecision: null,
        payMethods: [{ id: 'stripe', kind: 'checkout', label: 'Pay with Credit Card', url: null, instructions: null }],
      },
    ],
    paid: [],
    credits: [
      {
        id: 'cr1',
        client: 'The Danvers',
        status: 'credit',
        total: -25,
        amountDue: -25,
        amountDueCents: -2_500,
        paidCents: 0,
        date: '2026-09-02',
        dueDate: null,
        creditRedeemedAtMs: null,
        creditAmountCents: 2_500,
        creditTarget: null,
        quoteDecision: null,
        payMethods: [],
      },
    ],
    accountBalanceCents: 0,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mocks.getMyInvoices.mockResolvedValue(invoices());
  mocks.getMyHome.mockResolvedValue({ payMethods: [] });
  mocks.getBusinessContact.mockResolvedValue({});
  // Never resolves. A mutation that PAUSES never calls this at all, and the
  // spec asserts that; this only guarantees a leak would hang rather than
  // quietly pass.
  mocks.payInvoice.mockImplementation(() => new Promise(() => {}));
  mocks.redeemCredit.mockImplementation(() => new Promise(() => {}));
});

afterEach(() => {
  // Unmount BEFORE restoring the network: `onlineManager` is a module
  // singleton, and a resumed mutation from a dead test would run against the
  // next test's mocks.
  cleanup();
  onlineManager.setOnline(true);
  vi.useRealTimers();
  vi.clearAllMocks();
});

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });
}

async function renderLoaded(invoiceId = 'inv1') {
  route.invoiceId = invoiceId;
  const view = render(
    <QueryClientProvider client={client()}>
      <InvoiceDetail />
    </QueryClientProvider>,
  );
  // Let the invoice read land while the device is still online.
  await flush();
  return view;
}
/** Drain the microtask queue and one macrotask, so a settled mutation has
    re-rendered before anything is asserted. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('InvoiceDetail: a mutation with no signal (#807)', () => {
  it('says a HELD credit redemption is waiting for signal, not saving', async () => {
    await renderLoaded('cr1');
    const button = await screen.findByRole('button', { name: /Save to Account Balance/i });

    onlineManager.setOnline(false);
    await act(() => void button.click());
    await flush();

    // The pause is REAL: React Query never ran the mutation function.
    expect(mocks.redeemCredit).not.toHaveBeenCalled();

    // And the screen says which of the two it is.
    expect(screen.getByText(/waiting on this phone/i)).toBeTruthy();
    expect(screen.getByText(/sends itself when your signal returns/i)).toBeTruthy();

    // The endless-pending state is gone: no "Working…", and the button carries
    // the queued label instead.
    expect(screen.queryByRole('button', { name: 'Working…' })).toBeNull();
    expect(screen.getByRole('button', { name: /Waiting for signal/i })).toBeTruthy();
  });

  it('refuses an ABANDONED payment outright and promises nothing was sent', async () => {
    await renderLoaded();
    const button = await screen.findByRole('button', { name: /Pay with Credit Card/i });

    onlineManager.setOnline(false);
    await act(() => void button.click());
    await flush();

    // The preflight fired: `payInvoice` was never dialled, so the one thing a
    // household needs to hear about a payment is true and sayable.
    expect(mocks.payInvoice).not.toHaveBeenCalled();
    expect(screen.getByText(/your payment was not sent/i)).toBeTruthy();
    expect(screen.getByText(/Nothing has changed/i)).toBeTruthy();

    // Not a stuck spinner, in any of its forms.
    expect(screen.queryByRole('button', { name: 'Opening checkout…' })).toBeNull();
  });

  /**
   * #819 gave portal mutation buttons the loading cue and NO tap-to-sync
   * escalation, because most of them create something and a re-send button
   * invites the duplicate it appears to prevent. #807 sharpened that from a
   * blanket rule into a per-action one — and `payInvoice` is the action where
   * the blanket rule and the sharpened one agree.
   *
   * Establishing it from the callable: `payInvoice` creates a Stripe Checkout
   * Session per call, each with its own PaymentIntent, and `stripeWebhook`
   * dedupes per event id and per PaymentIntent — neither of which a SECOND
   * session trips, because it is a different intent. Nothing compares two
   * sessions against one invoice. So there is no re-send here, at any wait
   * length.
   */
  it('never offers a re-send on the payment, however long the wait runs', async () => {
    await renderLoaded();
    const button = await screen.findByRole('button', { name: /Pay with Credit Card/i });

    onlineManager.setOnline(false);
    await act(() => void button.click());
    await flush();

    // Twice the slow-server threshold, so a one-shot timer firing late is still
    // caught.
    act(() => void vi.advanceTimersByTime(SLOW_WAIT_MS * 2));

    expect(screen.queryByRole('button', { name: 'Tap to sync' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ask again' })).toBeNull();
    expect(screen.queryByRole('button', { name: /send again/i })).toBeNull();
    expect(document.querySelector('.slow-wait')).toBeNull();
    // And still exactly one call's worth of intent: none.
    expect(mocks.payInvoice).not.toHaveBeenCalled();
  });

  /**
   * The same property on a write that really IS waiting, which the payment case
   * cannot exercise: an abandoned write settles at once, so there is no wait
   * there for an escalation to grow out of. A QUEUED write waits indefinitely
   * by design, and is therefore the one that could sprout a "Tap to sync" and
   * must not — `refetch()`'s twin on a paused write goes straight back to a
   * pause, so the button would be dead, and #819's escalation is for a slow
   * SERVER rather than for no signal at all.
   */
  it('never escalates a queued write into a tap-to-sync, however long it waits', async () => {
    await renderLoaded('cr1');
    const button = await screen.findByRole('button', { name: /Save to Account Balance/i });

    onlineManager.setOnline(false);
    await act(() => void button.click());
    await flush();

    act(() => void vi.advanceTimersByTime(SLOW_WAIT_MS * 2));

    // Still queued, still saying so, and still offering nothing to press.
    expect(screen.getByText(/waiting on this phone/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Tap to sync' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ask again' })).toBeNull();
    expect(document.querySelector('.slow-wait')).toBeNull();
    expect(mocks.redeemCredit).not.toHaveBeenCalled();
  });
});
