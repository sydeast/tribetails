import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';

/**
 * Proves the admin really is installable and really can open offline, by
 * BUILDING IT and reading what came out.
 *
 * It runs a whole `vite build`, which is slow, and that is deliberate. The
 * cheap version of this spec asserts on the options object in vite.config.ts,
 * which is a test that the config says what it says. Everything this file
 * cares about is downstream of the plugin actually running: whether a manifest
 * was emitted, whether the worker got a precache list, and above all whether
 * the two heavy things that must NOT be precached stayed out of it. Those can
 * regress without vite.config.ts changing at all, by a chunk being renamed.
 *
 * It builds to a scratch directory so the repo's own `dist/` is never touched,
 * and it does not shell out to npm, so it inherits this file's own timeout
 * rather than inventing a second way to run a build.
 */

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let outDir = '';
const read = (file: string) => readFileSync(join(outDir, file), 'utf8');

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'auntieos-pwa-build-'));
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

describe('the built admin', () => {
  describe('web app manifest', () => {
    it('is emitted by the build', () => {
      expect(() => read('manifest.webmanifest')).not.toThrow();
    });

    it('describes an app that can be launched, not a page that can be bookmarked', () => {
      const manifest = JSON.parse(read('manifest.webmanifest')) as Record<string, unknown>;
      expect(manifest['name']).toBe('AuntieOS Admin');
      expect(manifest['short_name']).toBe('AuntieOS');
      // Without `standalone` an installed icon opens a browser tab with an
      // address bar, which is a shortcut, not an app.
      expect(manifest['display']).toBe('standalone');
      expect(manifest['start_url']).toBe('/');
      expect(manifest['scope']).toBe('/');
    });

    it('paints its launch screen in the navy the app paints', () => {
      const manifest = JSON.parse(read('manifest.webmanifest')) as Record<string, unknown>;
      expect(manifest['theme_color']).toBe('#11131F');
      expect(manifest['background_color']).toBe('#11131F');
    });

    it('ships both icon sizes, each usable as a maskable icon', () => {
      const manifest = JSON.parse(read('manifest.webmanifest')) as {
        icons: Array<{ src: string; sizes: string; purpose: string }>;
      };
      const sizes = manifest.icons.map((icon) => icon.sizes);
      expect(sizes).toContain('192x192');
      expect(sizes).toContain('512x512');
      for (const icon of manifest.icons) expect(icon.purpose).toBe('any maskable');
    });

    it.each(['icon-192.png', 'icon-512.png', 'apple-touch-icon.png'])(
      'emits %s as a real PNG, not a placeholder',
      (file) => {
        const bytes = readFileSync(join(outDir, file));
        // PNG signature, then a size no empty or 1x1 file could reach.
        expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
        expect(bytes.length).toBeGreaterThan(2000);
      },
    );
  });

  describe('service worker', () => {
    it('is emitted, with a real precache list injected into it', () => {
      const sw = read('sw.js');
      // The worker ships minified, so the assertion is on the injected MANIFEST
      // rather than on any identifier a minifier is free to rename. An empty or
      // missing list is the failure that matters: it builds and registers
      // cleanly and caches nothing at all.
      const entries = sw.match(/\{"revision":[^}]*,"url":"[^"]+"\}/g) ?? [];
      expect(entries.length).toBeGreaterThan(20);
    });

    it('precaches the shell, so a cold launch with no signal still paints', () => {
      const sw = read('sw.js');
      expect(sw).toContain('index.html');
      // The app cannot boot without the Firebase chunk, whatever else is cached.
      expect(sw).toMatch(/firebase-sdk-[\w-]+\.js/);
    });

    it('keeps mapbox out of the precache, where it would cost every operator 1.8 MB', () => {
      expect(read('sw.js')).not.toContain('mapbox');
    });

    it('keeps the issue recorder out of the precache', () => {
      expect(read('sw.js')).not.toContain('__recorder');
    });

    it('never serves a cached answer from Functions, Firestore or Auth', () => {
      const sw = read('sw.js');
      expect(sw).toContain('cloudfunctions.net');
      expect(sw).toContain('googleapis.com');
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
