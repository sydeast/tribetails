// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PayOptions } from './PayOptions';
import type { PayMethod } from '../api/types';

/**
 * PR30: one CTA per configured processor, Stripe first, resolved off
 * `getMyHome`'s `payMethods` — never raw operator handles (the server already
 * stripped those). `amountDue` is CENTS, same convention as
 * `creditAmountCents`/`accountBalanceCents` elsewhere in this screen.
 */
function stripe(): PayMethod {
  return { id: 'stripe', label: 'Pay with Credit Card', kind: 'checkout', url: null, instructions: null };
}
function venmo(): PayMethod {
  return { id: 'venmo', label: 'Pay with Venmo', kind: 'link', url: 'https://venmo.com/u/auntie', instructions: null };
}
function cashapp(): PayMethod {
  return { id: 'cashapp', label: 'Pay with Cash App', kind: 'link', url: 'https://cash.app/$auntie', instructions: null };
}

/** Issue #409: a method with no link to open, only the operator's own words. */
function cash(instructions = 'Exact change, handed over at pickup.'): PayMethod {
  return { id: 'cash', label: 'Pay in cash', kind: 'instructions', url: null, instructions };
}

afterEach(cleanup);

describe('PayOptions', () => {
  it('renders one CTA per configured method, Stripe first', () => {
    render(<PayOptions methods={[stripe(), venmo(), cashapp()]} amountDue={12750} onCheckout={vi.fn()} />);
    expect(
      screen
        .getAllByRole('button')
        .concat(screen.getAllByRole('link'))
        .map((e) => e.textContent),
    ).toEqual(['Pay with Credit Card', 'Pay with Venmo', 'Pay with Cash App']);
  });

  it('says how a link method settles, because it cannot enforce the amount', () => {
    render(<PayOptions methods={[venmo()]} amountDue={12750} onCheckout={vi.fn()} />);
    expect(screen.getByText(/Send \$127\.50/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pay with Venmo' })).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders nothing for an invoice with no configured methods, rather than a broken row', () => {
    const { container } = render(<PayOptions methods={[]} amountDue={12750} onCheckout={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('calls onCheckout for Stripe and never navigates a link method through it', () => {
    const onCheckout = vi.fn();
    render(<PayOptions methods={[stripe(), venmo()]} amountDue={12750} onCheckout={onCheckout} />);
    screen.getByRole('button', { name: 'Pay with Credit Card' }).click();
    expect(onCheckout).toHaveBeenCalledTimes(1);
  });

  it('disables and relabels the checkout button while checkout is opening', () => {
    render(<PayOptions methods={[stripe()]} amountDue={12750} onCheckout={vi.fn()} checkoutPhase="sending" />);
    const btn = screen.getByRole('button', { name: 'Opening checkout…' });
    expect(btn).toBeDisabled();
  });

  it('never says a queued payment is opening checkout (#807)', () => {
    // A paused mutation reports `isPending`, which is what the old
    // `checkingOut` boolean was built from. "Opening checkout…" over a request
    // still sitting on the phone is the sentence that invites the second tap.
    render(<PayOptions methods={[stripe()]} amountDue={12750} onCheckout={vi.fn()} checkoutPhase="queued" />);
    expect(screen.queryByRole('button', { name: 'Opening checkout…' })).toBeNull();
    expect(screen.getByRole('button', { name: /waiting for signal/i })).toBeDisabled();
  });

  it('never renders a processor fee — kinfolk do not see them', () => {
    // resolvePayMethods never sends feeBps/feeFixedCents in the first place,
    // but this pins the contract at the render layer too: nothing in
    // PayOptions' own props or markup can leak a fee figure.
    const { container } = render(<PayOptions methods={[stripe(), venmo()]} amountDue={12750} onCheckout={vi.fn()} />);
    expect(container.textContent).not.toMatch(/fee/i);
    expect(container.textContent).not.toMatch(/%/);
  });
});

/**
 * ISSUE #409: the third kind.
 *
 * Cash, a check, a bank transfer and Zelle-by-phone have no URL and never
 * will. Rendering them as anchors would put a dead link on a bill, which is
 * the exact defect the payment registry exists to prevent, so they render as
 * the operator's own text under a heading.
 */
describe('PayOptions instructions kind (issue #409)', () => {
  it("renders the operator's words, and no link or button at all", () => {
    render(<PayOptions methods={[cash()]} amountDue={12750} onCheckout={vi.fn()} />);
    expect(screen.getByText('Pay in cash')).toBeInTheDocument();
    expect(screen.getByText('Exact change, handed over at pickup.')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('states the amount, same as a link method, because it cannot enforce one either', () => {
    render(<PayOptions methods={[cash()]} amountDue={12750} onCheckout={vi.fn()} />);
    expect(screen.getByText(/Send \$127\.50/)).toBeInTheDocument();
  });

  it('sits alongside the other two kinds in the order the server sent', () => {
    const { container } = render(
      <PayOptions methods={[stripe(), venmo(), cash()]} amountDue={12750} onCheckout={vi.fn()} />,
    );
    expect(container.querySelectorAll('.pay-options > *')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Pay with Credit Card' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pay with Venmo' })).toBeInTheDocument();
    expect(screen.getByText('Pay in cash')).toBeInTheDocument();
  });

  it('never leaks a fee, whatever the mix of kinds', () => {
    const { container } = render(
      <PayOptions methods={[stripe(), venmo(), cash()]} amountDue={12750} onCheckout={vi.fn()} />,
    );
    expect(container.textContent).not.toMatch(/fee/i);
    expect(container.textContent).not.toMatch(/%/);
  });
});
