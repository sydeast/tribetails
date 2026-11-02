// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { About } from './About';
import { AvatarMenu } from '../components/AvatarMenu';
import { BUSINESS_PUBLIC_CARD_CACHE_KEY, PUBLIC_HOURS_DAYS } from '../lib/businessPublicCard';

/**
 * #1411 (the 2026-11-01 ruling on #1399): "About {business}" shows the name,
 * the week's hours, the public number with Call and Text, the privacy policy
 * and the app version, all from `business_public/card`, the read the sign-in
 * screen makes (#1321). Nothing on it is invented: a blank name titles the page
 * "About your Auntie", a blank number or URL leaves that part out, a closed day
 * reads "Closed".
 */

const { kinfolk, publicCard, version } = vi.hoisted(() => ({
  kinfolk: { current: 'kin-1' as string | null },
  /** What `business_public/card` answers; `null` is a document that is not there. */
  publicCard: { current: null as Record<string, unknown> | null, fail: false },
  version: { current: '0.3.2' },
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...rest }: { children?: ReactNode; to?: string } & Record<string, unknown>) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('../components/PortalNav', () => ({ PortalNav: () => <nav data-testid="portal-nav" /> }));
vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => kinfolk.current }));
vi.mock('../lib/appVersion', () => ({
  get APP_VERSION() {
    return version.current;
  },
}));
vi.mock('firebase/firestore', () => ({
  doc: (..._segments: unknown[]) => ({ path: 'business_public/card' }),
  getDoc: () => {
    if (publicCard.fail) return Promise.reject(new Error('unavailable'));
    const data = publicCard.current;
    return Promise.resolve({ exists: () => data !== null, data: () => data ?? undefined });
  },
}));
vi.mock('../lib/firebase', () => ({ firestore: { name: 'test-firestore' } }));

const SUNNY_PAWS = {
  name: 'Sunny Paws',
  phone: '+15125550142',
  hours: { Monday: '09:00-17:00', Tuesday: '09:00-17:00', Wednesday: '09:00-17:00', Thursday: '09:00-17:00', Friday: '09:00-15:00', Saturday: '', Sunday: '' },
  privacyPolicyUrl: 'https://example.test/privacy',
};

const heading = () => screen.getByRole('heading', { level: 1 });
const hoursRows = () =>
  Array.from(screen.getByTestId('about-hours').querySelectorAll('.about-row')).map((row) => ({
    day: row.querySelector('dt')?.textContent,
    hours: row.querySelector('dd')?.textContent,
  }));

beforeEach(() => {
  localStorage.clear();
  kinfolk.current = 'kin-1';
  publicCard.current = SUNNY_PAWS;
  publicCard.fail = false;
  version.current = '0.3.2';
});

