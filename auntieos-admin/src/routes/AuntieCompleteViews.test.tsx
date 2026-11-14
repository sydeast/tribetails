// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * #2199, operator ruling 2026-11-14 ("the button is disabled but visible"):
 * the Auntie Time board and the Schedule are told whether an Auntie is signed
 * in by their route adapters, from the access the admin layout resolved before
 * either screen drew. That is what holds her Complete on the first paint. The
 * owner, the test admin and the #812 offline session (access null) are not the
 * Auntie.
 */
const { useRouteContext } = vi.hoisted(() => ({ useRouteContext: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn(), useRouteContext }));
vi.mock('../screens/Sessions', () => ({
  Sessions: ({ isAuntie }: { isAuntie?: boolean }) => <p>{isAuntie ? 'AUNTIE BOARD' : 'OWNER BOARD'}</p>,
}));
vi.mock('../screens/Schedule', () => ({
  Schedule: ({ isAuntie }: { isAuntie?: boolean }) => <p>{isAuntie ? 'AUNTIE CALENDAR' : 'OWNER CALENDAR'}</p>,
}));

import { SessionsView } from './SessionsView';
import { ScheduleView } from './ScheduleView';

beforeEach(() => useRouteContext.mockReset());

describe('SessionsView and ScheduleView (#2199)', () => {
  it('hand their screens the Auntie flag for an Auntie', () => {
    useRouteContext.mockReturnValue({ access: { status: 'caretaker' } });
    render(
      <>
        <SessionsView />
        <ScheduleView />
      </>,
    );
    expect(screen.getByText('AUNTIE BOARD')).toBeInTheDocument();
    expect(screen.getByText('AUNTIE CALENDAR')).toBeInTheDocument();
    expect(useRouteContext).toHaveBeenCalledWith({ from: '/admin' });
  });

  for (const access of [{ status: 'admin' }, { status: 'testAdmin', testTribeId: 'tribe-sandbox' }, null]) {
    it(`do not for ${access === null ? 'the offline session' : access.status}`, () => {
      useRouteContext.mockReturnValue({ access });
      render(
        <>
          <SessionsView />
          <ScheduleView />
        </>,
      );
      expect(screen.getByText('OWNER BOARD')).toBeInTheDocument();
      expect(screen.getByText('OWNER CALENDAR')).toBeInTheDocument();
    });
  }
});
