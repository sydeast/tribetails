// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FirebaseError } from 'firebase/app';

const api = vi.hoisted(() => ({
  getAccountCreditHistory: vi.fn(),
  giveAccountCredit: vi.fn(),
}));
vi.mock('../api/accountCredit', () => api);
// #1003: the panel also lists payments needing a decision; empty here, so the
// section stays hidden. UnappliedPaymentsSection.test.tsx covers it.
vi.mock('../api/unappliedPayments', () => ({
  listUnappliedPayments: vi.fn().mockResolvedValue({ ok: true, kinfolkId: 'fam1', payments: [], openInvoices: [] }),
  resolveUnappliedPayment: vi.fn(),
}));

import { AccountCreditPanel } from './AccountCreditPanel';

const OCT_3 = new Date(2026, 9, 3, 12).getTime();
const SEP_27 = new Date(2026, 8, 27, 12).getTime();

function history(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    kinfolkId: 'fam1',
    accountBalanceCents: 1200,
    credits: [
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
    ...over,
  };
}

beforeEach(() => {
  api.getAccountCreditHistory.mockReset();
  api.giveAccountCredit.mockReset();
});

async function openDialogAndReview(amount: string, reason: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Give credit' }));
  await user.type(screen.getByLabelText('Credit amount in dollars'), amount);
  await user.type(screen.getByLabelText('Reason for the credit'), reason);
  await user.click(screen.getByRole('button', { name: 'Review' }));
  return user;
}

describe('AccountCreditPanel: the history (Q6)', () => {
  it('shows the balance and each credit with its amount, date, reason and date applied', async () => {
    api.getAccountCreditHistory.mockResolvedValue(history());
    render(<AccountCreditPanel kinfolkId="fam1" />);
    expect(await screen.findByText('$12.00 on account')).toBeInTheDocument();
    expect(screen.getByText('Given Sep 27, 2026')).toBeInTheDocument();
    expect(screen.getByText('Missed visit on Sept 12')).toBeInTheDocument();
    expect(screen.getByText('Applied Oct 3, 2026')).toBeInTheDocument();
    expect(screen.getByText('$25.00 on INV-1009, Oct 3, 2026')).toBeInTheDocument();
    expect(api.getAccountCreditHistory).toHaveBeenCalledWith('fam1');
  });

  it('says so when no credit was ever given', async () => {
    api.getAccountCreditHistory.mockResolvedValue(history({ credits: [], uses: [] }));
    render(<AccountCreditPanel kinfolkId="fam1" />);
    expect(await screen.findByText('No credit given yet.')).toBeInTheDocument();
  });

  it('hides itself entirely when the server refuses the reader', async () => {
    api.getAccountCreditHistory.mockRejectedValue(new FirebaseError('functions/permission-denied', 'no'));
    const { container } = render(<AccountCreditPanel kinfolkId="fam1" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('shows an error for any other failure', async () => {
    api.getAccountCreditHistory.mockRejectedValue(new Error('offline'));
    render(<AccountCreditPanel kinfolkId="fam1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load account credit. offline');
  });
});

describe('AccountCreditPanel: Give credit (Q6)', () => {
  it('confirms with the new balance, sends integer cents with a crd key, and repeats the server balance', async () => {
    api.getAccountCreditHistory.mockResolvedValue(history());
    api.giveAccountCredit.mockResolvedValue({
      ok: true,
      creditId: 'crd_x',
      amountCents: 2500,
      newAccountBalanceCents: 3700,
      replayed: false,
    });
    render(<AccountCreditPanel kinfolkId="fam1" />);
    const user = await openDialogAndReview('25', 'Goodwill');

    expect(screen.getByText('Give $25.00 credit? Balance goes from $12.00 to $37.00.')).toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Give credit' }));

    await waitFor(() => expect(api.giveAccountCredit).toHaveBeenCalledTimes(1));
    const sent = api.giveAccountCredit.mock.calls[0]![0];
    expect(sent).toMatchObject({ kinfolkId: 'fam1', amountCents: 2500, reason: 'Goodwill' });
    expect(sent.idempotencyKey).toMatch(/^crd_\d{10,16}_[a-z0-9]{1,16}$/);
    expect(await screen.findByRole('status')).toHaveTextContent('Credit given. Balance is now $37.00.');
    // The history is read again so the new credit shows.
    await waitFor(() => expect(api.getAccountCreditHistory).toHaveBeenCalledTimes(2));
  });

  it('refuses a bad form before any call', async () => {
    api.getAccountCreditHistory.mockResolvedValue(history());
    render(<AccountCreditPanel kinfolkId="fam1" />);
    await openDialogAndReview('0', 'Goodwill');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter an amount above $0.00.');
    expect(api.giveAccountCredit).not.toHaveBeenCalled();
  });

  it('refuses a missing reason before any call', async () => {
    api.getAccountCreditHistory.mockResolvedValue(history());
    render(<AccountCreditPanel kinfolkId="fam1" />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Give credit' }));
    await user.type(screen.getByLabelText('Credit amount in dollars'), '10');
    await user.click(screen.getByRole('button', { name: 'Review' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a reason.');
    expect(api.giveAccountCredit).not.toHaveBeenCalled();
  });

  it('shows busy while saving, and a failed save keeps the same key for the retry', async () => {
    api.getAccountCreditHistory.mockResolvedValue(history());
    let rejectFirst: (e: Error) => void = () => {};
    api.giveAccountCredit
      .mockImplementationOnce(() => new Promise((_res, rej) => (rejectFirst = rej)))
      .mockResolvedValueOnce({ ok: true, creditId: 'c', amountCents: 1000, newAccountBalanceCents: 2200, replayed: true });
    render(<AccountCreditPanel kinfolkId="fam1" />);
    const user = await openDialogAndReview('10', 'Goodwill');

    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Give credit' }));
    const busyButton = await screen.findByRole('button', { name: 'Giving credit…' });
    expect(busyButton).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();

    rejectFirst(new Error('The network went away.'));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't give credit: The network went away.");

    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Give credit' }));
    await waitFor(() => expect(api.giveAccountCredit).toHaveBeenCalledTimes(2));
    const [first, second] = api.giveAccountCredit.mock.calls.map((c) => c[0].idempotencyKey);
    expect(second).toBe(first);
    expect(await screen.findByRole('status')).toHaveTextContent('Credit given. Balance is now $22.00.');
  });

  it('changing the amount after a failure makes it a new credit with a new key', async () => {
    api.getAccountCreditHistory.mockResolvedValue(history());
    api.giveAccountCredit
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce({ ok: true, creditId: 'c', amountCents: 1100, newAccountBalanceCents: 2300, replayed: false });
    render(<AccountCreditPanel kinfolkId="fam1" />);
    const user = await openDialogAndReview('10', 'Goodwill');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Give credit' }));
    await screen.findByRole('alert');

    await user.click(screen.getByRole('button', { name: 'Back' }));
    const amount = screen.getByLabelText('Credit amount in dollars');
    await user.clear(amount);
    await user.type(amount, '11');
    await user.click(screen.getByRole('button', { name: 'Review' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Give credit' }));

    await waitFor(() => expect(api.giveAccountCredit).toHaveBeenCalledTimes(2));
    const [first, second] = api.giveAccountCredit.mock.calls.map((c) => c[0].idempotencyKey);
    expect(second).not.toBe(first);
    expect(api.giveAccountCredit.mock.calls[1]![0].amountCents).toBe(1100);
  });
});
