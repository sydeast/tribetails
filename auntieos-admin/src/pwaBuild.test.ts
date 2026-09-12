import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
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

/**
 * Runs the BUILT service worker in a fake ServiceWorkerGlobalScope and lets a
 * spec dispatch real events at it.
 *
 * WHY GO THIS FAR. Everything else in this file reads the build's output as
 * text, which proves a file was emitted and what is listed in it. It cannot
 * prove the one thing that actually matters on a driveway: that a navigation
 * to a route this device has never opened, with no network, comes back as the
 * app instead of as nothing. That answer lives in the interaction between
 * Workbox's NavigationRoute, the precache and our own fallback, so the only
 * honest way to check it is to run the worker.
 *
 * The scope below is a stub of the parts of the worker global the bundle
 * touches. Two of them are worth knowing about:
 *
 * `Request` is subclassed because Node's requires an absolute URL while a real
 * worker resolves a relative one against `location`. Without the shim
 * `createHandlerBoundToURL('/index.html')` throws for a reason the browser
 * would never produce.
 *
 * `FetchEvent` has to exist as a constructor, because Workbox branches on
 * `event instanceof FetchEvent` when deciding whether it was handed an event
 * or a plain options object.
 */
class FakeExtendableEvent {
  readonly waits: Array<Promise<unknown>> = [];
  constructor(readonly type: string) {}
  waitUntil(p: Promise<unknown>) {
    this.waits.push(p);
  }
}

class FakeFetchEvent extends FakeExtendableEvent {
  responded: Promise<Response> | undefined;
  readonly preloadResponse = Promise.resolve(undefined);
  constructor(readonly request: Request) {
    super('fetch');
  }
  respondWith(p: Promise<Response>) {
    this.responded = p;
  }
}

/** The answer a dispatched navigation produced. */
interface Answer {
  /** False when no route matched and the browser would have gone to the network itself. */
  handled: boolean;
  /** True when the worker took the request and then failed to produce anything. */
  failed: boolean;
  status?: number;
  body?: string;
}

