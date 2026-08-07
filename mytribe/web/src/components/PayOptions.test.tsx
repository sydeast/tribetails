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
  return { id: 'stripe', label: 'Pay with Credit Card', kind: 'checkout', url: null };
}
function venmo(): PayMethod {
  return { id: 'venmo', label: 'Pay with Venmo', kind: 'link', url: 'https://venmo.com/u/auntie' };
}
function cashapp(): PayMethod {
  return { id: 'cashapp', label: 'Pay with Cash App', kind: 'link', url: 'https://cash.app/$auntie' };
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
    render(<PayOptions methods={[stripe()]} amountDue={12750} onCheckout={vi.fn()} checkingOut />);
    const btn = screen.getByRole('button', { name: 'Opening checkout…' });
    expect(btn).toBeDisabled();
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
