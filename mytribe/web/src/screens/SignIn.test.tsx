// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SignIn } from './SignIn';
import { CARETAKER_REASON, SESSION_ENDED_STORAGE_KEY, sessionEndedMessage } from '../lib/revokedSession';

const { navigate, push, search, signIn, publicCard } = vi.hoisted(() => ({
  navigate: vi.fn(),
  push: vi.fn(),
  search: { current: {} as Record<string, unknown> },
  signIn: vi.fn(),
  /** #1321: what `business_public/card` answers; `null` is a document that is not there. */
  publicCard: { current: null as Record<string, unknown> | null, fail: false, getDoc: vi.fn() },
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useSearch: () => search.current,
  useRouter: () => ({ history: { push } }),
}));
vi.mock('../lib/auth', () => ({ signIn, sendReset: vi.fn() }));
vi.mock('firebase/firestore', () => ({
  doc: (..._segments: unknown[]) => ({ path: 'business_public/card' }),
  getDoc: (...args: unknown[]) => {
    publicCard.getDoc(...args);
    if (publicCard.fail) return Promise.reject(new Error('unavailable'));
    const data = publicCard.current;
    return Promise.resolve({ exists: () => data !== null, data: () => data ?? undefined });
  },
}));
vi.mock('../lib/firebase', () => ({ firestore: { name: 'test-firestore' } }));
import { BUSINESS_PUBLIC_CARD_CACHE_KEY } from '../lib/businessPublicCard';

/**
 * #557, the last step of the chain. The backend refuses a revoked session, the
 * callable client signs the kinfolk out and lands them here — and if this
 * screen says nothing, the whole thing reads as "the app logged me out for no
 * reason", which is a worse experience than the bug being fixed.
 */
describe('SignIn session-ended notice', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    publicCard.current = null;
    publicCard.fail = false;
  });

  it('says why, when the sign-out was not the kinfolk’s doing', () => {
    sessionStorage.setItem(SESSION_ENDED_STORAGE_KEY, 'Your session ended, so we signed you out.');
    render(<SignIn />);
    expect(screen.getByTestId('session-ended-notice')).toHaveTextContent(/session ended/i);
  });

  // Docket Q1: an Auntie signed in to the portal, getMyAccess refused her, and
  // the teardown left this for her. Plain words about where she does sign in.
  it('tells an Auntie the portal is for households', () => {
    sessionStorage.setItem(SESSION_ENDED_STORAGE_KEY, sessionEndedMessage(CARETAKER_REASON));
    render(<SignIn />);
    expect(screen.getByTestId('session-ended-notice')).toHaveTextContent(
      'This sign-in is for households. Aunties use the AuntieOS app.',
    );
  });

  it('says nothing on an ordinary visit', () => {
    render(<SignIn />);
    expect(screen.queryByTestId('session-ended-notice')).toBeNull();
  });

  it('shows the notice once — a remount does not resurrect it', () => {
    sessionStorage.setItem(SESSION_ENDED_STORAGE_KEY, 'Your session ended, so we signed you out.');
    const first = render(<SignIn />);
    expect(screen.getByTestId('session-ended-notice')).toBeInTheDocument();
    first.unmount();
    render(<SignIn />);
    expect(screen.queryByTestId('session-ended-notice')).toBeNull();
  });
});

/**
 * #1384: a household that opened an email link while signed out lands on that
 * link after signing in, and a `redirect` that is not an in-app path is
 * ignored rather than followed.
 */
describe('SignIn, landing after sign-in', () => {
  async function submit() {
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'pawsome@hanasamku.com' } });
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: 'pw-not-real' } });
    fireEvent.submit(screen.getByLabelText(/email/i).closest('form') as HTMLFormElement);
    await waitFor(() => expect(navigate.mock.calls.length + push.mock.calls.length).toBe(1));
  }
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
    publicCard.current = null;
    publicCard.fail = false;
    search.current = {};
    signIn.mockResolvedValue(undefined);
  });
  it('goes to Home when no redirect was carried', async () => {
    render(<SignIn />);
    await submit();
    expect(navigate).toHaveBeenCalledWith({ to: '/home' });
    expect(push).not.toHaveBeenCalled();
  });
  it('lands on the carried deep link, search and all', async () => {
    search.current = { redirect: '/invoices/inv_1?from=email' };
    render(<SignIn />);
    await submit();
    expect(push).toHaveBeenCalledWith('/invoices/inv_1?from=email');
    expect(navigate).not.toHaveBeenCalled();
  });
  it.each([
    'https://evil.example/home',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    'home',
    '/signin',
  ])('ignores %s and goes to Home', async (bad) => {
    search.current = { redirect: bad };
    render(<SignIn />);
    await submit();
    expect(navigate).toHaveBeenCalledWith({ to: '/home' });
    expect(push).not.toHaveBeenCalled();
  });
});

