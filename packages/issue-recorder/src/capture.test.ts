import { afterEach, describe, expect, it, vi } from 'vitest';
import { PassiveCapture, callableNameOf, describeElement } from './capture';

/**
 * The passive half of the recorder is the part that runs inside somebody else's
 * running app, so its failure modes are not "the test is wrong", they are "the
 * app the operator was walking broke because it was being watched". That is the
 * bar these tests are written to: every one of them names a way the recorder
 * could damage or mislead the walk it is supposed to be evidence for.
 *
 * Everything here runs under jsdom because PassiveCapture reaches for
 * `window.fetch`, `window.XMLHttpRequest` and `console`, and `describeElement`
 * walks a real DOM. See vitest.config.ts for why this package defaults to jsdom
 * where the two apps default to node.
 */

/** Mirrors BODY_LIMIT in capture.ts, which is module-private on purpose. */
const BODY_LIMIT = 4000;
/** Mirrors CONSOLE_LIMIT / NETWORK_LIMIT in capture.ts, same reason. */
const RING_LIMIT = 200;

/**
 * The real globals, taken once before any test has touched them.
 *
 * These tests replace `console.error`, `window.fetch` and `window.XMLHttpRequest`
 * by assignment, which is the only way to prove the recorder wraps whatever it
 * finds rather than the platform original. Assignment is not something
 * `vi.restoreAllMocks` knows how to undo, so the teardown below puts these back
 * by hand. Getting that wrong is not a small thing: a stale fetch stub left in
 * place makes every later test in the file assert against a mock it cannot see,
 * which is precisely the green-over-broken this package exists to stop.
 */
const REAL_FETCH = window.fetch;
const REAL_XHR = window.XMLHttpRequest;
const REAL_CONSOLE = { error: console.error, warn: console.warn, log: console.log };

/**
 * Every capture started by a test is stopped afterwards, INCLUDING after a
 * failing one. A PassiveCapture that is left started has replaced this worker's
 * `console.error` and `window.fetch` with closures over a dead test, so one red
 * test would otherwise poison every test that ran after it and the real
 * failure would be buried under the noise.
 */
const started: PassiveCapture[] = [];
function startCapture(): PassiveCapture {
  const capture = new PassiveCapture();
  capture.start();
  started.push(capture);
  return capture;
}

afterEach(() => {
  while (started.length > 0) started.pop()?.stop();
  vi.restoreAllMocks();
  window.fetch = REAL_FETCH;
  window.XMLHttpRequest = REAL_XHR;
  console.error = REAL_CONSOLE.error;
  console.warn = REAL_CONSOLE.warn;
  console.log = REAL_CONSOLE.log;
  document.body.innerHTML = '';
});

