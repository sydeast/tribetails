// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FirebaseError } from 'firebase/app';

const credit = vi.hoisted(() => ({
  getAccountCreditHistory: vi.fn(),
  giveAccountCredit: vi.fn(),
}));
vi.mock('../api/accountCredit', () => credit);
const api = vi.hoisted(() => ({
  listUnappliedPayments: vi.fn(),
  resolveUnappliedPayment: vi.fn(),
}));
vi.mock('../api/unappliedPayments', () => api);

import { AccountCreditPanel } from './AccountCreditPanel';

const SEP_27 = new Date(2026, 8, 27, 12).getTime();

function payment(over: Record<string, unknown> = {}) {
  return {
    paymentId: 'evt_1',
    kinfolkId: 'fam1',
    invoiceId: 'inv1',
    invoiceNumber: 'INV-1042',
    amountCents: 2500,
    amountResolved: true,
    feeCents: 103,
    reason: 'the invoice was already marked paid',
    receivedAtMs: SEP_27,
    referenceNumber: 'pi_1',
    ...over,
  };
}

function listed(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    kinfolkId: 'fam1',
    payments: [payment()],
    openInvoices: [{ invoiceId: 'inv2', invoiceNumber: 'INV-1050', amountDueCents: 4000 }],
    ...over,
  };
}

function saved(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    paymentId: 'evt_1',
    kinfolkId: 'fam1',
    paymentCents: 2500,
    creditedCents: 1000,
    creditId: 'crd_1',
    appliedCents: 1500,
    appliedInvoiceId: 'inv2',
    appliedInvoiceNumber: 'INV-1050',
    appliedInvoiceState: 'settled',
    appliedInvoiceAmountDueCents: 0,
    keptCents: 0,
    newAccountBalanceCents: 3700,
    replayed: false,
    ...over,
  };
}

beforeEach(() => {
  credit.getAccountCreditHistory.mockReset();
  credit.giveAccountCredit.mockReset();
  credit.getAccountCreditHistory.mockResolvedValue({
    ok: true,
    kinfolkId: 'fam1',
    accountBalanceCents: 2700,
    credits: [],
    uses: [],
  });
  api.listUnappliedPayments.mockReset();
  api.resolveUnappliedPayment.mockReset();
});

async function openDecide() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Decide' }));
  return { user, dialog: screen.getByRole('dialog') };
}

