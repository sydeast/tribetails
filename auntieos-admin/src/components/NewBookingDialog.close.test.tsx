// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CollectionSpec } from '../lib/firestore';

/**
 * #1897: the New booking panel is a right-edge sheet, and its close X sat at the
 * viewport's top-right corner, exactly where the shell topbar's "Sign out" is.
 * Once the panel unmounted the pointer rested on Sign out (and a double click
 * landed its second click there). Every right-edge sheet (and the phone-width
 * wizard) had the same shape, so the inset lives on Dialog's own variants and
 * starts them below the topbar row, read from shell.css's topbar tokens. jsdom
 * does no layout, so the inset is asserted on the stylesheets and on the variant
 * this panel renders with (the Cypress spec in bookings.cy.ts measures the real
 * boxes); the close behaviour is asserted for real.
 */

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));
const { createMultiDateBookingRequest } = vi.hoisted(() => ({ createMultiDateBookingRequest: vi.fn() }));
vi.mock('../api/bookingsWrite', async (orig) => ({
  ...(await orig<typeof import('../api/bookingsWrite')>()),
  createMultiDateBookingRequest,
}));
const { getBusinessSettings } = vi.hoisted(() => ({ getBusinessSettings: vi.fn() }));
vi.mock('../api/settings', () => ({ getBusinessSettings }));

import { NewBookingDialog } from './NewBookingDialog';

beforeAll(() => {
  process.env.TZ = 'America/Chicago';
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2027, 7, 15, 12, 0, 0));
});
afterAll(() => {
  vi.useRealTimers();
});

const here = dirname(fileURLToPath(import.meta.url));
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '');
const dialogCss = stripComments(readFileSync(join(here, 'Dialog.css'), 'utf8'));
const bookingCss = stripComments(readFileSync(join(here, 'NewBookingDialog.css'), 'utf8'));
const shell = stripComments(readFileSync(join(here, '../styles/shell.css'), 'utf8'));

beforeEach(() => {
  createMultiDateBookingRequest.mockReset();
  getBusinessSettings.mockReset().mockResolvedValue({ serviceRates: {}, businessHours: {}, timeZone: '' });
  useCollection.mockReset().mockImplementation((spec: CollectionSpec) => {
    if (spec.path === 'booking_time_slots' || spec.path === 'kin_care_sessions' || spec.path === 'kin') {
      return { status: 'ready', data: [] };
    }
    return {
      status: 'ready',
      data: [{ _id: 'kf1', firstName: 'Jamie', lastName: 'Halbrook', status: 'active' }],
    };
  });
});

/** The body of the first rule whose selector is exactly `needle`. */
function ruleBody(source: string, needle: string): string | null {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of source.matchAll(re)) {
    if (m[1]!.trim() === needle) return m[2]!;
  }
  return null;
}

/** The text of the `@media` block whose condition is exactly `condition`. */
function mediaBlock(source: string, condition: string): string {
  const at = source.indexOf(`@media ${condition} {`);
  expect(at, `@media ${condition}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = source.indexOf('{', at); i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(at, i + 1);
  }
  throw new Error(`unclosed @media ${condition}`);
}

describe('#1897 New booking panel clears the shell topbar', () => {
  it('renders as the shared right-edge sheet, so the sheet inset applies to it', () => {
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'New booking request' });
    expect(dialog).toHaveClass('dialog--sheet');
    expect(dialog.parentElement).toHaveClass('dialog__backdrop--sheet');
    expect(dialog.querySelector('.dialog__close')).not.toBeNull();
  });

  it('every sheet starts below the topbar row, from the shell token, with no fallback inset', () => {
    const body = ruleBody(dialogCss, '.dialog__backdrop--sheet');
    expect(body).toMatch(/padding-top:\s*var\(--shell-topbar-clear,\s*0px\)/);
  });

  it('the phone-width wizard starts below the topbar row too', () => {
    const phone = mediaBlock(dialogCss, '(max-width: 40rem)');
    expect(ruleBody(phone, '.dialog__backdrop:has(.dialog--wizard)')).toMatch(
      /padding:\s*var\(--shell-topbar-clear,\s*0px\)\s+0\s+0/,
    );
  });

  it('the New booking stylesheet no longer carries an inset of its own', () => {
    expect(bookingCss).not.toMatch(/\.new-booking\b/);
    expect(bookingCss).not.toMatch(/dialog__backdrop--sheet/);
  });

  it('shell.css builds the topbar token from the account chip it lays out', () => {
    const main = ruleBody(shell, '.shell__main');
    expect(main).toMatch(
      /--shell-topbar-h:\s*calc\(var\(--shell-chip-monogram\)\s*\+\s*2\s*\*\s*var\(--shell-chip-pad-y\)\)/,
    );
    expect(main).toMatch(/--shell-topbar-clear:\s*calc\(var\(--shell-pad-y\)\s*\+\s*var\(--shell-topbar-h\)/);
    expect(main).toMatch(/padding:\s*var\(--shell-pad-y\)/);
    // The chip is drawn from the same tokens, so the token cannot drift from the row.
    expect(ruleBody(shell, '.shell__account')).toMatch(/padding:\s*var\(--shell-chip-pad-y\)\s+\S+\s+var\(--shell-chip-pad-y\)/);
    const monogram = ruleBody(shell, '.shell__account-monogram');
    expect(monogram).toMatch(/width:\s*var\(--shell-chip-monogram\)/);
    expect(monogram).toMatch(/height:\s*var\(--shell-chip-monogram\)/);
    expect(ruleBody(shell, '.shell__topbar')).toMatch(/min-height:\s*var\(--shell-topbar-h\)/);
    // The phone page padding shrinks, and the clearance shrinks with it.
    expect(mediaBlock(shell, '(max-width: 720px)')).toMatch(/\.shell__main \{\s*--shell-pad-y:\s*var\(--space-4\)/);
  });
});

describe('#1897 closing the New booking panel', () => {
  it('the X closes it once', async () => {
    const onClose = vi.fn();
    render(<NewBookingDialog onClose={onClose} onCreated={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape closes it', async () => {
    const onClose = vi.fn();
    render(<NewBookingDialog onClose={onClose} onCreated={vi.fn()} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Cancel in the footer closes it on step 1', async () => {
    const onClose = vi.fn();
    render(<NewBookingDialog onClose={onClose} onCreated={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closing with a household already picked closes without sending anything', async () => {
    const onClose = vi.fn();
    render(<NewBookingDialog onClose={onClose} onCreated={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(createMultiDateBookingRequest).not.toHaveBeenCalled();
  });

  it('a backdrop press closes it, and a press inside the panel does not', async () => {
    const onClose = vi.fn();
    render(<NewBookingDialog onClose={onClose} onCreated={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    await userEvent.pointer({ keys: '[MouseLeft]', target: dialog });
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.pointer({ keys: '[MouseLeft]', target: dialog.parentElement! });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hands focus back to the control that opened it', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(document.activeElement).not.toBe(opener);
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('will not close while the request is being created', async () => {
    createMultiDateBookingRequest.mockReturnValue(new Promise(() => {}));
    const onClose = vi.fn();
    render(<NewBookingDialog onClose={onClose} onCreated={vi.fn()} />);
    const next = () => userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await next();
    await userEvent.type(screen.getByPlaceholderText('e.g. Dog Walk'), 'Dog Walk');
    await next();
    await userEvent.click(screen.getByRole('gridcell', { name: /Mon, Aug 23/ }));
    await next();
    await next();
    await userEvent.click(screen.getByRole('button', { name: /^Create/ }));
    await screen.findByRole('button', { name: 'Creating…' });
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
