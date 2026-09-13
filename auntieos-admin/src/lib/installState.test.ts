// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isIos, isStandalone } from './installState';

function setUserAgent(ua: string, maxTouchPoints = 0) {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: ua });
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: maxTouchPoints });
}

function setDisplayMode(standalone: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: standalone && query.includes('standalone') }),
  });
}

function setNavigatorStandalone(value: boolean | undefined) {
  Object.defineProperty(navigator, 'standalone', { configurable: true, value });
}

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15';
const IPAD_OS = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
const PIXEL = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124';

describe('installState', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isIos', () => {
    it('is true on iPhone', () => {
      setUserAgent(IPHONE);
      expect(isIos()).toBe(true);
    });

    it('is true on iPadOS, which reports itself as a Mac', () => {
      setUserAgent(IPAD_OS, 5);
      expect(isIos()).toBe(true);
    });

    it('is false on the operator desktop, same UA and no touch', () => {
      setUserAgent(IPAD_OS, 0);
      expect(isIos()).toBe(false);
    });

    it('is false on Android', () => {
      setUserAgent(PIXEL, 5);
      expect(isIos()).toBe(false);
    });
  });

  describe('isStandalone', () => {
    it('is true when the display mode says the app was launched, not browsed', () => {
      setDisplayMode(true);
      setNavigatorStandalone(undefined);
      expect(isStandalone()).toBe(true);
    });

    it('is true on iOS, which answers only through navigator.standalone', () => {
      setDisplayMode(false);
      setNavigatorStandalone(true);
      expect(isStandalone()).toBe(true);
    });

    it('is false in a plain tab', () => {
      setDisplayMode(false);
      setNavigatorStandalone(false);
      expect(isStandalone()).toBe(false);
    });

    it('survives a browser with no matchMedia at all rather than throwing', () => {
      Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined });
      setNavigatorStandalone(undefined);
      expect(isStandalone()).toBe(false);
    });
  });
});