async function bootWorker(swSource: string, origin: string) {
  const SHELL_BODY = '<!DOCTYPE html><title>the precached shell</title>';
  let online = true;
  const caches = new Map<string, Map<string, Response>>();
  const cacheFor = (name: string) => {
    const existing = caches.get(name);
    if (existing) return existing;
    const created = new Map<string, Response>();
    caches.set(name, created);
    return created;
  };
  const asKey = (r: Request | string) => (typeof r === 'string' ? new URL(r, origin).href : r.url);
  const wrap = (store: Map<string, Response>) => ({
    match: async (r: Request | string) => store.get(asKey(r))?.clone(),
    put: async (r: Request | string, response: Response) => {
      store.set(asKey(r), response.clone());
    },
    delete: async () => true,
    keys: async () => [...store.keys()].map((u) => new Request(u)),
  });

  class ScopedRequest extends Request {
    constructor(input: RequestInfo, init?: RequestInit) {
      super(typeof input === 'string' ? new URL(input, origin).href : input, init);
    }
  }

  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const scope: Record<string, unknown> = {
    location: new URL(origin + '/'),
    registration: { scope: origin + '/', showNotification: async () => undefined },
    clients: { claim: async () => undefined, matchAll: async () => [], openWindow: async () => undefined },
    skipWaiting: async () => undefined,
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      const existing = listeners.get(type);
      if (existing) existing.push(fn);
      else listeners.set(type, [fn]);
    },
    removeEventListener: () => undefined,
    fetch: async (input: Request | string) => {
      if (!online) throw new TypeError('Failed to fetch');
      const url = typeof input === 'string' ? input : input.url;
      const body = url.includes('index.html') ? SHELL_BODY : `asset for ${url}`;
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } });
    },
    caches: {
      open: async (name: string) => wrap(cacheFor(name)),
      match: async (r: Request | string) => {
        for (const store of caches.values()) {
          const hit = await wrap(store).match(r);
          if (hit) return hit;
        }
        return undefined;
      },
      keys: async () => [...caches.keys()],
      delete: async (name: string) => caches.delete(name),
    },
    ExtendableEvent: FakeExtendableEvent,
    FetchEvent: FakeFetchEvent,
    Request: ScopedRequest,
    Response,
    Headers,
    URL,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    console,
    crypto,
    navigator: { userAgent: 'vitest' },
  };
  scope['self'] = scope;
  scope['globalThis'] = scope;

  runInContext(swSource, createContext(scope), { filename: 'sw.js' });

  async function dispatch(event: FakeExtendableEvent) {
    for (const fn of listeners.get(event.type) ?? []) fn(event);
    await Promise.all(event.waits);
  }

  // Install and activate while the network still works, exactly as a first
  // visit does, so the precache is populated by the worker itself rather than
  // by the test reaching into the cache and putting the shell there.
  await dispatch(new FakeExtendableEvent('install'));
  await dispatch(new FakeExtendableEvent('activate'));

  async function request(path: string, mode: RequestMode): Promise<Answer> {
    const target = new URL(path, origin).href;
    // The scope's OWN Request class, not the ambient one. Vitest runs with
    // NODE_ENV=test, so the worker bundles Workbox's development variant, which
    // asserts `request instanceof Request` against the constructor it can see.
    // That variant is stricter than the one that ships rather than weaker, so
    // it is worth satisfying instead of working around.
    const req = new ScopedRequest(target);
    Object.defineProperty(req, 'mode', { value: mode });
    const event = new FakeFetchEvent(req);
    await dispatch(event);
    if (event.responded === undefined) return { handled: false, failed: false };
    try {
      const response = await event.responded;
      return { handled: true, failed: false, status: response.status, body: await response.text() };
    } catch {
      return { handled: true, failed: true };
    }
  }

  return {
    SHELL_BODY,
    goOffline: () => {
      online = false;
    },
    /** A top-level page load, the thing a deep link produces. */
    navigate: (path: string) => request(path, 'navigate'),
    /** Anything the page itself fetches: an API call, an asset. */
    subresource: (path: string) => request(path, 'cors'),
  };
}

describe('the worker, actually running, with the network gone', () => {
  const ORIGIN = 'https://auntie.tribetails.com';
  let worker: Awaited<ReturnType<typeof bootWorker>>;
  beforeAll(async () => {
    worker = await bootWorker(read('sw.js'), ORIGIN);
    worker.goOffline();
  }, 120_000);
  it.each(['/bookings/bk-2291', '/sessions/se-18', '/directory/kf-4', '/home'])(
    'answers a cold deep link to %s with the precached shell',
    async (path) => {
      // The whole point of the ruling. The operator is on mobile web BECAUSE
      // Android already failed, and they reach one booking by link, not from
      // the home screen. This device has never opened that URL, so the page
      // cache has nothing for it; the precached shell is the only answer.
      const answer = await worker.navigate(path);
      expect(answer.handled).toBe(true);
      expect(answer.status).toBe(200);
      expect(answer.body).toBe(worker.SHELL_BODY);
    },
  );
  it('refuses to answer a Firestore read from cache, offline or not', async () => {
    const answer = await worker.subresource(
      'https://firestore.googleapis.com/v1/projects/auntieos-ttpc/databases/(default)/documents/bookings',
    );
    expect(answer.failed).toBe(true);
    expect(answer.body).toBeUndefined();
  });
  it('refuses to answer a Cloud Function call from cache', async () => {
    const answer = await worker.subresource(
      'https://us-central1-auntieos-ttpc.cloudfunctions.net/listBookings',
    );
    expect(answer.failed).toBe(true);
  });
  it('never hands the app shell to an /api/* rewrite', async () => {
    const answer = await worker.navigate('/api/generate');
    expect(answer.body).not.toBe(worker.SHELL_BODY);
  });
  it('never hands the app shell to something asking for a file', async () => {
    const answer = await worker.navigate('/assets/does-not-exist-Xy12.js');
    expect(answer.body).not.toBe(worker.SHELL_BODY);
  });
});
