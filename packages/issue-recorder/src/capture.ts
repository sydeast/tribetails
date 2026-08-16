import type { ConsoleEntry, MarkedElement, NetworkEntry } from './types';

/**
 * The passive half of the recorder: what it watches while the operator is just
 * using the app.
 *
 * Everything here is a ring buffer, drained at each mark. The operator marks a
 * moment AFTER seeing something wrong, so the evidence has to already exist by
 * then; asking the app to start recording at the mark would capture the aftermath
 * and miss the cause.
 */

/** Longer than any body worth reading in an issue, short enough that a walk stays openable. */
const BODY_LIMIT = 4000;

/** Bounded so a long walk cannot grow without limit; drained at every mark anyway. */
const CONSOLE_LIMIT = 200;
const NETWORK_LIMIT = 200;

function truncate(text: string): string {
  return text.length <= BODY_LIMIT ? text : `${text.slice(0, BODY_LIMIT)}\n... truncated at ${BODY_LIMIT} chars`;
}

/**
 * The callable's name, or null when the URL is not one.
 *
 * Matches both shapes the apps produce: the deployed
 * `https://us-central1-auntieos-ttpc.cloudfunctions.net/<name>` and the emulator
 * form `http://host:port/<project>/us-central1/<name>` that an e2e or local run
 * dials.
 */
export function callableNameOf(url: string): string | null {
  const match = /\/(?:us-central1)\/([A-Za-z0-9_]+)(?:\?|$)/.exec(url) ?? /cloudfunctions\.net\/([A-Za-z0-9_]+)(?:\?|$)/.exec(url);
  return match?.[1] ?? null;
}

export class PassiveCapture {
  private consoleBuffer: ConsoleEntry[] = [];
  private networkBuffer: NetworkEntry[] = [];
  private readonly startedAt = Date.now();
  private restore: Array<() => void> = [];

  start(): void {
    this.watchConsole();
    this.watchFetch();
    this.watchXhr();
  }

  stop(): void {
    for (const undo of this.restore.reverse()) undo();
    this.restore = [];
  }

  /** Milliseconds since the walk started. */
  private now(): number {
    return Date.now() - this.startedAt;
  }

  /**
   * Everything buffered since the last call, and clears it.
   *
   * Per-mark rather than cumulative: an issue that carried every error of the
   * whole walk would bury the one that belongs to this screen.
   */
  drain(): { console: ConsoleEntry[]; network: NetworkEntry[] } {
    const drained = { console: this.consoleBuffer, network: this.networkBuffer };
    this.consoleBuffer = [];
    this.networkBuffer = [];
    return drained;
  }

  private push<T>(buffer: T[], entry: T, limit: number): void {
    buffer.push(entry);
    if (buffer.length > limit) buffer.shift();
  }