describe('callableNameOf', () => {
  /**
   * The deployed shape. Note that the region is part of the HOSTNAME here
   * (`us-central1-<project>.cloudfunctions.net`), not a path segment, which is
   * why one regex cannot cover both shapes.
   */
  it('reads the name out of a deployed callable URL', () => {
    expect(callableNameOf('https://us-central1-auntieos-ttpc.cloudfunctions.net/getMyAccess')).toBe('getMyAccess');
  });

  it('reads the name out of a deployed callable URL that carries a query', () => {
    expect(callableNameOf('https://us-central1-auntieos-ttpc.cloudfunctions.net/setActiveTribe?alt=json')).toBe(
      'setActiveTribe',
    );
  });

  /**
   * The emulator shape, where the region IS a path segment and the project id
   * sits in front of it. An e2e or a local walk against the emulators dials
   * this one, and a recorder that only understood the deployed shape would
   * report every callable in an emulator walk as `null`, which reads in an
   * issue as "no callable was involved" rather than "the tool cannot tell".
   */
  it('reads the name out of an emulator callable URL', () => {
    expect(callableNameOf('http://127.0.0.1:5001/auntieos-ttpc/us-central1/getMyHome')).toBe('getMyHome');
  });

  it('reads the name out of an emulator callable URL that carries a query', () => {
    expect(callableNameOf('http://localhost:5001/demo-project/us-central1/listInvites?alt=json')).toBe('listInvites');
  });

  it('keeps underscores and digits, which callable names are allowed to contain', () => {
    expect(callableNameOf('https://us-central1-auntieos-ttpc.cloudfunctions.net/v2_getMyAccess')).toBe('v2_getMyAccess');
  });

  /**
   * The null cases matter as much as the matches. A walk is mostly NOT
   * callables: Firestore listens, Storage reads, the app's own assets and the
   * auth endpoints all go through the same wrappers, and labelling one of those
   * as a callable would send whoever reads the issue looking for a Cloud
   * Function that was never called.
   */
  it.each([
    ['a Firestore listen', 'https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel?gsessionid=x'],
    ['an auth endpoint', 'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=abc'],
    ['a Storage download', 'https://firebasestorage.googleapis.com/v0/b/bucket/o/photo.jpg?alt=media'],
    ['an app asset', 'https://kinfolk.tribetails.com/assets/index-4f2a1c.js'],
    ['a same-origin path', '/api/health'],
    ['a bare cloudfunctions host with no function name', 'https://us-central1-auntieos-ttpc.cloudfunctions.net/'],
  ])('returns null for %s', (_label, url) => {
    expect(callableNameOf(url)).toBeNull();
  });
});

