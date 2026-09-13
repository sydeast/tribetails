// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueuedWritesBanner } from './QueuedWritesBanner';
import { resetQueuedWrites, settleWrite } from '../lib/offlineWrite';
import { invoiceActionError } from './InvoiceDetail';
import { LostSignalError, OfflineCallError } from '../lib/offlineWrite';

/**
 * What the operator is actually shown for a write with no signal (#807), and
 * the one affordance that must never appear next to one.
 */

function goOffline(): void {
  vi.stubGlobal('navigator', { onLine: false });
}

beforeEach(() => {
  resetQueuedWrites();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetQueuedWrites();
});

describe('QueuedWritesBanner', () => {
  it('shows nothing at all when nothing is queued, which is almost always', () => {
    const { container } = render(<QueuedWritesBanner />);
    expect(container.textContent).toBe('');
  });

  it('names the one queued change and says it is safe', async () => {
    goOffline();
    await settleWrite(new Promise<void>(() => {}), 'your settings');

    render(<QueuedWritesBanner />);

    expect(screen.getByText(/Waiting for a signal/)).toBeTruthy();
    expect(screen.getByText(/your settings/)).toBeTruthy();
    expect(screen.getByText(/send themselves when the signal returns|sends itself|send themselves/i)).toBeTruthy();
  });

  /**
   * NO RE-SEND, and this is the assertion that carries #807's second half.
   *
   * Nothing in this app dedupes a second `recordPayment` or a second
   * `createInvoice` — established from the callables: both write an auto-id row
   * with no idempotency key, and `recordPayment` with `autoApply` also
   * increments the household's account balance. A "send again" button beside a
   * queued money write is a second payment row waiting to be tapped.
   *
   * It is not an error, either: `role="alert"` would interrupt a screen reader
   * to announce something that has not failed and is not lost.
   */
  it('offers no way to send it again, and is not shaped like an error', async () => {
    goOffline();
    await settleWrite(new Promise<void>(() => {}), 'a payment');

    render(<QueuedWritesBanner />);

    expect(screen.queryByRole('button', { name: /send again|retry|sync now|try again/i })).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('collapses duplicates and counts the rest', async () => {
    goOffline();
    await settleWrite(new Promise<void>(() => {}), 'a KinTale');
    await settleWrite(new Promise<void>(() => {}), 'a KinTale');
    await settleWrite(new Promise<void>(() => {}), 'your settings');

    render(<QueuedWritesBanner />);

    expect(screen.getByText(/3 changes/)).toBeTruthy();
    // One subject per thing the operator cares about, not one per write.
    expect(screen.getByText(/a KinTale, your settings/)).toBeTruthy();
  });
});

/**
 * The money panel's sentence, which is the admin's version of "this never left
 * your phone" versus "we cannot tell".
 */
describe('invoiceActionError', () => {
  it('gives a refused call its own sentence, with no callable name in front', () => {
    const line = invoiceActionError(new OfflineCallError('markInvoicePaid'), 'markInvoicePaid');
    expect(line).not.toMatch(/markInvoicePaid failed/);
    expect(line).toMatch(/was not sent/i);
    expect(line).toMatch(/Nothing has changed/i);
  });

  /**
   * The one that matters, and #825 CHANGED THE RIGHT ANSWER.
   *
   * It used to be "go and look": `recordPayment` had no dedupe key of any kind,
   * so an operator who re-entered a payment whose fate was unknown booked it
   * twice and, with `autoApply`, credited the household twice. Now the panel
   * mints one key per submission and holds it across a re-press, so the honest
   * advice is to press the same button again — and the sentence has to say
   * WITHOUT CHANGING ANYTHING, because editing a figure mints a new key and
   * makes it a genuinely different payment.
   *
   * The old "check whether it is already there" is asserted ABSENT on purpose:
   * leaving it beside the new sentence would give two contradictory
   * instructions for one error.
   */
  it('tells the operator to re-press UNCHANGED after an unknown payment', () => {
    const line = invoiceActionError(new LostSignalError('recordPayment'), 'recordPayment');
    expect(line).toMatch(/no way to tell/i);
    expect(line).toMatch(/press the same button again without changing anything/i);
    expect(line).toMatch(/changing a figure first would make it a different payment/i);
    expect(line).not.toMatch(/check whether this payment is already there/i);
  });

  it('lets the server keep its own words when the server answered', () => {
    const line = invoiceActionError(new Error('invoice_already_settled'), 'markInvoicePaid');
    expect(line).toBe('markInvoicePaid failed: invoice_already_settled');
  });
});
