// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * #2438 / #2444 and the sweep behind them: an Auntie is never drawn a step she
 * cannot finish. Each of these screens hides its owner-only controls from an
 * `isAuntie` flag, and each route adapter reads that flag off the access the
 * admin layout resolved before the screen drew, so nothing flashes on. The
 * owner, the test admin and the #812 offline session (access null) are not the
 * Auntie.
 *
 * The screens are stand-ins that say which flag they were handed; each has its
 * own suite for what it does with it.
 */
const { useRouteContext, doc } = vi.hoisted(() => ({
  useRouteContext: vi.fn(),
  doc: { current: { status: 'ready', data: { _id: 'kf1', firstName: 'Dre', lastName: 'East' } } as unknown },
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => ({ history: { back: vi.fn() } }),
  useSearch: () => ({}),
  useParams: () => ({ type: 'household', id: 'kf1', kinfolkId: 'kf1' }),
  useRouteContext,
}));
vi.mock('../lib/firestore', () => ({ useDocById: () => doc.current }));

function flag(name: string) {
  return ({ isAuntie }: { isAuntie?: boolean }) => <p>{`${name}: ${isAuntie ? 'auntie' : 'owner'}`}</p>;
}
vi.mock('../screens/Gallery', () => ({ Gallery: flag('gallery') }));
vi.mock('../screens/Media', () => ({ Media: flag('media') }));
vi.mock('../screens/Communicate', () => ({ Communicate: flag('communicate') }));
vi.mock('../screens/Directory', () => ({ Directory: flag('directory') }));
vi.mock('../screens/Inbox', () => ({ Inbox: flag('inbox') }));
vi.mock('../screens/VetClinics', () => ({ VetClinics: flag('vet clinics') }));
vi.mock('../screens/HouseholdMembers', () => ({ HouseholdMembers: flag('members') }));

import { GalleryView } from './GalleryView';
import { MediaView } from './MediaView';
import { CommunicateView } from './CommunicateView';
import { DirectoryView } from './DirectoryView';
import { DirectoryProfileView } from './DirectoryProfileView';
import { InboxView } from './InboxView';
import { VetClinicsView } from './VetClinicsView';
import { HouseholdMembersView } from './HouseholdMembersView';

const SCREENS = ['gallery', 'media', 'communicate', 'inbox', 'vet clinics', 'members'];

function renderAll() {
  render(
    <>
      <GalleryView />
      <MediaView />
      <CommunicateView />
      <DirectoryView />
      <DirectoryProfileView />
      <InboxView />
      <VetClinicsView />
      <HouseholdMembersView />
    </>,
  );
}

beforeEach(() => useRouteContext.mockReset());

describe('the route adapters tell their screens who is signed in', () => {
  it('hand every screen the Auntie flag for an Auntie', () => {
    useRouteContext.mockReturnValue({ access: { status: 'caretaker' } });
    renderAll();
    for (const name of SCREENS) expect(screen.getByText(`${name}: auntie`)).toBeInTheDocument();
    // The list and the household profile are both the Directory screen.
    expect(screen.getAllByText('directory: auntie')).toHaveLength(2);
    expect(screen.queryByText(/: owner$/)).toBeNull();
    expect(useRouteContext).toHaveBeenCalledWith({ from: '/admin' });
  });

  for (const access of [{ status: 'admin' }, { status: 'testAdmin', testTribeId: 'tribe-sandbox' }, null]) {
    it(`do not for ${access === null ? 'the offline session' : access.status}`, () => {
      useRouteContext.mockReturnValue({ access });
      renderAll();
      for (const name of SCREENS) expect(screen.getByText(`${name}: owner`)).toBeInTheDocument();
      expect(screen.getAllByText('directory: owner')).toHaveLength(2);
      expect(screen.queryByText(/: auntie$/)).toBeNull();
    });
  }
});
