// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FirebaseError } from 'firebase/app';

const api = vi.hoisted(() => ({
  getAccountCreditHistory: vi.fn(),
  applyAccountCredit: vi.fn(),
}));
vi.mock('../api/accountCredit', () => api);

import { InvoiceApplyCredit } from './InvoiceApplyCredit';

/**
 * #1872 (operator ruling 2026-11-11): account credit goes onto an invoice only
 * as an amount the admin types. This is that box on the invoice: the
 * household's available credit, the amount, a confirmation naming the amount
 * and the invoice, a visible wait, and a refusal in plain words beside the
 * field.
 */

function history(accountBalanceCents: number) {
  return { ok: true, kinfolkId: 'fam1', accountBalanceCents, credits: [], uses: [] };
}

function applied(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    invoiceId: 'inv1',
    paymentId: 'acr_1790000000000_abc123',
    appliedCents: 2500,
    amountDueCents: 7500,
    accountBalanceCents: 9500,
    replayed: false,
    ...over,
  };
}

const onApplied = vi.fn();

function mount(over: Partial<Parameters<typeof InvoiceApplyCredit>[0]> = {}) {
  return render(
    <InvoiceApplyCredit
      invoiceId="inv1"
      invoiceNumber="1026"
      kinfolkId="fam1"
      dueCents={10000}
      onApplied={onApplied}
      {...over}
    />,
  );
}

const amountBox = () => screen.findByLabelText('Account credit to apply, in dollars');

beforeEach(() => {
  api.getAccountCreditHistory.mockReset().mockResolvedValue(history(12000));
  api.applyAccountCredit.mockReset();
  onApplied.mockReset();
});

