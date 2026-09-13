import { describe, expect, it } from 'vitest';
import {
  NAVIGATION_CACHE_NAME,
  NAVIGATION_NETWORK_TIMEOUT_SECONDS,
  isNeverCachedHost,
  NAVIGATION_FALLBACK_URL,
  isDeniedNavigation,
  navigationHandler,
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
  describe('navigation fallback', () => {
    it('points at the precached shell every route resolves to', () => {
      expect(NAVIGATION_FALLBACK_URL).toBe('/index.html');
    });
    it.each([
      '/home',
      '/bookings/bk-2291',
      '/kintales/kt-77',
      '/invoices/inv-4?from=email',
      '/',
    ])('answers the in-app route %s', (path) => {
      expect(isDeniedNavigation(new URL(path, 'https://kinfolk.tribetails.com'))).toBe(false);
    });
    it('refuses a shared KinTale page, which a Cloud Function renders itself', () => {
      const url = new URL('/share/kt-77', 'https://kinfolk.tribetails.com');
      expect(isDeniedNavigation(url)).toBe(true);
    });
    it('refuses anything that reads as a file request, which should 404 as a file', () => {
      const base = 'https://kinfolk.tribetails.com';
      expect(isDeniedNavigation(new URL('/assets/index-abc123.js', base))).toBe(true);
      expect(isDeniedNavigation(new URL('/icon-192.png', base))).toBe(true);
    });
  });
  describe('navigationHandler', () => {
    const shellResponse = 'the precached shell';
    it('serves the network answer whenever there is one', async () => {
      const handle = navigationHandler({
        fromNetwork: () => Promise.resolve('fresh from the network'),
        fromPrecachedShell: () => Promise.resolve(shellResponse),
      });
      await expect(handle({})).resolves.toBe('fresh from the network');
    });
    it('serves the precached shell when the network gives nothing at all', async () => {
      const handle = navigationHandler({
        fromNetwork: () => Promise.reject(new Error('Failed to fetch')),
        fromPrecachedShell: () => Promise.resolve(shellResponse),
      });
      await expect(handle({})).resolves.toBe(shellResponse);
    });
    it('passes a real 404 or 500 through untouched, since those are answers', async () => {
      // NetworkFirst RESOLVES with an error response rather than rejecting, so
      // the fallback must never see it. A server saying "no" has to reach the
      // browser as "no", not as the app shell.
      const handle = navigationHandler({
        fromNetwork: () => Promise.resolve('404 from the server'),
        fromPrecachedShell: () => Promise.resolve(shellResponse),
      });
      await expect(handle({})).resolves.toBe('404 from the server');
    });
    it('tries the network first every time, rather than pre-empting it', async () => {
      const order: string[] = [];
      const handle = navigationHandler({
        fromNetwork: () => {
          order.push('network');
          return Promise.reject(new Error('offline'));
        },
        fromPrecachedShell: () => {
          order.push('shell');
          return Promise.resolve(shellResponse);
        },
      });
      await handle({});
      expect(order).toEqual(['network', 'shell']);
    });
  });
});