  /**
   * `error` and `warn` only.
   *
   * React reports a thrown effect, a bad prop type and a failed render through
   * `console.error`, which is why the errors matter. `log` is left alone: the
   * apps use it for ordinary chatter and including it would drown the signal.
   */
  private watchConsole(): void {
    for (const level of ['error', 'warn'] as const) {
      const original = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        original(...args);
        this.push(
          this.consoleBuffer,
          { level, at: this.now(), text: args.map((a) => stringify(a)).join(' ') },
          CONSOLE_LIMIT,
        );
      };
      this.restore.push(() => {
        console[level] = original;
      });
    }
  }

  /**
   * Callables go through `fetch`, so this is the one that matters.
   *
   * The response is READ FROM A CLONE. Reading the real one would consume the
   * body the app is about to parse, and the screen would break because it was
   * being watched.
   */
  private watchFetch(): void {
    const original = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const at = this.now();
      const started = Date.now();
      const requestBody = typeof init?.body === 'string' ? truncate(init.body) : null;

      try {
        const response = await original(input as RequestInfo, init);
        let responseBody: string | null = null;
        try {
          responseBody = truncate(await response.clone().text());
        } catch {
          // A streamed or opaque response cannot be cloned to text. Recording
          // that it happened still beats recording nothing.
          responseBody = null;
        }
        this.push(
          this.networkBuffer,
          {
            at,
            method,
            url,
            callable: callableNameOf(url),
            status: response.status,
            durationMs: Date.now() - started,
            requestBody,
            responseBody,
            error: null,
          },
          NETWORK_LIMIT,
        );
        return response;
      } catch (err) {
        this.push(
          this.networkBuffer,
          {
            at,
            method,
            url,
            callable: callableNameOf(url),
            status: null,
            durationMs: Date.now() - started,
            requestBody,
            responseBody: null,
            error: err instanceof Error ? err.message : String(err),
          },
          NETWORK_LIMIT,
        );
        throw err;
      }
    };
    this.restore.push(() => {
      window.fetch = original;
    });
  }

  /**
   * Firestore's WebChannel and anything older ride XHR rather than fetch, and a
   * screen stuck on a failing listener is exactly the kind of "it just spins"
   * report this recorder exists to explain.
   */
  private watchXhr(): void {
    const OriginalXhr = window.XMLHttpRequest;
    const capture = this;

    class RecordingXhr extends OriginalXhr {
      private _method = 'GET';
      private _url = '';
      private _at = 0;
      private _started = 0;
      private _requestBody: string | null = null;

      // `async` defaults to true, matching the spec: a caller that omits it is
      // asking for an async request, and forwarding `undefined` would make it
      // synchronous and freeze the page being recorded.
      override open(method: string, url: string | URL): void;
      override open(
        method: string,
        url: string | URL,
        async: boolean,
        username?: string | null,
        password?: string | null,
      ): void;
      override open(
        method: string,
        url: string | URL,
        async = true,
        username?: string | null,
        password?: string | null,
      ): void {
        this._method = method;
        this._url = typeof url === 'string' ? url : url.href;
        super.open(method, url, async, username, password);
      }

      override send(body?: Document | XMLHttpRequestBodyInit | null): void {
        this._at = capture.now();
        this._started = Date.now();
        this._requestBody = typeof body === 'string' ? truncate(body) : null;
        this.addEventListener('loadend', () => {
          capture.push(
            capture.networkBuffer,
            {
              at: this._at,
              method: this._method,
              url: this._url,
              callable: callableNameOf(this._url),
              status: this.status === 0 ? null : this.status,
              durationMs: Date.now() - this._started,
              requestBody: this._requestBody,
              responseBody: typeof this.response === 'string' ? truncate(this.response) : null,
              error: this.status === 0 ? 'request did not complete' : null,
            },
            NETWORK_LIMIT,
          );
        });
        super.send(body);
      }
    }

    window.XMLHttpRequest = RecordingXhr as unknown as typeof XMLHttpRequest;
    this.restore.push(() => {
      window.XMLHttpRequest = OriginalXhr;
    });
  }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * A CSS path for the element under the cursor.
 *
 * Prefers whatever a test could also use: an id, then a `data-testid`, then a
 * class path bounded to five levels. The point is that a mark can become a
 * Cypress selector without anyone re-finding the element by hand.
 */
export function describeElement(el: Element | null): MarkedElement | null {
  if (el === null) return null;
  const rect = el.getBoundingClientRect();
  return {
    selector: selectorFor(el),
    tag: el.tagName.toLowerCase(),
    text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 200),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  };
}

function selectorFor(el: Element): string {
  if (el.id !== '') return `#${el.id}`;
  const testId = el.getAttribute('data-testid');
  if (testId !== null) return `[data-testid="${testId}"]`;

  const parts: string[] = [];
  let node: Element | null = el;
  for (let depth = 0; node !== null && depth < 5 && node.tagName !== 'BODY'; depth += 1) {
    const classes = [...node.classList].filter((c) => !c.startsWith('css-')).slice(0, 2);
    parts.unshift(node.tagName.toLowerCase() + classes.map((c) => `.${c}`).join(''));
    node = node.parentElement;
  }
  return parts.join(' > ');
}
