// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * #2200 / #2201: the route adapter tells the feed whether the signed-in
 * account is an Auntie, read off the access the admin layout resolved, so her
 * rows offer no Open or Create quote into Invoices. The owner, the test admin
 * and the #812 offline session (access null) are not the Auntie.
 */
const { useRouteContext } = vi.hoisted(() => ({ useRouteContext: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn(), useRouteContext }));
vi.mock('../screens/Notifications', () => ({
  Notifications: ({ isAuntie }: { isAuntie?: boolean }) => <p>{isAuntie ? 'AUNTIE FEED' : 'OWNER FEED'}</p>,
}));

import { NotificationsView } from './NotificationsView';

beforeEach(() => useRouteContext.mockReset());

describe('NotificationsView (#2200 / #2201)', () => {
  it('hands the feed the Auntie flag for an Auntie', () => {
    useRouteContext.mockReturnValue({ access: { status: 'caretaker' } });
    render(<NotificationsView />);
    expect(screen.getByText('AUNTIE FEED')).toBeInTheDocument();
  });

  for (const access of [{ status: 'admin' }, { status: 'testAdmin', testTribeId: 'tribe-sandbox' }, null]) {
    it(`does not for ${access === null ? 'the offline session' : access.status}`, () => {
      useRouteContext.mockReturnValue({ access });
      render(<NotificationsView />);
      expect(screen.getByText('OWNER FEED')).toBeInTheDocument();
    });
  }
});