describe('describeElement', () => {
  it('returns null when there was no element under the cursor', () => {
    expect(describeElement(null)).toBeNull();
  });

  /**
   * The whole point of the selector is that a mark can become a Cypress
   * selector without anyone re-finding the element by hand, so the preference
   * order is the order of "what would a test actually use".
   */
  it('prefers the id over everything else', () => {
    document.body.innerHTML = `
      <main class="shell"><div class="row" data-testid="household-row" id="household-42">Ada Lovelace</div></main>
    `;
    const el = document.getElementById('household-42');
    expect(describeElement(el)?.selector).toBe('#household-42');
  });

  it('falls back to data-testid when there is no id', () => {
    document.body.innerHTML = `
      <main class="shell"><div class="row" data-testid="household-row">Ada Lovelace</div></main>
    `;
    const el = document.querySelector('[data-testid="household-row"]');
    expect(describeElement(el)?.selector).toBe('[data-testid="household-row"]');
  });

  it('falls back to a tag and class path when there is neither', () => {
    document.body.innerHTML = `
      <main class="shell"><section class="card"><button class="btn grad">Book</button></section></main>
    `;
    const el = document.querySelector('button');
    expect(describeElement(el)?.selector).toBe('main.shell > section.card > button.btn.grad');
  });

  /**
   * The bound is the difference between a selector and a paragraph. An app
   * screen is commonly fifteen or twenty elements deep, and an unbounded path
   * would be unreadable in an issue and would break the moment any wrapper in
   * the middle changed.
   *
   * Ten nested divs, five segments out. If the bound is ever widened or
   * removed, this goes red rather than quietly producing a selector nobody can
   * use.
   */
  it('bounds the class path to five levels', () => {
    let html = '<button class="deep">Go</button>';
    for (let level = 10; level >= 1; level -= 1) html = `<div class="lvl${level}">${html}</div>`;
    document.body.innerHTML = html;

    const selector = describeElement(document.querySelector('button'))?.selector ?? '';
    expect(selector.split(' > ')).toHaveLength(5);
    // The five nearest ancestors, counting the element itself. The outer six
    // wrappers must not appear at all.
    expect(selector).toBe('div.lvl7 > div.lvl8 > div.lvl9 > div.lvl10 > button.deep');
    expect(selector).not.toContain('lvl6');
    expect(selector).not.toContain('lvl5');
  });

  /**
   * Emotion and other CSS-in-JS libraries emit class names like `css-1a2b3c`
   * whose hash changes on every build. A selector built from one is a selector
   * that works exactly once, on the machine that recorded the walk, which is
   * the most expensive kind of wrong: it looks usable.
   */
  it('excludes hashed css- classes so the selector survives the next build', () => {
    document.body.innerHTML = `
      <main class="css-9zx1qq shell"><button class="css-1a2b3c btn">Book</button></main>
    `;
    const selector = describeElement(document.querySelector('button'))?.selector ?? '';
    expect(selector).toBe('main.shell > button.btn');
    expect(selector).not.toContain('css-');
  });

  /**
   * Two classes per element, not all of them. Tailwind-ish and utility-heavy
   * markup routinely carries a dozen classes on one node, and a selector that
   * pinned every one of them would break on any cosmetic change while being
   * no more precise about which element was meant.
   */
  it('keeps at most two classes from any one element', () => {
    document.body.innerHTML = `<button class="a b c d e f">Book</button>`;
    expect(describeElement(document.querySelector('button'))?.selector).toBe('button.a.b');
  });

  it('stops at body rather than walking into html', () => {
    document.body.innerHTML = `<span class="leaf">hi</span>`;
    const selector = describeElement(document.querySelector('span'))?.selector ?? '';
    expect(selector).toBe('span.leaf');
    expect(selector).not.toContain('body');
    expect(selector).not.toContain('html');
  });

  it('handles an element with no classes at all', () => {
    document.body.innerHTML = `<section><p><em>hi</em></p></section>`;
    expect(describeElement(document.querySelector('em'))?.selector).toBe('section > p > em');
  });

  /**
   * The text is what makes a mark read as "the button that says Book" without
   * anyone opening the replay, so it has to survive the whitespace that JSX
   * indentation puts in the DOM.
   */
  it('collapses whitespace in the visible text', () => {
    document.body.innerHTML = `<button class="btn">\n   Book   a\n   visit  </button>`;
    expect(describeElement(document.querySelector('button'))?.text).toBe('Book a visit');
  });

  /**
   * A mark on a container rather than a leaf can pick up a whole screen's text.
   * Unbounded, that is a walk nobody can read and a lot of household data
   * copied into a GitHub issue.
   */
  it('caps the visible text at 200 characters', () => {
    document.body.innerHTML = `<p>${'x'.repeat(500)}</p>`;
    expect(describeElement(document.querySelector('p'))?.text).toHaveLength(200);
  });

  it('reports the tag and the viewport box', () => {
    document.body.innerHTML = `<button class="btn">Book</button>`;
    const described = describeElement(document.querySelector('button'));
    expect(described?.tag).toBe('button');
    expect(described?.rect).toEqual({
      x: expect.any(Number),
      y: expect.any(Number),
      width: expect.any(Number),
      height: expect.any(Number),
    });
  });
});