/**
 * #1321 ruling, 2026-11-01: the app is MyTribe, and the business it is for is
 * named under it from settings, so a household knows it has the right app. The
 * name comes from the public card, read before sign-in; the headline never
 * waits on that read, and no name is ever invented.
 */
describe('SignIn names the business from the public card (#1321)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
    publicCard.current = null;
    publicCard.fail = false;
  });

  it('shows the MyTribe headline at once and the business line when the card arrives', async () => {
    publicCard.current = { name: 'Sunny Paws', phone: '555-0142' };
    render(<SignIn />);
    expect(screen.getByText(/^My/)).toHaveTextContent('MyTribe');
    expect(screen.queryByTestId('business-byline')).toBeNull();
    expect(await screen.findByTestId('business-byline')).toHaveTextContent('by Sunny Paws');
    expect(screen.getByTestId('business-footnote')).toHaveTextContent('Cared for by Sunny Paws');
    expect(screen.queryByText('Pet Care Portal')).toBeNull();
    expect(screen.queryByText(/Tribe Tails Pet Care/)).toBeNull();
  });

  it('omits the line while the operator has set no name, and invents none', async () => {
    publicCard.current = { name: '', phone: '555-0142' };
    render(<SignIn />);
    await waitFor(() => expect(publicCard.getDoc).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('business-byline')).toBeNull());
    expect(screen.queryByTestId('business-footnote')).toBeNull();
    expect(screen.queryByText(/Tribe Tails/)).toBeNull();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
  });

  it('omits the line when the card does not exist yet', async () => {
    publicCard.current = null;
    render(<SignIn />);
    await waitFor(() => expect(publicCard.getDoc).toHaveBeenCalled());
    expect(screen.queryByTestId('business-byline')).toBeNull();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
  });

  it('shows the cached name on a cold open, before the read returns', () => {
    localStorage.setItem(BUSINESS_PUBLIC_CARD_CACHE_KEY, JSON.stringify({ name: 'Sunny Paws', phone: '', hours: {}, privacyPolicyUrl: '' }));
    render(<SignIn />);
    expect(screen.getByTestId('business-byline')).toHaveTextContent('by Sunny Paws');
  });

  it('caches the name it read for the next cold open', async () => {
    publicCard.current = { name: 'Sunny Paws' };
    render(<SignIn />);
    await screen.findByTestId('business-byline');
    expect(JSON.parse(localStorage.getItem(BUSINESS_PUBLIC_CARD_CACHE_KEY) ?? '{}')).toMatchObject({ name: 'Sunny Paws' });
  });

  it('replaces a stale cached name with the live one', async () => {
    localStorage.setItem(BUSINESS_PUBLIC_CARD_CACHE_KEY, JSON.stringify({ name: 'Old Name', phone: '', hours: {}, privacyPolicyUrl: '' }));
    publicCard.current = { name: 'Sunny Paws' };
    render(<SignIn />);
    expect(screen.getByTestId('business-byline')).toHaveTextContent('by Old Name');
    await waitFor(() => expect(screen.getByTestId('business-byline')).toHaveTextContent('by Sunny Paws'));
  });

  it('keeps the form and the cached name when the read fails', async () => {
    localStorage.setItem(BUSINESS_PUBLIC_CARD_CACHE_KEY, JSON.stringify({ name: 'Sunny Paws', phone: '', hours: {}, privacyPolicyUrl: '' }));
    publicCard.fail = true;
    render(<SignIn />);
    await waitFor(() => expect(publicCard.getDoc).toHaveBeenCalled());
    expect(screen.getByTestId('business-byline')).toHaveTextContent('by Sunny Paws');
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
