import { describe, it, expect } from 'vitest';
import { firestoreCacheMode } from './firestoreCache';

/**
 * The cache choice is a pure function precisely so it can be asserted without
 * booting Firebase. `lib/firebase.ts` calls `initializeFirestore` at module
 * load, so a spec that imported it to check the cache would be starting a real
 * SDK instance to read one string.
 */
describe('firestoreCacheMode', () => {
  it('persists when the browser has IndexedDB: the field tap needs a queue', () => {
    expect(firestoreCacheMode(true)).toBe('persistent');
  });

  // Private windows, blocked site data, and every vitest spec (jsdom has no
  // IndexedDB) land here. The point of naming it rather than letting the SDK
  // fall back silently is that a surface can DISCLOSE it.
  it('falls back to memory when there is none, and says so rather than pretending', () => {
    expect(firestoreCacheMode(false)).toBe('memory');
  });

  it('reads the live global when nothing is passed', () => {
    expect(['persistent', 'memory']).toContain(firestoreCacheMode());
  });
  // Playwright and Cypress run real Chromium, which HAS IndexedDB, and neither
  // clears it between tests. A surviving Firestore store would hand a live
  // listener the PREVIOUS test's document from cache before the emulator's own.
  it('refuses the cache in an e2e run even where IndexedDB exists', () => {
    expect(firestoreCacheMode(true, true)).toBe('memory');
  });
});