describe('PassiveCapture console', () => {
  /**
   * THE PASSTHROUGH IS THE POINT. The recorder runs in a browser the operator
   * is also debugging in, and a recorder that ate console.error would mean the
   * devtools console goes quiet exactly while somebody is trying to work out
   * why a screen is wrong.
   */
  it('captures console.error and still writes it to the real console', () => {
    const real = vi.fn();
    console.error = real;
    const capture = startCapture();

    console.error('boom');

    expect(real).toHaveBeenCalledWith('boom');
    expect(capture.drain().console).toEqual([{ level: 'error', at: expect.any(Number), text: 'boom' }]);
  });

  it('captures console.warn and still writes it to the real console', () => {
    const real = vi.fn();
    console.warn = real;
    const capture = startCapture();

    console.warn('careful');

    expect(real).toHaveBeenCalledWith('careful');
    expect(capture.drain().console).toEqual([{ level: 'warn', at: expect.any(Number), text: 'careful' }]);
  });

  /**
   * `log` is deliberately not captured: both apps use it for ordinary chatter,
   * and including it would bury the React errors that are the reason console is
   * recorded at all.
   */
  it('leaves console.log alone', () => {
    const real = vi.fn();
    console.log = real;
    const capture = startCapture();

    console.log('routine');

    expect(console.log).toBe(real);
    expect(capture.drain().console).toEqual([]);
  });

  /**
   * React does not hand `console.error` a tidy string. It hands it a format
   * string plus arguments, and a thrown effect arrives as an Error object, so
   * a recorder that only handled strings would record `[object Object]` for
   * the one line that mattered.
   */
  it('stringifies the arguments React actually passes', () => {
    console.error = vi.fn();
    const capture = startCapture();

    console.error('Warning:', { component: 'Household' }, new TypeError('el is not a function'));

    expect(capture.drain().console[0]?.text).toBe(
      'Warning: {"component":"Household"} TypeError: el is not a function',
    );
  });

  it('falls back to String() for a value JSON cannot serialise', () => {
    console.error = vi.fn();
    const capture = startCapture();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    console.error(circular);

    expect(capture.drain().console[0]?.text).toBe('[object Object]');
  });

  /**
   * Per-mark, not cumulative. A mark that carried every error of the whole walk
   * would bury the one that belongs to this screen, which is the specific way
   * these reports used to be useless.
   */
  it('drain returns only what happened since the previous drain', () => {
    console.error = vi.fn();
    const capture = startCapture();

    console.error('first screen');
    expect(capture.drain().console.map((e) => e.text)).toEqual(['first screen']);

    // Nothing happened between the two marks, so the second mark must be empty
    // rather than repeating the first mark's evidence.
    expect(capture.drain().console).toEqual([]);

    console.error('second screen');
    expect(capture.drain().console.map((e) => e.text)).toEqual(['second screen']);
  });

  /**
   * The buffer is drained at every mark, but a walk can go a long time between
   * marks and a screen stuck in a render loop emits console.error thousands of
   * times a minute. Unbounded, that is the tab running out of memory during the
   * very walk that was recording the bug.
   *
   * The bound keeps the NEWEST entries: the errors nearest the moment the
   * operator noticed are the ones that explain it.
   */
  it('bounds the console buffer and keeps the newest entries', () => {
    console.error = vi.fn();
    const capture = startCapture();

    for (let i = 0; i < RING_LIMIT + 50; i += 1) console.error(`msg-${i}`);

    const drained = capture.drain().console;
    expect(drained).toHaveLength(RING_LIMIT);
    expect(drained[0]?.text).toBe('msg-50');
    expect(drained[drained.length - 1]?.text).toBe(`msg-${RING_LIMIT + 49}`);
  });

  /**
   * `stop()` has to stop CAPTURING, not merely stop being obvious about it.
   * The overlay's export path stops the recorder in a page the operator then
   * keeps using, and a wrapper that survived would go on appending to a walk
   * that has already been written out and downloaded.
   *
   * Asserted behaviourally rather than by reference identity, because it is
   * NOT restored by identity: `watchConsole` keeps `console[level].bind(console)`
   * and puts that bound copy back, so after a start/stop cycle `console.error`
   * is a new function object that forwards to the original. Harmless for
   * calling, and worth knowing before anyone writes code that compares the
   * reference or that repeats start/stop and expects no accumulation.
   */
  it('stop stops capturing and hands calls back to the real console', () => {
    const realError = vi.fn();
    const realWarn = vi.fn();
    console.error = realError;
    console.warn = realWarn;

    const capture = new PassiveCapture();
    capture.start();
    const wrapped = console.error;
    expect(wrapped).not.toBe(realError);
    capture.stop();

    expect(console.error).not.toBe(wrapped);
    console.error('after stop');
    console.warn('after stop');

    expect(realError).toHaveBeenCalledWith('after stop');
    expect(realWarn).toHaveBeenCalledWith('after stop');
    // Nothing reached the buffer, which is the part that would leak.
    expect(capture.drain().console).toEqual([]);
  });
});

