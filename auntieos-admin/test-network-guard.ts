// #1138: NO UNIT TEST MAY REACH THE NETWORK.
//
// Production request logs for 2026-10-02 showed about 400 unauthenticated
// callable requests with user agent `node`, from a developer Mac and from
// GitHub-hosted runners: getInvoiceLedger, getAccountCreditHistory,
// listUnappliedPayments, getBreeds and others. They were these suites. A spec
// that renders a component without mocking every callable it fires lets
// `httpsCallable` build the real `https://us-central1-...cloudfunctions.net`
// URL and post to it. Production refuses the call (no auth), the component
// swallows the error, the spec stays green, and the traffic is invisible
// everywhere except the production logs. Unmocked Firestore reads went the
// same way, to firestore.googleapis.com over gRPC.
//
// So this guard makes the request itself the failure. Every route out of the
// worker is covered, at three depths:
//
//   `fetch`              what `httpsCallable` and Firebase Auth use. Names the
//                        method and the URL, so the callable is in the message.
//   `XMLHttpRequest`     jsdom's, for anything written for a browser (Firestore's
//                        browser build talks WebChannel over it).
//   `net` sockets        the floor under both, and under anything else: Node's
//                        `http`/`https`, and gRPC, which is how Firestore's Node
//                        build (the one vitest resolves, jsdom or not) talks.
//                        Names host:port, with the hostname recovered from the
//                        DNS lookup that preceded it.
//
// Loopback stays allowed (127.0.0.1, ::1, localhost): emulators and in-process
// servers are local by construction and are not what #1138 is about.
//
// A blocked request is ALSO recorded, and the test fails in `afterEach` naming
// it, because throwing at the call site is not enough on its own. The code
// under test usually catches the rejection (that is exactly how the leak stayed
// green), so a throw alone would be swallowed the same way the production 401
// was. Anything recorded after a file's last test fails the file in `afterAll`.
//
// Mirrored at auntieos-admin/test-network-guard.ts and mytribe/web/test-network-guard.ts
// (identical), and in Node-only form at mytribe/functions/test/_helpers/networkGuard.ts.
// Keep them in step. src/testNetworkGuard.test.ts pins that each route is caught.

import dns from 'node:dns';
import net from 'node:net';
import { afterAll, afterEach, expect } from 'vitest';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', '::']);

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return LOOPBACK.has(h) || h.endsWith('.localhost') || h.startsWith('127.') || h.startsWith('::ffff:127.');
}

function describeUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && 'url' in input) return String((input as { url: unknown }).url);
  return String(input);
}

/** True when `url` leaves the machine. Relative URLs resolve against jsdom's localhost origin. */
function leavesMachine(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url, typeof location !== 'undefined' ? location.href : 'http://localhost/');
  } catch {
    return false;
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
    return false; // data:, blob:, file: never touch the network.
  }
  return !isLoopbackHost(parsed.hostname);
}

type GuardState = { violations: string[]; hostByAddress: Map<string, string> };
const STATE_KEY = Symbol.for('tribetails.networkGuard.state');
const PATCHED_KEY = Symbol.for('tribetails.networkGuard.nodePatched');
const globals = globalThis as unknown as Record<symbol, unknown>;
globals[STATE_KEY] = { violations: [], hostByAddress: new Map() } satisfies GuardState;
const currentState = (): GuardState => globals[STATE_KEY] as GuardState;

const HOW_TO_FIX =
  `Tests must never leave the machine (#1138). This is almost always a callable or Firestore read ` +
  `the spec did not mock, and without this guard it goes to PRODUCTION. Mock it the way the file ` +
  `already mocks its other calls (vi.mock of the api module that wraps the callable or the read), ` +
  `and assert on the mock instead.`;

const SOCKET_HINT =
  `A socket to *.googleapis.com is Firestore's gRPC channel: an unmocked getDoc/getDocs/onSnapshot ` +
  `(often an api module or hook the spec renders without meaning to). Firestore retries with backoff, ` +
  `so LATER tests in the same file can fail with the same line; fix the first. ` +
  `\`setLogLevel('debug')\` from firebase/firestore prints the query it was sending.`;