describe('About (#1411)', () => {
  it('titles the page with the business name from the public card', async () => {
    render(<About />);
    await waitFor(() => expect(heading()).toHaveTextContent('About Sunny Paws'));
  });

  it('says "About your Auntie" when no name is set, and never invents one', async () => {
    publicCard.current = { ...SUNNY_PAWS, name: '' };
    render(<About />);
    await screen.findByText('(512) 555-0142');
    expect(heading()).toHaveTextContent('About your Auntie');
    expect(screen.queryByText(/Tribe Tails/)).toBeNull();
  });

  it('lists all seven days, Monday first, a closed day reading Closed', async () => {
    render(<About />);
    await waitFor(() => expect(heading()).toHaveTextContent('Sunny Paws'));
    const rows = hoursRows();
    expect(rows.map((r) => r.day)).toEqual([...PUBLIC_HOURS_DAYS]);
    expect(rows[0]).toEqual({ day: 'Monday', hours: '9:00 AM to 5:00 PM' });
    expect(rows[4]).toEqual({ day: 'Friday', hours: '9:00 AM to 3:00 PM' });
    expect(rows[5]).toEqual({ day: 'Saturday', hours: 'Closed' });
    expect(rows[6]).toEqual({ day: 'Sunday', hours: 'Closed' });
  });

  it('shows the number as text with Call and Text, the way Tribe Profile does', async () => {
    render(<About />);
    await waitFor(() => expect(screen.getByText('(512) 555-0142')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /Call/ })).toHaveAttribute('href', 'tel:+15125550142');
    expect(screen.getByRole('link', { name: /Text/ })).toHaveAttribute('href', 'sms:+15125550142');
  });

  it('leaves the phone section out when no number is set', async () => {
    publicCard.current = { ...SUNNY_PAWS, phone: '' };
    render(<About />);
    await waitFor(() => expect(heading()).toHaveTextContent('Sunny Paws'));
    expect(screen.queryByRole('heading', { name: 'Phone' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Call/ })).toBeNull();
  });

  it('links the privacy policy in a new tab when the URL is set', async () => {
    render(<About />);
    const link = await screen.findByRole('link', { name: 'Privacy policy' });
    expect(link).toHaveAttribute('href', 'https://example.test/privacy');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('has no privacy link when the URL is blank', async () => {
    publicCard.current = { ...SUNNY_PAWS, privacyPolicyUrl: '' };
    render(<About />);
    await waitFor(() => expect(heading()).toHaveTextContent('Sunny Paws'));
    expect(screen.queryByRole('link', { name: 'Privacy policy' })).toBeNull();
    // The version row still earns the card.
    expect(screen.getByText('0.3.2')).toBeInTheDocument();
  });

  it('prints the app version, and omits the row when the build carries none', async () => {
    const first = render(<About />);
    await waitFor(() => expect(screen.getByText('Version')).toBeInTheDocument());
    expect(screen.getByText('0.3.2')).toBeInTheDocument();
    first.unmount();

    version.current = '';
    render(<About />);
    await waitFor(() => expect(heading()).toHaveTextContent('Sunny Paws'));
    expect(screen.queryByText('Version')).toBeNull();
  });

  it('carries no explanatory copy under the titles', async () => {
    const { container } = render(<About />);
    await waitFor(() => expect(heading()).toHaveTextContent('Sunny Paws'));
    expect(container.querySelector('.hero-greet .sub')).toBeNull();
    expect(container.querySelector('.hero-greet .kick')).toBeNull();
    expect(container.querySelector('.card .sub')).toBeNull();
  });

  it('shows the last card this browser saw when the live read fails (offline)', async () => {
    localStorage.setItem(BUSINESS_PUBLIC_CARD_CACHE_KEY, JSON.stringify(SUNNY_PAWS));
    publicCard.fail = true;
    render(<About />);
    expect(heading()).toHaveTextContent('About Sunny Paws');
    expect(screen.getByText('(512) 555-0142')).toBeInTheDocument();
    // A beat later the failed read has changed nothing.
    await waitFor(() => expect(heading()).toHaveTextContent('About Sunny Paws'));
    expect(screen.getByRole('link', { name: 'Privacy policy' })).toBeInTheDocument();
  });

  it('draws the portal chrome once a tribe is active', async () => {
    render(<About />);
    await waitFor(() => expect(heading()).toHaveTextContent('Sunny Paws'));
    expect(screen.getByTestId('portal-nav')).toBeInTheDocument();
  });

  it('opens before a tribe is picked, with the wordmark and no household read behind it', async () => {
    kinfolk.current = null;
    render(<About />);
    await waitFor(() => expect(heading()).toHaveTextContent('Sunny Paws'));
    expect(screen.queryByTestId('portal-nav')).toBeNull();
    expect(screen.getByText('Tribe', { selector: '.grad' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back' })).toHaveAttribute('href', '/');
  });
});

describe('About in the avatar menu (#1411)', () => {
  it('is an item between Notification settings and Sign out, linking to /about', async () => {
    render(<AvatarMenu initial="J" onSignOut={() => {}} signingOut={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(items.map((el) => el.textContent)).toEqual(['Account', 'Notification settings', 'About', 'Sign out']);
    expect(screen.getByRole('menuitem', { name: 'About' })).toHaveAttribute('href', '/about');
  });
});