describe('PassiveCapture fetch', () => {
  /**
   * Installs a fetch the test controls, BEFORE the capture wraps it, and hands
   * back the same reference so restoration can be asserted by identity.
   */
  function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
    const stub = vi.fn(impl);
    window.fetch = stub as unknown as typeof window.fetch;
    return stub;
  }

  /**
   * THIS IS THE TEST THIS FILE EXISTS FOR.
   *
   * A `Response` body can be read exactly once. If the recorder read the real
   * response instead of a clone, the app's own `await response.json()` would
   * throw on every single callable, and the recorder would break the screen it
   * was pointed at while producing a walk that "proves" the screen is broken.
   * That is the worst possible failure for this tool: it would manufacture the
   * bugs it reports.
   *
   * Both halves are asserted together on purpose. Checking only that the entry
   * was recorded would stay green with the clone removed.
   */
  it('records the response without consuming the body the caller is about to read', async () => {
    const payload = JSON.stringify({ data: { tribeId: 'tribe-1' } });
    stubFetch(async () => new Response(payload, { status: 200 }));
    const capture = startCapture();

    const response = await window.fetch('https://us-central1-auntieos-ttpc.cloudfunctions.net/getMyAccess', {
      method: 'POST',
      body: '{"data":{}}',
    });

    // The app has not touched the body yet, and the recorder must not have
    // either. `bodyUsed` is the direct reading of that.
    expect(response.bodyUsed).toBe(false);
    // And the app's read succeeds and returns everything, which is the thing
    // the operator would actually notice breaking.
    await expect(response.text()).resolves.toBe(payload);

    const [entry] = capture.drain().network;
    expect(entry).toMatchObject({
      method: 'POST',
      url: 'https://us-central1-auntieos-ttpc.cloudfunctions.net/getMyAccess',
      callable: 'getMyAccess',
      status: 200,
      requestBody: '{"data":{}}',
      responseBody: payload,
      error: null,
    });
    expect(entry?.durationMs).toEqual(expect.any(Number));
  });

  it('records a non-2xx status rather than treating it as a failure', async () => {
    stubFetch(async () => new Response('{"error":{"status":"PERMISSION_DENIED"}}', { status: 403 }));
    const capture = startCapture();

    await window.fetch('https://us-central1-auntieos-ttpc.cloudfunctions.net/listInvites', { method: 'POST' });

    expect(capture.drain().network[0]).toMatchObject({
      status: 403,
      callable: 'listInvites',
      responseBody: '{"error":{"status":"PERMISSION_DENIED"}}',
      error: null,
    });
  });

  /**
   * A walk crosses real household data and the export ends up attached to a
   * GitHub issue, so bodies are cut. The marker is part of the contract:
   * without it a truncated body reads as a malformed response and sends
   * whoever reads the issue after a parsing bug that does not exist.
   */
  it('truncates a long response body and says so', async () => {
    const huge = 'y'.repeat(BODY_LIMIT + 500);
    stubFetch(async () => new Response(huge, { status: 200 }));
    const capture = startCapture();

    await window.fetch('/api/big');

    const body = capture.drain().network[0]?.responseBody ?? '';
    expect(body).toContain(`truncated at ${BODY_LIMIT} chars`);
    expect(body.startsWith('y'.repeat(BODY_LIMIT))).toBe(true);
    expect(body).not.toContain('y'.repeat(BODY_LIMIT + 1));
  });

  it('truncates a long request body too', async () => {
    stubFetch(async () => new Response('ok', { status: 200 }));
    const capture = startCapture();

    await window.fetch('/api/big', { method: 'POST', body: 'z'.repeat(BODY_LIMIT + 500) });

    expect(capture.drain().network[0]?.requestBody).toContain(`truncated at ${BODY_LIMIT} chars`);
  });

  /**
   * A failed fetch is the single most useful thing this recorder can catch:
   * "the screen just spins" is usually a callable that never answered. The
   * rethrow matters just as much, because swallowing it would leave the app in
   * a state it never reaches in production.
   */
  it('records a rejected fetch and rethrows it to the caller', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    const capture = startCapture();

    await expect(
      window.fetch('https://us-central1-auntieos-ttpc.cloudfunctions.net/getMyHome', { method: 'POST' }),
    ).rejects.toThrow('Failed to fetch');

    expect(capture.drain().network[0]).toMatchObject({
      callable: 'getMyHome',
      status: null,
      responseBody: null,
      error: 'Failed to fetch',
    });
  });

  /**
   * A response that cannot be cloned to text (a stream, an opaque cross-origin
   * response) must still leave a network entry. Recording that the call
   * happened beats recording nothing, and losing the entry entirely would read
   * as "the app never called that".
   */
  it('still records the call when the body cannot be read as text', async () => {
    stubFetch(async () => {
      const response = new Response('unreadable', { status: 200 });
      // Stands in for an opaque or already-disturbed response: clone() is what
      // the recorder reaches for, and this is what it feels like when it fails.
      Object.defineProperty(response, 'clone', {
        value: () => {
          throw new TypeError('Response body is unusable');
        },
      });
      return response;
    });
    const capture = startCapture();

    await window.fetch('/api/stream');

    expect(capture.drain().network[0]).toMatchObject({ status: 200, responseBody: null, error: null });
  });

  /**
   * The apps do not only call `fetch(url, init)`. The Firebase SDK builds
   * `Request` objects, and app code builds `URL`s. A recorder that only read
   * the string form would log `[object Request]` as the URL and `null` as the
   * callable for the calls that matter most.
   */
  it('reads the url and method off a Request argument', async () => {
    stubFetch(async () => new Response('{}', { status: 200 }));
    const capture = startCapture();

    await window.fetch(
      new Request('https://us-central1-auntieos-ttpc.cloudfunctions.net/setActiveTribe', { method: 'POST' }),
    );

    expect(capture.drain().network[0]).toMatchObject({
      url: 'https://us-central1-auntieos-ttpc.cloudfunctions.net/setActiveTribe',
      method: 'POST',
      callable: 'setActiveTribe',
    });
  });

  it('reads the url off a URL argument', async () => {
    stubFetch(async () => new Response('{}', { status: 200 }));
    const capture = startCapture();

    await window.fetch(new URL('http://127.0.0.1:5001/demo-project/us-central1/getMyAccess'));

    expect(capture.drain().network[0]).toMatchObject({
      url: 'http://127.0.0.1:5001/demo-project/us-central1/getMyAccess',
      method: 'GET',
      callable: 'getMyAccess',
    });
  });

  /**
   * Same reason as the console bound: a screen retrying a failed callable in a
   * loop is exactly the kind of defect this tool is for, and it is also the
   * one that would grow this buffer without limit.
   */
  it('bounds the network buffer and keeps the newest entries', async () => {
    stubFetch(async () => new Response('ok', { status: 200 }));
    const capture = startCapture();

    for (let i = 0; i < RING_LIMIT + 50; i += 1) await window.fetch(`/api/req-${i}`);

    const drained = capture.drain().network;
    expect(drained).toHaveLength(RING_LIMIT);
    expect(drained[0]?.url).toBe('/api/req-50');
    expect(drained[drained.length - 1]?.url).toBe(`/api/req-${RING_LIMIT + 49}`);
  });

  it('drain returns only the requests since the previous drain', async () => {
    stubFetch(async () => new Response('ok', { status: 200 }));
    const capture = startCapture();

    await window.fetch('/api/one');
    expect(capture.drain().network.map((n) => n.url)).toEqual(['/api/one']);
    expect(capture.drain().network).toEqual([]);

    await window.fetch('/api/two');
    expect(capture.drain().network.map((n) => n.url)).toEqual(['/api/two']);
  });

  /**
   * Same contract as the console one, and the same caveat: the wrapper is
   * removed and calls reach the app's own fetch again, but what goes back is
   * `original.bind(window)` rather than the original reference. See the console
   * restoration test for why that is worth stating out loud.
   */
  it('stop stops capturing and hands calls back to the real fetch', async () => {
    const stub = stubFetch(async () => new Response('ok', { status: 200 }));
    const capture = new PassiveCapture();
    capture.start();
    const wrapped = window.fetch;
    expect(wrapped).not.toBe(stub);
    capture.stop();

    expect(window.fetch).not.toBe(wrapped);
    await window.fetch('/api/after-stop');

    expect(stub).toHaveBeenCalled();
    expect(capture.drain().network).toEqual([]);
  });
});

