// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { routeErrorNotice, RouteError } from './RouteError';
import { OfflineSessionError } from '../lib/readOnlySession';

/**
 * #812. The router's error screen replaced a crash page that blamed the app for
 * a missing bar of signal. Two things have to hold: it tells the two apart, and
 * the offline arm carries nothing that would end the session.
 */
describe('the router error screen', () => {
  it('names the network rather than the app when the session is offline', () => {
    const notice = routeErrorNotice(new OfflineSessionError('listBookings'), true);
    expect(notice.tone).toBe('warning');
    expect(notice.title).toMatch(/offline/i);
  });

  it('names the network for any failure on a device with no connection', () => {
    // A screen chunk that never arrives is an offline fact too, not a defect.
    expect(routeErrorNotice(new Error('Failed to fetch dynamically imported module'), false).title).toMatch(
      /offline/i,
    );
  });

  it('still reports a genuine failure as one when the network is there', () => {
    const notice = routeErrorNotice(new TypeError('x is not a function'), true);
    expect(notice.tone).toBe('error');
    expect(notice.title).not.toMatch(/offline/i);
  });

  it('offers Try again and never a way to sign out', () => {
    render(<RouteError error={new OfflineSessionError('listBookings')} reset={vi.fn()} />);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    // Signing out offline clears the only copy of anything still readable, and
    // signing back in needs the connection that is missing. See #805.
    expect(screen.queryByRole('button', { name: /sign out|sign in again/i })).toBeNull();
  });
});