function block(what: string): Error {
  let test = '(outside a test)';
  try {
    test = expect.getState().currentTestName ?? test;
  } catch {
    // No runner state outside a test body.
  }
  currentState().violations.push(`${what}  [during: ${test}]`);
  return new Error(`A unit test tried to reach the network: ${what}\n${HOW_TO_FIX}`);
}

// --- fetch -------------------------------------------------------------------
if (typeof globalThis.fetch === 'function') {
  const realFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input: RequestInfo | URL, init?: RequestInit) {
    const url = describeUrl(input);
    if (leavesMachine(url)) {
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      return Promise.reject(block(`${method} ${url} (fetch)`));
    }
    return realFetch(input, init);
  } as typeof fetch;
}

// --- XMLHttpRequest (jsdom) --------------------------------------------------
if (typeof XMLHttpRequest !== 'undefined') {
  const proto = XMLHttpRequest.prototype;
  const realOpen = proto.open;
  const realSend = proto.send;
  const TARGET = Symbol('networkGuard.target');
  proto.open = function guardedOpen(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    (this as unknown as Record<symbol, [string, string]>)[TARGET] = [String(method).toUpperCase(), describeUrl(url)];
    return (realOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof proto.open;
  proto.send = function guardedSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const target = (this as unknown as Record<symbol, [string, string] | undefined>)[TARGET];
    if (target && leavesMachine(target[1])) {
      throw block(`${target[0]} ${target[1]} (XMLHttpRequest)`);
    }
    return realSend.call(this, body);
  };
}

// --- Node: DNS (for naming) and raw sockets (the floor under everything) -----
// Patched once per process. The patched functions read the CURRENT file's
// state through the global slot, so a worker that runs several files never
// reports one file's request against another.
if (!globals[PATCHED_KEY]) {
  globals[PATCHED_KEY] = true;

  // Remember which hostname each address came from, so a socket to a bare IP
  // can be reported as the service it is. Nothing is blocked here.
  const realLookup = dns.lookup;
  dns.lookup = function guardedLookup(hostname: string, ...rest: unknown[]) {
    const cb = rest.pop() as (err: unknown, address: unknown, family?: number) => void;
    return (realLookup as (...a: unknown[]) => void).call(dns, hostname, ...rest, (err: unknown, address: unknown, family?: number) => {
      if (!err) {
        const list = Array.isArray(address) ? address : [{ address }];
        for (const a of list as Array<{ address: unknown }>) {
          if (typeof a.address === 'string') currentState().hostByAddress.set(a.address, hostname);
        }
      }
      cb(err, address, family);
    });
  } as typeof dns.lookup;

  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
    // `net.connect`/`tls.connect` hand the method their already-normalized
    // arguments as ONE array, `[options, callback]`; direct callers pass them
    // spread. Both shapes, or `https.get` walks straight past this check.
    const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
    let host: string | undefined;
    let port: unknown;
    if (first && typeof first === 'object') {
      const opts = first as { host?: string; port?: unknown; path?: string | null };
      // `https` passes `path: null` for a TCP connection; only a string is a
      // Unix socket.
      if (typeof opts.path !== 'string') {
        host = opts.host ?? 'localhost';
        port = opts.port;
      }
    } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
      port = first;
      host = typeof args[1] === 'string' ? args[1] : 'localhost';
    }
    // A string first argument that is not a port is a Unix socket path: local.
    if (host !== undefined && !isLoopbackHost(host)) {
      const name = currentState().hostByAddress.get(host);
      const shown = name ? `${name} (${host})` : host;
      const err = block(`connect ${shown}:${String(port)} (socket)\n${SOCKET_HINT}`);
      process.nextTick(() => this.destroy(err));
      return this;
    }
    return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
}

function takeViolations(): string[] {
  return currentState().violations.splice(0);
}

afterEach(() => {
  const seen = takeViolations();
  if (seen.length > 0) {
    throw new Error(`A unit test tried to reach the network:\n  ${seen.join('\n  ')}\n${HOW_TO_FIX}`);
  }
});

afterAll(() => {
  const seen = takeViolations();
  if (seen.length > 0) {
    throw new Error(`A unit test tried to reach the network after the file's last test:\n  ${seen.join('\n  ')}\n${HOW_TO_FIX}`);
  }
});