describe('PassiveCapture xhr', () => {
  /**
   * Firestore's WebChannel rides XHR rather than fetch, and "the list never
   * loads" is usually a listener that failed. The wrapper is a subclass, so
   * the things worth pinning are that it forwards faithfully and that it can
   * be taken back off.
   */
  it('forwards open to the real XMLHttpRequest', () => {
    const open = vi.spyOn(window.XMLHttpRequest.prototype, 'open').mockImplementation(() => undefined);
    startCapture();

    new window.XMLHttpRequest().open('POST', 'http://127.0.0.1:5001/demo-project/us-central1/getMyAccess');

    expect(open).toHaveBeenCalledWith(
      'POST',
      'http://127.0.0.1:5001/demo-project/us-central1/getMyAccess',
      // The third argument is the one that matters. `open` is declared with an
      // optional `async` that the wrapper defaults to true before forwarding,
      // because a caller that omits it is asking for an async request and a
      // synchronous XHR would freeze the page being recorded.
      true,
      undefined,
      undefined,
    );
  });

  it('passes an explicitly synchronous open through unchanged rather than overriding it', () => {
    const open = vi.spyOn(window.XMLHttpRequest.prototype, 'open').mockImplementation(() => undefined);
    startCapture();

    new window.XMLHttpRequest().open('GET', '/api/thing', false);

    expect(open).toHaveBeenCalledWith('GET', '/api/thing', false, undefined, undefined);
  });

  it('accepts a URL object the way the real open does', () => {
    const open = vi.spyOn(window.XMLHttpRequest.prototype, 'open').mockImplementation(() => undefined);
    startCapture();

    new window.XMLHttpRequest().open('GET', new URL('https://kinfolk.tribetails.com/api/thing'));

    expect(open.mock.calls[0]?.[1]).toBeInstanceOf(URL);
  });

  it('stop puts the original XMLHttpRequest constructor back', () => {
    const original = window.XMLHttpRequest;
    const capture = new PassiveCapture();
    capture.start();
    expect(window.XMLHttpRequest).not.toBe(original);
    capture.stop();

    expect(window.XMLHttpRequest).toBe(original);
  });
});

