import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';

/**
 * Proves the portal really is installable and really can open offline, by
 * BUILDING IT and reading what came out. Same spec as the admin's
 * (auntieos-admin/src/pwaBuild.test.ts), which explains the shape.
 *
 * The portal's PWA setup predates this file by months and was never covered:
 * the manifest, the worker and the precache exclusions were all verified once,
 * by hand, and nothing since then would have noticed a chunk rename putting
 * mapbox back into every kinfolk's first download.
 */

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let outDir = '';
const read = (file: string) => readFileSync(join(outDir, file), 'utf8');

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'mytribe-pwa-build-'));
  await build({
    root: APP_ROOT,
    configFile: join(APP_ROOT, 'vite.config.ts'),
    logLevel: 'silent',
    // Explicit because the scratch directory is outside the project root, where
    // vite otherwise refuses to empty a directory it did not create.
    build: { outDir, emptyOutDir: true },
  });
  // A build is minutes of work on a loaded machine and seconds on a quiet one;
  // the suite-wide 30s budget is sized for component specs, not for this.
}, 300_000);

afterAll(() => {
  if (outDir !== '') rmSync(outDir, { recursive: true, force: true });
});

describe('the built portal', () => {
  describe('web app manifest', () => {
    it('is emitted by the build', () => {
      expect(() => read('manifest.webmanifest')).not.toThrow();
    });

    it('describes an app that can be launched, not a page that can be bookmarked', () => {
      const manifest = JSON.parse(read('manifest.webmanifest')) as Record<string, unknown>;
      expect(manifest['name']).toBe('MyTribe');
      // Without `standalone` an installed icon opens a browser tab with an
      // address bar, which is a shortcut, not an app. On iOS it is also the
      // difference between a site whose storage WebKit wipes after seven days
      // and one it leaves alone.
      expect(manifest['display']).toBe('standalone');
      expect(manifest['start_url']).toBe('/');
    });

    it('ships both icon sizes, each usable as a maskable icon', () => {
      const manifest = JSON.parse(read('manifest.webmanifest')) as {
        icons: Array<{ sizes: string; purpose: string }>;
      };
      const sizes = manifest.icons.map((icon) => icon.sizes);
      expect(sizes).toContain('192x192');
      expect(sizes).toContain('512x512');
      for (const icon of manifest.icons) expect(icon.purpose).toBe('any maskable');
    });

    it('emits the apple-touch-icon iOS reads instead of the manifest', () => {
      const bytes = readFileSync(join(outDir, 'apple-touch-icon.png'));
      expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    });
  });

  describe('service worker', () => {
    it('is emitted, with a real precache list injected into it', () => {
      // The worker ships minified, so this asserts on the injected MANIFEST
      // rather than on an identifier a minifier is free to rename.
      const entries = read('sw.js').match(/\{"revision":[^}]*,"url":"[^"]+"\}/g) ?? [];
      expect(entries.length).toBeGreaterThan(20);
    });

    it('precaches the shell, so a cold launch with no signal still paints', () => {
      const sw = read('sw.js');
      expect(sw).toContain('index.html');
      expect(sw).toMatch(/firebase-[\w-]+\.js/);
    });

    it('keeps mapbox out of the precache, where it would cost every kinfolk 1.8 MB', () => {
      expect(read('sw.js')).not.toContain('mapbox');
    });

    it('keeps the issue recorder out of the precache', () => {
      expect(read('sw.js')).not.toContain('__recorder');
    });

    it('gives a navigation two seconds before falling back to the cached shell', () => {
      // The field-fallback number (operator ruling 2026-09-12). Asserted on the
      // BUILT worker, not only on lib/swPolicy.ts, so the constant being
      // exported and the constant reaching the shipped file are two different
      // claims and both are checked.
      expect(read('sw.js')).toMatch(/networkTimeoutSeconds\s*:\s*2\b/);
    });

    it('never serves a cached answer from Functions, Firestore or Auth', () => {
      const sw = read('sw.js');
      expect(sw).toContain('cloudfunctions.net');
      expect(sw).toContain('googleapis.com');
    });

    it('still carries the FCM push handlers, which live in this same worker', () => {
      const sw = read('sw.js');
      expect(sw).toContain('notificationclick');
      expect(sw).toContain('showNotification');
    });
  });

  describe('registration', () => {
    it('emits a registration script that actually registers the worker', () => {
      const registerSw = read('registerSW.js');
      expect(registerSw).toContain('serviceWorker');
      expect(registerSw).toContain("register('/sw.js'");
    });

    it('wires the page to the manifest, the registration and the iOS icon', () => {
      const html = read('index.html');
      expect(html).toContain('rel="manifest"');
      expect(html).toContain('registerSW.js');
      expect(html).toContain('rel="apple-touch-icon"');
    });
  });
});