describe('InvoiceApplyCredit: what she sees', () => {
  it('shows the credit the household has available', async () => {
    mount();
    expect(await screen.findByTestId('invoice-credit-available')).toHaveTextContent('$120.00 available');
    expect(api.getAccountCreditHistory).toHaveBeenCalledWith('fam1');
  });

  it('says it is loading while the balance is on its way', async () => {
    let resolve: (v: unknown) => void = () => {};
    api.getAccountCreditHistory.mockReturnValue(new Promise((r) => (resolve = r)));
    mount();
    expect(screen.getByRole('status')).toHaveTextContent('Loading account credit…');
    resolve(history(12000));
    expect(await amountBox()).toBeInTheDocument();
  });

  it('a household with no credit gets a sentence and no amount box', async () => {
    api.getAccountCreditHistory.mockResolvedValue(history(0));
    mount();
    expect(await screen.findByTestId('invoice-credit-available')).toHaveTextContent(
      'This household has no account credit.',
    );
    expect(screen.queryByLabelText('Account credit to apply, in dollars')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Apply credit' })).toBeNull();
  });

  it('stays hidden from someone the server will not show money to', async () => {
    api.getAccountCreditHistory.mockRejectedValue(new FirebaseError('functions/permission-denied', 'no'));
    const { container } = mount();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('says so when the balance could not be loaded, and tries again on request', async () => {
    api.getAccountCreditHistory.mockRejectedValueOnce(new Error('The network dropped.'));
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load account credit. The network dropped.');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('invoice-credit-available')).toHaveTextContent('$120.00 available');
  });
});

describe('InvoiceApplyCredit: applying an amount', () => {
  it('asks first, naming the amount and the invoice, and sends nothing until she agrees', async () => {
    const user = userEvent.setup();
    mount();
    await user.type(await amountBox(), '25');
    await user.click(screen.getByRole('button', { name: 'Apply credit' }));

    expect(
      screen.getByText(
        'Apply $25.00 of account credit to invoice 1026? The invoice will have $75.00 left to pay. The household keeps $95.00 of credit.',
      ),
    ).toBeInTheDocument();
    expect(api.applyAccountCredit).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(api.applyAccountCredit).not.toHaveBeenCalled();
    expect(await amountBox()).toHaveValue('25');
  });

  it('sends the amount in cents with a key, then hands the outcome up in words', async () => {
    api.applyAccountCredit.mockResolvedValue(applied());
    const user = userEvent.setup();
    mount();
    await user.type(await amountBox(), '25.00');
    await user.click(screen.getByRole('button', { name: 'Apply credit' }));
    await user.click(screen.getByRole('button', { name: 'Apply credit' }));

    await waitFor(() => expect(api.applyAccountCredit).toHaveBeenCalledTimes(1));
    const sent = api.applyAccountCredit.mock.calls[0]![0];
    expect(sent).toMatchObject({ invoiceId: 'inv1', amountCents: 2500 });
    expect(sent.idempotencyKey).toMatch(/^acr_[0-9]{10,16}_[a-z0-9]{1,16}$/);

    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(onApplied.mock.calls[0]![1]).toBe(
      'Applied $25.00 of account credit to invoice 1026. $75.00 is left to pay. The household has $95.00 of credit left.',
    );
    // The balance on screen is now the server's figure, and the box is clear.
    expect(await screen.findByTestId('invoice-credit-available')).toHaveTextContent('$95.00 available');
    expect(await amountBox()).toHaveValue('');
  });

  it('shows the wait: the button says it is applying and takes no second press', async () => {
    let resolve: (v: unknown) => void = () => {};
    api.applyAccountCredit.mockReturnValue(new Promise((r) => (resolve = r)));
    const user = userEvent.setup();
    mount();
    await user.type(await amountBox(), '25');
    await user.click(screen.getByRole('button', { name: 'Apply credit' }));
    await user.click(screen.getByRole('button', { name: 'Apply credit' }));

    const waiting = await screen.findByRole('button', { name: 'Applying credit…' });
    expect(waiting).toBeDisabled();
    expect(waiting).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    await user.click(waiting);
    expect(api.applyAccountCredit).toHaveBeenCalledTimes(1);

    resolve(applied());
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
  });
});

describe('InvoiceApplyCredit: refusals sit beside the field', () => {
  async function typeAndApply(amount: string) {
    const user = userEvent.setup();
    mount();
    if (amount !== '') await user.type(await amountBox(), amount);
    else await amountBox();
    await user.click(screen.getByRole('button', { name: 'Apply credit' }));
    return user;
  }

  it('more than the household has', async () => {
    await typeAndApply('120.01');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This household has $120.00 of account credit. Enter that much or less.',
    );
    expect(await amountBox()).toHaveAttribute('aria-invalid', 'true');
    expect(api.applyAccountCredit).not.toHaveBeenCalled();
  });

  it('more than the invoice has left to pay', async () => {
    await typeAndApply('100.01');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This invoice has $100.00 left to pay. Enter that much or less.',
    );
    expect(api.applyAccountCredit).not.toHaveBeenCalled();
  });

  it('zero, a negative amount, text and an empty box', async () => {
    for (const [amount, words] of [
      ['0', 'Enter an amount above $0.00.'],
      ['-5', 'Enter an amount in dollars, like 25.00.'],
      ['abc', 'Enter an amount in dollars, like 25.00.'],
      ['', 'Enter an amount in dollars, like 25.00.'],
    ] as const) {
      const user = await typeAndApply(amount);
      expect(screen.getByRole('alert'), amount).toHaveTextContent(words);
      expect(api.applyAccountCredit).not.toHaveBeenCalled();
      // Typing again clears the refusal.
      await user.type(await amountBox(), '1');
      expect(screen.queryByRole('alert')).toBeNull();
      cleanup();
    }
  });

  it('a refusal from the server comes back to the form in its own words, and the balance is read again', async () => {
    api.applyAccountCredit.mockRejectedValue(
      new FirebaseError('functions/failed-precondition', 'This invoice is already paid, so it takes no credit.'),
    );
    const user = await typeAndApply('25');
    await user.click(screen.getByRole('button', { name: 'Apply credit' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This invoice is already paid, so it takes no credit.',
    );
    expect(await amountBox()).toHaveValue('25');
    expect(onApplied).not.toHaveBeenCalled();
    await waitFor(() => expect(api.getAccountCreditHistory).toHaveBeenCalledTimes(2));
  });
});

describe('InvoiceApplyCredit: one key per submission', () => {
  async function failThenRetry(changeAmount: boolean) {
    api.applyAccountCredit
      .mockRejectedValueOnce(new FirebaseError('functions/internal', 'internal'))
      .mockResolvedValueOnce(applied());
    const user = userEvent.setup();
    mount();
    await user.type(await amountBox(), '25');
    await user.click(screen.getByRole('button', { name: 'Apply credit' }));
    await user.click(screen.getByRole('button', { name: 'Apply credit' }));
    await screen.findByRole('alert');

    if (changeAmount) {
      await user.clear(await amountBox());
      await user.type(await amountBox(), '11');
    }
    await user.click(screen.getByRole('button', { name: 'Apply credit' }));
    await user.click(screen.getByRole('button', { name: 'Apply credit' }));
    await waitFor(() => expect(api.applyAccountCredit).toHaveBeenCalledTimes(2));
    return api.applyAccountCredit.mock.calls.map((c) => c[0]);
  }

  it('pressing again after a lost reply sends the SAME key, so the amount lands once', async () => {
    const [first, second] = await failThenRetry(false);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.amountCents).toBe(2500);
  });

  it('changing the amount makes it a different submission with a new key', async () => {
    const [first, second] = await failThenRetry(true);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(second.amountCents).toBe(1100);
  });
});