describe('PassiveCapture xhr recording', () => {
  /**
   * The XHR path is driven WITHOUT a real server, and that is a deliberate
   * choice rather than a shortcut.
   *
   * Standing up a loopback `node:http` server would drag `@types/node` into a
   * package that otherwise has no Node surface at all, and it would make the
   * suite depend on a socket, a port and jsdom's CORS handling: three things
   * that can go red without the recorder having changed. What actually needs
   * pinning is the twenty-odd lines inside the `loadend` listener, and those
   * are reachable directly.
   *
   * `open` and `send` are stubbed at the prototype, so `super.send` does
   * nothing and no request leaves the process. The recorder registers its own
   * `loadend` listener BEFORE calling `super.send`, so dispatching the event by
   * hand runs exactly the code a real response would run, with `status` and
   * `response` set to whatever the case under test needs.
   */
  function stubbedXhr() {
    vi.spyOn(window.XMLHttpRequest.prototype, 'open').mockImplementation(() => undefined);
    vi.spyOn(window.XMLHttpRequest.prototype, 'send').mockImplementation(() => undefined);
    const capture = startCapture();
    return { capture, make: () => new window.XMLHttpRequest() };
  }
  /** Sets what the response looks like, then fires the event the recorder listens for. */
  function complete(xhr: XMLHttpRequest, status: number, response: unknown): void {
    Object.defineProperty(xhr, 'status', { value: status, configurable: true });
    Object.defineProperty(xhr, 'response', { value: response, configurable: true });
    xhr.dispatchEvent(new Event('loadend'));
  }
  /**
   * Firestore's WebChannel rides XHR rather than fetch, so a screen stuck on a
   * failing listener is invisible to the fetch wrapper. "The list never loads"
   * is one of the most common things worth recording, and this is the only
   * wrapper that can see it.
   */
  it('records a completed request with its status, bodies and callable', () => {
    const { capture, make } = stubbedXhr();
    const url = 'http://127.0.0.1:5001/demo-project/us-central1/getMyHome';
    const xhr = make();
    xhr.open('POST', url);
    xhr.send('{"data":{}}');
    complete(xhr, 200, '{"data":{"ok":true}}');
    const [entry] = capture.drain().network;
    expect(entry).toMatchObject({
      method: 'POST',
      url,
      callable: 'getMyHome',
      status: 200,
      requestBody: '{"data":{}}',
      responseBody: '{"data":{"ok":true}}',
      error: null,
    });
    expect(entry?.durationMs).toEqual(expect.any(Number));
  });
  /**
   * A request that never completed is the shape of "the screen just spins".
   * XHR reports it as status 0, which has to become a null status plus a
   * stated error: recording it as "the server answered 0" would send whoever
   * reads the issue looking for a response that never existed.
   */
  it('records a request that never completed as no status and a stated error', () => {
    const { capture, make } = stubbedXhr();
    const xhr = make();
    xhr.open('GET', 'https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel');
    xhr.send();
    complete(xhr, 0, '');
    expect(capture.drain().network[0]).toMatchObject({
      status: null,
      error: 'request did not complete',
      callable: null,
      requestBody: null,
    });
  });
  /**
   * A 4xx or 5xx is a completed request, not a failure. Collapsing it into the
   * error case would lose the status, which is usually the entire explanation.
   */
  it('records a server error status as a status rather than as an error', () => {
    const { capture, make } = stubbedXhr();
    const xhr = make();
    xhr.open('POST', 'https://us-central1-auntieos-ttpc.cloudfunctions.net/listInvites');
    xhr.send();
    complete(xhr, 500, '{"error":"boom"}');
    expect(capture.drain().network[0]).toMatchObject({
      status: 500,
      callable: 'listInvites',
      responseBody: '{"error":"boom"}',
      error: null,
    });
  });
  /**
   * `responseType` can make `response` an ArrayBuffer, a Blob or a parsed
   * object. Only a string is recorded, because stringifying a binary body into
   * a walk would bloat the export for something nobody can read in an issue.
   */
  it('records no body when the response is not text', () => {
    const { capture, make } = stubbedXhr();
    const xhr = make();
    xhr.open('GET', '/api/photo');
    xhr.send();
    complete(xhr, 200, new ArrayBuffer(8));
    expect(capture.drain().network[0]).toMatchObject({ status: 200, responseBody: null });
  });
  it('truncates a long xhr response body', () => {
    const { capture, make } = stubbedXhr();
    const xhr = make();
    xhr.open('GET', '/api/big');
    xhr.send();
    complete(xhr, 200, 'y'.repeat(BODY_LIMIT + 500));
    expect(capture.drain().network[0]?.responseBody).toContain(`truncated at ${BODY_LIMIT} chars`);
  });
});
