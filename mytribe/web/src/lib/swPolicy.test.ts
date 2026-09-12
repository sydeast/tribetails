import { describe, expect, it } from 'vitest';
import {
  NAVIGATION_CACHE_NAME,
  NAVIGATION_NETWORK_TIMEOUT_SECONDS,
  isNavigationRequest,
  isNeverCachedHost,
} from './swPolicy';

describe('swPolicy', () => {
  describe('navigation timeout', () => {
    it('is two seconds, so a weak signal reaches the cached shell quickly', () => {
      // Pinned deliberately. The number is the whole decision (operator ruling
      // 2026-09-12: mobile web is the field fallback), and a silent drift back
      // to five would restore the blank screen it was lowered to remove.
      expect(NAVIGATION_NETWORK_TIMEOUT_SECONDS).toBe(2);
    });

    it('is a real deadline, not zero, so an ordinary load still gets fresh HTML', () => {
      expect(NAVIGATION_NETWORK_TIMEOUT_SECONDS).toBeGreaterThan(0);
    });
  });

  it('names the shell cache, which the worker and any cleanup have to agree on', () => {
    expect(NAVIGATION_CACHE_NAME).toBe('mytribe-pages');
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
      'https://us-central1-auntieos-ttpc.cloudfunctions.net/getMyHome',
      'https://firestore.googleapis.com/v1/projects/auntieos-ttpc/databases',
      'https://identitytoolkit.googleapis.com/v1/accounts:lookup',
      'https://auntieos-ttpc.firebaseio.com/.lp',
    ])('refuses to cache %s', (url) => {
      expect(isNeverCachedHost(new URL(url))).toBe(true);
    });

    it.each([
      'https://kinfolk.tribetails.com/assets/index-abc123.js',
      'https://res.cloudinary.com/tribetails/image/upload/kin.jpg',
    ])('leaves %s to the ordinary caching rules', (url) => {
      expect(isNeverCachedHost(new URL(url))).toBe(false);
    });

    it('is not fooled by a lookalike host that merely contains the name', () => {
      expect(isNeverCachedHost(new URL('https://googleapis.com.example.test/'))).toBe(false);
    });
  });
});
