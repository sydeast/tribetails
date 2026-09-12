import { describe, expect, it } from 'vitest';
import {
  NAVIGATION_CACHE_NAME,
  NAVIGATION_NETWORK_TIMEOUT_SECONDS,
  isNavigationRequest,
  isNeverCachedHost,
} from './swPolicy';

const ORIGIN = 'https://auntie.tribetails.com';

describe('swPolicy', () => {
  describe('navigation timeout', () => {
    it('is two seconds, so a weak signal reaches the cached shell quickly', () => {
      // Pinned deliberately. The number is the whole decision (operator ruling
      // 2026-09-12: mobile web is the field fallback), and a drift upward would
      // restore the blank screen it exists to prevent.
      expect(NAVIGATION_NETWORK_TIMEOUT_SECONDS).toBe(2);
    });

    it('is a real deadline, not zero, so an ordinary load still gets fresh HTML', () => {
      expect(NAVIGATION_NETWORK_TIMEOUT_SECONDS).toBeGreaterThan(0);
    });
  });

  it('names a shell cache of its own, not the portal’s', () => {
    expect(NAVIGATION_CACHE_NAME).toBe('auntieos-pages');
  });

  describe('isNavigationRequest', () => {
    it('is true for a top-level page load', () => {
      expect(isNavigationRequest({ mode: 'navigate' } as Request)).toBe(true);
    });

    it('is false for a subresource, which the precache answers instead', () => {
      expect(isNavigationRequest({ mode: 'cors' } as Request)).toBe(false);
      expect(isNavigationRequest({ mode: 'no-cors' } as Request)).toBe(false);
    });
  });

  describe('isNeverCachedHost', () => {
    it.each([
      'https://us-central1-auntieos-ttpc.cloudfunctions.net/listBookings',
      'https://firestore.googleapis.com/v1/projects/auntieos-ttpc/databases',
      'https://identitytoolkit.googleapis.com/v1/accounts:lookup',
      'https://auntieos-ttpc.firebaseio.com/.lp',
      'https://generateauntiecopy-abc123-uc.a.run.app/',
    ])('refuses to cache %s', (url) => {
      expect(isNeverCachedHost(new URL(url), ORIGIN)).toBe(true);
    });

    it.each([
      `${ORIGIN}/api/generate`,
      `${ORIGIN}/api/cloudinary/sign-upload`,
    ])('refuses to cache the same-origin rewrite %s', (url) => {
      // These two are functions wearing this site's own hostname (see the
      // rewrites in firebase.json). Without the path clause they would be
      // cached like any other same-origin request.
      expect(isNeverCachedHost(new URL(url), ORIGIN)).toBe(true);
    });

    it.each([
      `${ORIGIN}/assets/index-abc123.js`,
      `${ORIGIN}/bookings`,
      'https://res.cloudinary.com/tribetails/image/upload/kin.jpg',
    ])('leaves %s to the ordinary caching rules', (url) => {
      expect(isNeverCachedHost(new URL(url), ORIGIN)).toBe(false);
    });

    it('does not treat another origin’s /api/ path as this app’s rewrite', () => {
      expect(isNeverCachedHost(new URL('https://example.test/api/generate'), ORIGIN)).toBe(false);
    });

    it('is not fooled by a lookalike host that merely contains the name', () => {
      expect(isNeverCachedHost(new URL('https://googleapis.com.example.test/'), ORIGIN)).toBe(false);
    });
  });
});
