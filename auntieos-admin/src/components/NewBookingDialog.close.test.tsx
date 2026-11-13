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
 * landed its second click there). The fix insets the panel below the topbar so
 * the X can never share a hit area with it. jsdom does no layout, so the inset is
 * asserted on the stylesheet and on the marker the stylesheet keys on; the
 * close behaviour is asserted for real.
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

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'NewBookingDialog.css'), 'utf8');

const shell = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../styles/shell.css'), 'utf8');

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
  for (const m of source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(re)) {
    if (m[1]!.trim() === needle) return m[2]!;
  }
  return null;
}

describe('#1897 New booking panel clears the shell topbar', () => {
  it('marks the panel content so the stylesheet can inset the sheet', () => {
    render(<NewBookingDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'New booking request' });
    expect(dialog.querySelector('.new-booking')).not.toBeNull();
    expect(dialog.querySelector('.dialog__close')).not.toBeNull();
  });

  it('insets the sheet backdrop from the top on desktop', () => {
    const body = ruleBody(css, '.dialog__backdrop--sheet:has(.new-booking)');
    expect(body).not.toBeNull();
    expect(body).toMatch(/padding-top:\s*[^;]*(rem|var\()/);
  });

  it('takes the inset from the shell topbar token, not a number of its own', () => {
    const body = ruleBody(css, '.dialog__backdrop--sheet:has(.new-booking)');
    expect(body).toMatch(/padding-top:\s*var\(--shell-topbar-clear/);
    expect(css).not.toMatch(/@media[^{]*\{[^}]*:has\(\.new-booking\)[^}]*padding-top:\s*[\d.]+rem/);
  });

  it('shell.css defines the token from the topbar row it lays out, and shrinks it on a phone', () => {
    const main = ruleBody(shell, '.shell__main');
    expect(main).toMatch(/--shell-topbar-clear:\s*calc\(var\(--shell-pad-y\)\s*\+\s*var\(--shell-topbar-h\)/);
    expect(main).toMatch(/padding:\s*var\(--shell-pad-y\)/);
    expect(ruleBody(shell, '.shell__topbar')).toMatch(/min-height:\s*var\(--shell-topbar-h\)/);
    const phone = shell.match(/@media \(max-width: 720px\) \{([\s\S]*)$/);
    expect(phone![1]).toMatch(/\.shell__main \{\s*--shell-pad-y:\s*var\(--space-4\)/);
  });

  it('squares the top corners it now floats under the topbar', () => {
    const body = ruleBody(css, '.dialog--sheet:has(.new-booking)');
    expect(body).not.toBeNull();
    expect(body).toMatch(/border-top/);
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