describe('Payments needing a decision: the list (#1003)', () => {
  it('shows one row per payment with its amount, invoice, date and reason', async () => {
    api.listUnappliedPayments.mockResolvedValue(listed());
    render(<AccountCreditPanel kinfolkId="fam1" />);
    expect(await screen.findByRole('heading', { name: 'Payments needing a decision' })).toBeInTheDocument();
    expect(screen.getByText('$25.00 card payment on invoice INV-1042')).toBeInTheDocument();
    expect(
      screen.getByText('Sep 27, 2026. Not applied because the invoice was already marked paid.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decide' })).toBeInTheDocument();
    expect(api.listUnappliedPayments).toHaveBeenCalledWith('fam1');
  });

  it('is hidden when nothing is waiting', async () => {
    api.listUnappliedPayments.mockResolvedValue(listed({ payments: [] }));
    render(<AccountCreditPanel kinfolkId="fam1" />);
    await screen.findByText('$27.00 on account');
    await waitFor(() => expect(api.listUnappliedPayments).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText('Payments needing a decision')).toBeNull();
    expect(screen.queryByText('No card payments are waiting for a decision.')).toBeNull();
  });

  it('says nothing is waiting when the notice opened it', async () => {
    api.listUnappliedPayments.mockResolvedValue(listed({ payments: [] }));
    render(<AccountCreditPanel kinfolkId="fam1" openUnappliedPayments unappliedPaymentId="evt_gone" />);
    expect(await screen.findByText('No card payments are waiting for a decision.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('hides silently when the server refuses the reader', async () => {
    api.listUnappliedPayments.mockRejectedValue(new FirebaseError('functions/permission-denied', 'no'));
    render(<AccountCreditPanel kinfolkId="fam1" openUnappliedPayments />);
    await screen.findByText('$27.00 on account');
    await waitFor(() => expect(api.listUnappliedPayments).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText('Payments needing a decision')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says the load failed and retries on request', async () => {
    api.listUnappliedPayments.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(listed());
    render(<AccountCreditPanel kinfolkId="fam1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load payments needing a decision.');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('$25.00 card payment on invoice INV-1042')).toBeInTheDocument();
    expect(api.listUnappliedPayments).toHaveBeenCalledTimes(2);
  });

  it('opens the notice payment’s dialog on arrival', async () => {
    api.listUnappliedPayments.mockResolvedValue(listed());
    render(<AccountCreditPanel kinfolkId="fam1" openUnappliedPayments unappliedPaymentId="evt_1" />);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Decide what this payment becomes')).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        'Card payment of $25.00 on invoice INV-1042. There are no refunds. Anything you do not credit or apply stays recorded on the payment.',
      ),
    ).toBeInTheDocument();
  });
});

describe('Payments needing a decision: the Decide dialog (#1003)', () => {
  it('sends integer cents with an upd key, then reloads both lists and repeats the server figures', async () => {
    api.listUnappliedPayments.mockResolvedValueOnce(listed()).mockResolvedValueOnce(listed({ payments: [] }));
    api.resolveUnappliedPayment.mockResolvedValue(saved());
    render(<AccountCreditPanel kinfolkId="fam1" />);
    const { user, dialog } = await openDecide();

    await user.type(within(dialog).getByLabelText('Account credit ($)'), '10');
    await user.type(within(dialog).getByLabelText('Reason for the credit'), '  Paid twice ');
    await user.selectOptions(within(dialog).getByLabelText('Apply to invoice'), 'inv2');
    await user.type(within(dialog).getByLabelText('Amount to apply ($)'), '15');
    expect(within(dialog).getByText('Credit $10.00, apply $15.00, keep $0.00.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save decision' }));

    await waitFor(() => expect(api.resolveUnappliedPayment).toHaveBeenCalledTimes(1));
    const sent = api.resolveUnappliedPayment.mock.calls[0]![0];
    expect(sent).toMatchObject({
      paymentId: 'evt_1',
      creditCents: 1000,
      creditReason: 'Paid twice',
      applyInvoiceId: 'inv2',
      applyCents: 1500,
    });
    expect(sent.idempotencyKey).toMatch(/^upd_\d{10,16}_[a-z0-9]{1,16}$/);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Decision saved. $10.00 to account credit (balance now $37.00). $15.00 on invoice INV-1050 (paid in full). $0.00 kept on the payment.',
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(api.listUnappliedPayments).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(credit.getAccountCreditHistory).toHaveBeenCalledTimes(2));
  });

  it('saves the all-zero decision with empty reason and invoice', async () => {
    api.listUnappliedPayments.mockResolvedValue(listed());
    api.resolveUnappliedPayment.mockResolvedValue(
      saved({ creditedCents: 0, appliedCents: 0, appliedInvoiceId: '', appliedInvoiceNumber: '', appliedInvoiceState: '', keptCents: 2500 }),
    );
    render(<AccountCreditPanel kinfolkId="fam1" />);
    const { user, dialog } = await openDecide();
    expect(within(dialog).getByText('Credit $0.00, apply $0.00, keep $25.00.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save decision' }));
    await waitFor(() => expect(api.resolveUnappliedPayment).toHaveBeenCalledTimes(1));
    expect(api.resolveUnappliedPayment.mock.calls[0]![0]).toMatchObject({
      creditCents: 0,
      creditReason: '',
      applyInvoiceId: '',
      applyCents: 0,
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Decision saved. $25.00 kept on the payment.');
  });

  it('refuses a bad split before any call and disables Save', async () => {
    api.listUnappliedPayments.mockResolvedValue(listed());
    render(<AccountCreditPanel kinfolkId="fam1" />);
    const { user, dialog } = await openDecide();
    const save = within(dialog).getByRole('button', { name: 'Save decision' });

    await user.type(within(dialog).getByLabelText('Account credit ($)'), '5');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter a reason for the credit.');
    expect(save).toBeDisabled();

    await user.type(within(dialog).getByLabelText('Reason for the credit'), 'x');
    await user.selectOptions(within(dialog).getByLabelText('Apply to invoice'), 'inv2');
    await user.type(within(dialog).getByLabelText('Amount to apply ($)'), '45');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('That invoice owes only $40.00.');

    const apply = within(dialog).getByLabelText('Amount to apply ($)');
    await user.clear(apply);
    await user.type(apply, '21');
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'The credit and the applied amount add up to more than this payment.',
    );

    await user.clear(apply);
    await user.type(apply, '1.234');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter an amount in dollars, like 12.50.');
    expect(save).toBeDisabled();
    expect(api.resolveUnappliedPayment).not.toHaveBeenCalled();
  });

  it('keeps Amount to apply disabled until an invoice is chosen', async () => {
    api.listUnappliedPayments.mockResolvedValue(listed());
    render(<AccountCreditPanel kinfolkId="fam1" />);
    const { user, dialog } = await openDecide();
    expect(within(dialog).getByLabelText('Amount to apply ($)')).toBeDisabled();
    expect(within(dialog).getByRole('option', { name: 'None' })).toBeInTheDocument();
    expect(within(dialog).getByRole('option', { name: 'INV-1050, $40.00 due' })).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText('Apply to invoice'), 'inv2');
    expect(within(dialog).getByLabelText('Amount to apply ($)')).toBeEnabled();
  });

  it('says so and offers no picker when the household has no open invoices', async () => {
    api.listUnappliedPayments.mockResolvedValue(listed({ openInvoices: [] }));
    render(<AccountCreditPanel kinfolkId="fam1" />);
    const { dialog } = await openDecide();
    expect(within(dialog).getByText('No open invoices for this household.')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Apply to invoice')).toBeNull();
  });

  it('shows Saving... while busy, cannot be dismissed, keeps the key on retry and shows the server message', async () => {
    api.listUnappliedPayments.mockResolvedValue(listed());
    let rejectFirst: (e: Error) => void = () => {};
    api.resolveUnappliedPayment
      .mockImplementationOnce(() => new Promise((_res, rej) => (rejectFirst = rej)))
      .mockResolvedValueOnce(saved({ creditedCents: 0, appliedCents: 0, keptCents: 2500 }));
    render(<AccountCreditPanel kinfolkId="fam1" />);
    const { user, dialog } = await openDecide();

    await user.click(within(dialog).getByRole('button', { name: 'Save decision' }));
    const busy = await within(dialog).findByRole('button', { name: 'Saving...' });
    expect(busy).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    rejectFirst(new Error('This payment was already decided.'));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('This payment was already decided.');
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Save decision' }));
    await waitFor(() => expect(api.resolveUnappliedPayment).toHaveBeenCalledTimes(2));
    const [first, second] = api.resolveUnappliedPayment.mock.calls.map((c) => c[0].idempotencyKey);
    expect(second).toBe(first);
  });

  it('an edit after a failure is a new decision with a new key', async () => {
    api.listUnappliedPayments.mockResolvedValue(listed());
    api.resolveUnappliedPayment
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce(saved({ creditedCents: 0, appliedCents: 0, keptCents: 2500 }));
    render(<AccountCreditPanel kinfolkId="fam1" />);
    const { user, dialog } = await openDecide();
    await user.click(within(dialog).getByRole('button', { name: 'Save decision' }));
    await within(dialog).findByRole('alert');

    await user.selectOptions(within(dialog).getByLabelText('Apply to invoice'), 'inv2');
    await user.type(within(dialog).getByLabelText('Amount to apply ($)'), '5');
    await user.click(within(dialog).getByRole('button', { name: 'Save decision' }));

    await waitFor(() => expect(api.resolveUnappliedPayment).toHaveBeenCalledTimes(2));
    const [first, second] = api.resolveUnappliedPayment.mock.calls.map((c) => c[0].idempotencyKey);
    expect(second).not.toBe(first);
    expect(api.resolveUnappliedPayment.mock.calls[1]![0]).toMatchObject({ applyInvoiceId: 'inv2', applyCents: 500 });
  });
});
